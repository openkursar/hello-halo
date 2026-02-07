// ============================================================================
// beforePack hook - Pre-packaging validation & native module preparation
//
// Runs before electron-builder packages the app. Performs two jobs:
//   1. Validates product.json configuration
//   2. Prepares platform-specific native modules for cross-platform builds
//
// To add a new validation check:
//   1. Write a function: function checkXxx(productConfig) { ... }
//   2. Add it to the CHECKS array below
// ============================================================================

const fs = require('fs');
const path = require('path');
const nativeModules = require('./native-modules.cjs');

// ============================================================================
// Validation checks
// ============================================================================

/**
 * Validate updateConfig exists and is properly configured.
 *
 * Why: Without updateConfig, the download button in the update notification
 * silently does nothing (getDownloadPageUrl returns empty string).
 * See: src/main/services/updater.service.ts
 */
function checkUpdateConfig(config) {
  if (!config.updateConfig) {
    return 'Missing "updateConfig" - update download button will not work';
  }

  const { provider, owner, repo, url } = config.updateConfig;

  if (!provider) {
    return 'updateConfig.provider is required ("github" or "generic")';
  }

  if (provider === 'github') {
    if (!owner || !repo) {
      return 'updateConfig requires "owner" and "repo" for github provider';
    }
  }

  if (provider === 'generic' && url === undefined) {
    return 'updateConfig requires "url" for generic provider (empty string to disable)';
  }

  return null;
}

/**
 * Validate authProviders exists and has at least one enabled provider.
 */
function checkAuthProviders(config) {
  if (!config.authProviders || !Array.isArray(config.authProviders)) {
    return 'Missing "authProviders" array';
  }

  const enabled = config.authProviders.filter(p => p.enabled);
  if (enabled.length === 0) {
    return 'No enabled auth providers found - users will not be able to log in';
  }

  return null;
}

// ============================================================================
// Check registry - add new checks here
// ============================================================================

const CHECKS = [
  checkUpdateConfig,
  checkAuthProviders,
];

// ============================================================================
// Hook entry point
// ============================================================================

module.exports = async function(context) {
  console.log('[beforePack] Validating product.json...');

  const productJsonPath = path.join(__dirname, '..', 'product.json');

  if (!fs.existsSync(productJsonPath)) {
    throw new Error('[beforePack] product.json not found at: ' + productJsonPath);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(productJsonPath, 'utf-8'));
  } catch (e) {
    throw new Error('[beforePack] Failed to parse product.json: ' + e.message);
  }

  const errors = [];

  for (const check of CHECKS) {
    const error = check(config);
    if (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    const message = [
      '[beforePack] product.json validation failed:',
      '',
      ...errors.map((e, i) => `  ${i + 1}. ${e}`),
      '',
      'Fix product.json before packaging.',
    ].join('\n');

    throw new Error(message);
  }

  console.log(`[beforePack] product.json OK (${CHECKS.length} checks passed)`);

  // ===========================================================================
  // Native module preparation
  // ===========================================================================
  const projectRoot = path.join(__dirname, '..');
  nativeModules.prepare(projectRoot, context.electronPlatformName, context.arch);
};
