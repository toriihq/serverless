'use strict';

const memoize = require('memoizee');
const ServerlessError = require('../../serverless-error');
const createV3RequestHandler = require('./http-handler');

const S3 = require('@aws-sdk/client-s3');
const STS = require('@aws-sdk/client-sts');
const ECR = require('@aws-sdk/client-ecr');
const CloudFormationNS = require('@aws-sdk/client-cloudformation');
const CloudWatch = require('@aws-sdk/client-cloudwatch');
const CloudWatchLogs = require('@aws-sdk/client-cloudwatch-logs');
const LambdaNS = require('@aws-sdk/client-lambda');
const IAM = require('@aws-sdk/client-iam');
const APIGatewayNS = require('@aws-sdk/client-api-gateway');
const ApiGatewayV2NS = require('@aws-sdk/client-apigatewayv2');
const IoTNS = require('@aws-sdk/client-iot');

const nsByService = {
  S3,
  STS,
  ECR,
  CloudFormation: CloudFormationNS,
  CloudWatch,
  CloudWatchLogs,
  Lambda: LambdaNS,
  IAM,
  APIGateway: APIGatewayNS,
  ApiGatewayV2: ApiGatewayV2NS,
  IoT: IoTNS,
};

const canonicalizeServiceName = (name) => {
  return name === 'Iot' ? 'IoT' : name;
};
const getNamespaceForService = (name) => nsByService[canonicalizeServiceName(name)];
const pascalCase = (s) =>
  s.replace(/(^|_|-|\.|\/)\w/g, (m) => m.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());

const requestHandler = createV3RequestHandler();

const createV3ClientFactory = () => {
  const getV3Client = memoize(
    // eslint-disable-next-line no-unused-vars
    (service, _method) => {
      const params = service.params || {};
      const credentials = params.accessKeyId
        ? {
            accessKeyId: params.accessKeyId,
            secretAccessKey: params.secretAccessKey,
            sessionToken: params.sessionToken,
          }
        : undefined;

      const common = {
        region: params.region,
        credentials,
        requestHandler,
      };

      const canonical = canonicalizeServiceName(service.name);
      const ns = getNamespaceForService(service.name);
      if (!ns) {
        throw new ServerlessError(
          `Unsupported AWS service for v3 request path: ${service.name}`,
          'AWS_V3_UNSUPPORTED_SERVICE'
        );
      }

      const clientName = `${canonical}Client`;
      const ClientCtor = ns[clientName];
      if (!ClientCtor) {
        throw new ServerlessError(
          `Cannot resolve v3 client constructor: ${clientName}`,
          'AWS_V3_CLIENT_NOT_FOUND'
        );
      }

      if (canonical === 'S3') {
        return new ClientCtor({
          ...common,
          useAccelerateEndpoint: Boolean(params.isS3TransferAccelerationEnabled),
          followRegionRedirects: true,
        });
      }

      return new ClientCtor(common);
    },
    {
      normalizer: ([service, method]) =>
        `${service.name}:${JSON.stringify(service.params)}:${method}`,
    }
  );

  return { getV3Client };
};

module.exports = {
  createV3ClientFactory,
  canonicalizeServiceName,
  getNamespaceForService,
  pascalCase,
};
