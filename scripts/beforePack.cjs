// ============================================================================
// beforePack hook - Pre-packaging validation
//
// Runs before electron-builder packages the app.
// Validates product.json and bundled resources to catch issues early.
//
// To add a new validation check:
//   1. Write a function: function checkXxx(productConfig) { ... }
//   2. Add it to the CHECKS array below
// ============================================================================

const fs = require('fs');
const path = require('path');

// ============================================================================
// Validation checks
// ============================================================================

/**
 * Validate updateConfig exists and is properly configured.
 *
 * Why: Without updateConfig, the download button in the update notification
 * silently does nothing (getDownloadPageUrl returns empty string).
 * See: src/main/services/updater/
 */
function checkUpdateConfig(config) {
  if (!config.updateConfig) {
    return 'Missing "updateConfig" - update download button will not work';
  }

  const { provider, owner, repo, url } = config.updateConfig;
  if (provider === 'disabled') return null;

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

/**
 * Validate the bundled CJK font and its license are present.
 *
 * Why: runtimes/office/build.mjs only warns when the download fails so
 * contributors are not blocked; a release must not ship without the font,
 * and the OFL requires the license to travel with it.
 */
function checkOfficeFonts() {
  const dir = path.join(__dirname, '..', 'resources', 'office-runtime', 'fonts');
  for (const file of ['NotoSansSC-Regular.otf', 'OFL-NotoSansSC.txt']) {
    if (!fs.existsSync(path.join(dir, file))) {
      return `Missing resources/office-runtime/fonts/${file} - run "npm run runtime:office" with network access`;
    }
  }
  return null;
}

// ============================================================================
// Check registry - add new checks here
// ============================================================================

const CHECKS = [
  checkUpdateConfig,
  checkAuthProviders,
  checkOfficeFonts,
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
};
