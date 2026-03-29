'use strict';

const memoize = require('memoizee');
const PromiseQueue = require('promise-queue');
const ServerlessError = require('../../serverless-error');
const { log } = require('@serverless/utils/log');
const deepSortObjectByKey = require('../../utils/deep-sort-object-by-key');
const ensureString = require('type/string/ensure');
const isObject = require('type/object/is');
const wait = require('timers-ext/promise/sleep');
const { Upload } = require('@aws-sdk/lib-storage');
const {
  createV3ClientFactory,
  canonicalizeServiceName,
  getNamespaceForService,
  pascalCase,
} = require('./client-factory');
const { handleV3Error } = require('./error-utils');

const awsLog = log.get('aws');

PromiseQueue.configure(Promise);
const requestQueue = new PromiseQueue(2, Infinity);

const MAX_RETRIES = (() => {
  const userValue = Number(process.env.SLS_AWS_REQUEST_MAX_RETRIES);
  return Number.isInteger(userValue) && userValue >= 0 ? userValue : 4;
})();

const { getV3Client } = createV3ClientFactory();

let requestCounter = 0;

async function execute(service, method, params) {
  const client = getV3Client(service, method);
  const canonical = canonicalizeServiceName(service.name);

  if (canonical === 'S3' && method === 'upload') {
    const uploader = new Upload({ client, params: params[0] });
    return uploader.done();
  }

  const ns = getNamespaceForService(service.name);
  if (!ns) {
    throw new ServerlessError(
      `Unsupported AWS service for v3 request path: ${service.name}`,
      'AWS_V3_UNSUPPORTED_SERVICE'
    );
  }

  const commandName = `${pascalCase(method)}Command`;
  const Cmd = ns[commandName];
  if (!Cmd) {
    throw new ServerlessError(
      `Cannot resolve v3 command constructor: ${canonical}.${commandName}`,
      'AWS_V3_COMMAND_NOT_FOUND'
    );
  }

  return client.send(new Cmd(...params));
}

async function awsRequest(service, method, ...args) {
  if (isObject(service)) {
    ensureString(service.name, { name: 'service.name' });
  } else {
    ensureString(service, { name: 'service' });
    service = { name: service };
  }

  const requestId = ++requestCounter;
  awsLog.debug(`request: #${requestId} ${service.name}.${method} [v3]`, args);

  let numTry = 0;

  const request = await requestQueue.add(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      numTry += 1;
      try {
        const result = await execute(service, method, args);
        awsLog.debug(`request result: #${requestId} ${service.name}.${method} [v3]`, result);
        return result;
      } catch (err) {
        const httpStatus = err && err.$metadata && err.$metadata.httpStatusCode;
        const providerError = {
          retryable: Boolean(err && err.$retryable) || httpStatus === 429 || httpStatus >= 500,
          code: (err && err.name) || (err && err.code),
        };

        if (providerError.retryable && numTry < MAX_RETRIES) {
          const nextTryNum = numTry + 1;
          const jitter = Math.random() * 3000;
          await wait(Math.min(Math.pow(2, numTry) * 1000 + jitter, 60000));
          awsLog.debug(
            `Retry #${requestId} ${service.name}.${method} - Try ${nextTryNum} of ${MAX_RETRIES}`
          );
          continue;
        }

        handleV3Error(err, { serviceName: service.name, method, requestId, awsLog, log });
      }
    }
  });

  return request;
}

awsRequest.memoized = memoize(awsRequest, {
  promise: true,
  normalizer: (args) => {
    args[1] = deepSortObjectByKey(args[1]);
    return JSON.stringify(args);
  },
});

module.exports = awsRequest;
