'use strict';

const sinon = require('sinon');
const chai = require('chai');
const proxyquire = require('proxyquire');
const overrideEnv = require('process-utils/override-env');
const { S3Client } = require('@aws-sdk/client-s3');
const { CloudFormationClient } = require('@aws-sdk/client-cloudformation');

const expect = chai.expect;

chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));

// Helper: build a v3-style error
const makeV3Error = (opts) => {
  const err = Object.assign(new Error(opts.message || 'Error'), opts);
  return err;
};

describe('#request', () => {
  describe('Credentials support', () => {
    // Ensure we control the process env variable so that no credentials
    // are available by default
    let rEnv;
    let sendStub;
    beforeEach(() => {
      const { restoreEnv } = overrideEnv();
      rEnv = restoreEnv;
      sendStub = sinon.stub(S3Client.prototype, 'send').rejects(
        makeV3Error({
          name: 'CredentialsProviderError',
          message: 'Could not load credentials from any providers',
        })
      );
    });

    afterEach(() => {
      rEnv();
      sendStub.restore();
    });

    it('should produce a meaningful error when no supported credentials are provided', async () => {
      const awsRequest = require('../../../../lib/aws/request');
      return expect(
        awsRequest({ name: 'S3', params: { region: 'us-east-1' } }, 'putObject', {
          Bucket: 'test-bucket',
          Key: 'test-key',
        })
      ).to.be.eventually.rejected.and.have.property('code', 'AWS_CREDENTIALS_NOT_FOUND');
    });

    it('should support passing params without credentials', async () => {
      const awsRequest = require('../../../../lib/aws/request');
      return expect(
        awsRequest(
          { name: 'S3', params: { region: 'us-east-1', isS3TransferAccelerationEnabled: true } },
          'putObject',
          { Bucket: 'test-bucket', Key: 'test-key' }
        )
      ).to.be.rejectedWith('AWS provider credentials not found.');
    });
  });

  it('should invoke expected AWS SDK methods', async () => {
    const sendStub = sinon.stub(S3Client.prototype, 'send').resolves({ called: true });
    try {
      const awsRequest = require('../../../../lib/aws/request');
      const res = await awsRequest(
        {
          name: 'S3',
          params: { region: 'us-east-1', accessKeyId: 'key', secretAccessKey: 'secret' },
        },
        'putObject'
      );
      expect(res.called).to.equal(true);
    } finally {
      sendStub.restore();
    }
  });

  it('should support string for service argument', async () => {
    const sendStub = sinon.stub(S3Client.prototype, 'send').resolves({ called: true });
    try {
      const awsRequest = require('../../../../lib/aws/request');
      const res = await awsRequest('S3', 'putObject', {});
      expect(res.called).to.equal(true);
    } finally {
      sendStub.restore();
    }
  });

  it('should request to the specified region if region in options set', async () => {
    const OrigCF = CloudFormationClient;
    const CFStub = function (config) {
      return new OrigCF(config);
    };
    const sendStub = sinon
      .stub(CloudFormationClient.prototype, 'send')
      .resolves({ region: 'ap-northeast-1' });
    try {
      const awsRequest = proxyquire('../../../../lib/aws/v3/request', {
        './client-factory': proxyquire('../../../../lib/aws/v3/client-factory', {
          '@aws-sdk/client-cloudformation': {
            CloudFormationClient: CFStub,
            DescribeStacksCommand: require('@aws-sdk/client-cloudformation').DescribeStacksCommand,
          },
        }),
      });
      const res = await awsRequest(
        {
          name: 'CloudFormation',
          params: { region: 'ap-northeast-1', accessKeyId: 'k', secretAccessKey: 's' },
        },
        'describeStacks',
        { StackName: 'foo' }
      );
      expect(res.region).to.equal('ap-northeast-1');
    } finally {
      sendStub.restore();
    }
  });

  describe('Retries', () => {
    it('should retry on retryable errors (429)', async () => {
      const err429 = makeV3Error({
        name: 'TooManyRequestsException',
        message: 'Testing retry',
        $metadata: { httpStatusCode: 429 },
        $retryable: { throttling: true },
      });
      const sendStub = sinon.stub(S3Client.prototype, 'send');
      sendStub.onCall(0).rejects(err429);
      sendStub.onCall(1).resolves({ data: {} });
      const awsRequest = proxyquire('../../../../lib/aws/v3/request', {
        'timers-ext/promise/sleep': async () => {},
      });
      try {
        const res = await awsRequest(
          { name: 'S3', params: { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } },
          'putObject'
        );
        expect(sendStub).to.have.been.calledTwice;
        expect(res).to.exist;
      } finally {
        sendStub.restore();
      }
    });

    it('should retry if status code is 429 regardless of retryable flag', async () => {
      const err429 = makeV3Error({
        message: 'Testing retry',
        $metadata: { httpStatusCode: 429 },
      });
      const sendStub = sinon.stub(S3Client.prototype, 'send');
      sendStub.onCall(0).rejects(err429);
      sendStub.onCall(1).resolves({});
      const awsRequest = proxyquire('../../../../lib/aws/v3/request', {
        'timers-ext/promise/sleep': async () => {},
      });
      try {
        const res = await awsRequest(
          { name: 'S3', params: { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } },
          'putObject'
        );
        expect(res).to.exist;
        expect(sendStub).to.have.been.calledTwice;
      } finally {
        sendStub.restore();
      }
    });

    it('should retry throttling errors identified by name (HTTP 400, no $retryable)', async () => {
      // Regression: Query-protocol services (e.g. CloudFormation) return "Rate exceeded"
      // as a ThrottlingException with HTTP 400 and no $retryable flag. Retryability must be
      // determined by error name, not just status code / $retryable.
      const throttleErr = makeV3Error({
        name: 'ThrottlingException',
        message: 'Rate exceeded',
        $metadata: { httpStatusCode: 400 },
      });
      const sendStub = sinon.stub(S3Client.prototype, 'send');
      sendStub.onCall(0).rejects(throttleErr);
      sendStub.onCall(1).resolves({ data: {} });
      const awsRequest = proxyquire('../../../../lib/aws/v3/request', {
        'timers-ext/promise/sleep': async () => {},
      });
      try {
        const res = await awsRequest(
          { name: 'S3', params: { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } },
          'putObject'
        );
        expect(sendStub).to.have.been.calledTwice;
        expect(res).to.exist;
      } finally {
        sendStub.restore();
      }
    });

    it('should expose non-retryable errors', async () => {
      const err = makeV3Error({
        name: 'SomeError',
        message: 'Some error message',
        $metadata: { httpStatusCode: 400 },
      });
      const sendStub = sinon.stub(S3Client.prototype, 'send').rejects(err);
      const awsRequest = require('../../../../lib/aws/v3/request');
      try {
        await expect(
          awsRequest(
            { name: 'S3', params: { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } },
            'putObject'
          )
        ).to.eventually.be.rejected.and.have.property('code', 'AWS_S3_PUT_OBJECT_SOME_ERROR');
      } finally {
        sendStub.restore();
      }
    });

    it('should handle numeric-like error names', async () => {
      const err = makeV3Error({
        name: '500',
        message: 'Some error message',
        $metadata: { httpStatusCode: 500 },
      });
      const sendStub = sinon.stub(S3Client.prototype, 'send').rejects(err);
      const awsRequest = require('../../../../lib/aws/v3/request');
      try {
        await expect(
          awsRequest(
            { name: 'S3', params: { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } },
            'putObject'
          )
        ).to.eventually.be.rejected.and.have.property('code', 'AWS_S3_PUT_OBJECT_500');
      } finally {
        sendStub.restore();
      }
    });
  });

  it('should expose original error message in thrown error message', async () => {
    const err = makeV3Error({
      name: 'Forbidden',
      message: 'Something went wrong...',
      $metadata: { httpStatusCode: 403 },
    });
    const sendStub = sinon.stub(S3Client.prototype, 'send').rejects(err);
    const awsRequest = require('../../../../lib/aws/v3/request');
    try {
      await expect(
        awsRequest(
          { name: 'S3', params: { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } },
          'putObject'
        )
      ).to.be.rejectedWith('Something went wrong...');
    } finally {
      sendStub.restore();
    }
  });

  it('should default to error code if error message is non-existent', async () => {
    const err = makeV3Error({
      name: 'Forbidden',
      message: null,
      $metadata: { httpStatusCode: 403 },
    });
    const sendStub = sinon.stub(S3Client.prototype, 'send').rejects(err);
    const awsRequest = require('../../../../lib/aws/v3/request');
    try {
      await expect(
        awsRequest(
          { name: 'S3', params: { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } },
          'putObject'
        )
      ).to.be.rejectedWith('Forbidden');
    } finally {
      sendStub.restore();
    }
  });

  it('should enable S3 acceleration if isS3TransferAccelerationEnabled is provided', async () => {
    const OrigS3 = S3Client;
    const S3Spy = function (config) {
      const instance = new OrigS3(config);
      instance.send = async () => ({ accelerated: config.useAccelerateEndpoint });
      return instance;
    };
    const awsRequest = proxyquire('../../../../lib/aws/v3/request', {
      './client-factory': proxyquire('../../../../lib/aws/v3/client-factory', {
        '@aws-sdk/client-s3': {
          S3Client: S3Spy,
          PutObjectCommand: require('@aws-sdk/client-s3').PutObjectCommand,
          GetObjectCommand: require('@aws-sdk/client-s3').GetObjectCommand,
        },
      }),
    });
    const res = await awsRequest(
      {
        name: 'S3',
        params: {
          region: 'us-east-1',
          accessKeyId: 'k',
          secretAccessKey: 's',
          isS3TransferAccelerationEnabled: true,
        },
      },
      'putObject',
      {}
    );
    return expect(res.accelerated).to.be.true;
  });

  describe('Caching through memoize', () => {
    it('should reuse the result if arguments are the same', async () => {
      const sendStub = sinon
        .stub(CloudFormationClient.prototype, 'send')
        .resolves({ called: true });
      const awsRequest = require('../../../../lib/aws/v3/request');
      try {
        const numTests = 10;
        const params = { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' };
        const executeRequest = () =>
          awsRequest.memoized({ name: 'CloudFormation', params }, 'describeStacks', {});
        const requests = [];
        for (let n = 0; n < numTests; n++) {
          requests.push(executeRequest());
        }
        const results = await Promise.all(requests);
        expect(results.length).to.equal(numTests);
        results.forEach((result) => {
          expect(result).to.deep.equal({ called: true });
        });
        expect(sendStub).to.have.been.calledOnce;
      } finally {
        sendStub.restore();
        awsRequest.memoized.clear();
      }
    });

    it('should not reuse the result if the region changes', async () => {
      const sendStub = sinon
        .stub(CloudFormationClient.prototype, 'send')
        .resolves({ called: true });
      const awsRequest = require('../../../../lib/aws/v3/request');
      try {
        const makeRequest = (region) =>
          awsRequest(
            { name: 'CloudFormation', params: { region, accessKeyId: 'k', secretAccessKey: 's' } },
            'describeStacks',
            { StackName: 'same-stack' }
          );
        const results = await Promise.all([
          makeRequest('us-east-1'),
          makeRequest('ap-northeast-1'),
        ]);
        expect(results.length).to.equal(2);
        expect(sendStub.callCount).to.equal(2);
      } finally {
        sendStub.restore();
      }
    });
  });
});
