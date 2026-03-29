'use strict';

// Phase 3: route all provider.request() calls through the AWS SDK v3 path.
// The v2 implementation (sdk-v2 / aws-sdk) is no longer used here.
module.exports = require('./v3/request');
