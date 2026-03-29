'use strict';

// eslint-disable-next-line import/no-extraneous-dependencies
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const fs = require('fs');

const createV3RequestHandler = () => {
  const proxyUrl =
    process.env.proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy;

  const ca = process.env.ca || process.env.HTTPS_CA || process.env.https_ca;
  let caCerts = [];
  if (ca) {
    caCerts = caCerts.concat(ca.split(',').map((cert) => cert.replace(/\\n/g, '\n')));
  }
  const cafile = process.env.cafile || process.env.HTTPS_CAFILE || process.env.https_cafile;
  if (cafile) {
    caCerts = caCerts.concat(
      cafile.split(',').map((cafilePath) => fs.readFileSync(cafilePath.trim()))
    );
  }

  const tlsOptions = {};
  if (caCerts.length > 0) Object.assign(tlsOptions, { rejectUnauthorized: true, ca: caCerts });

  let agent;
  if (proxyUrl) {
    agent = new HttpsProxyAgent(proxyUrl, tlsOptions);
  } else if (tlsOptions.ca) {
    agent = new https.Agent(tlsOptions);
  }

  const timeoutMs = (() => {
    const t = process.env.AWS_CLIENT_TIMEOUT || process.env.aws_client_timeout;
    return t ? parseInt(t, 10) : undefined;
  })();

  return new NodeHttpHandler({
    ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
    ...(timeoutMs ? { socketTimeout: timeoutMs, connectionTimeout: timeoutMs } : {}),
  });
};

module.exports = createV3RequestHandler;
