/**
 * Office runtime service — bundled pure-JS office libraries + halo-node shim.
 * applyOfficeRuntimeEnv is the sole integration point agent/sdk-config uses;
 * the rest supports diagnostics, tests, and the startup self-check.
 */

export {
  applyOfficeRuntimeEnv,
  verifyOfficeRuntime,
  getOfficeModulesDir,
  getOfficeFontsDir,
  ensureOfficeRuntimeShim,
} from './runtime'
