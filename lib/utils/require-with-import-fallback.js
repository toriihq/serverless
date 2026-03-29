'use strict';

module.exports = async (modPath) => {
  try {
    const result = require(modPath);
    // Node 22+ supports require() of ESM modules and returns a namespace object
    // with __esModule: true instead of throwing ERR_REQUIRE_ESM.
    // Extract the default export for compatibility with the previous behavior.
    if (result && result.__esModule) {
      return result.default !== undefined ? result.default : result;
    }
    return result;
  } catch (error) {
    // Fallback to import() if the runtime supports native ESM
    if (error.code === 'ERR_REQUIRE_ESM') {
      return (await require('./import-esm')(modPath)).default;
    }
    throw error;
  }
};
