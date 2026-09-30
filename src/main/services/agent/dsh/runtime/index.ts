/**
 * Public surface of the dsh runtime-resolution module.
 *
 * Owns: where a runnable dsh runtime lives, what cordis composition it boots,
 * and how Halo's credentials reach it. Does NOT own the wire protocol or the
 * child's lifecycle — that is `../transport`.
 */

export { buildDshLaunchSpec, type DshLaunchOptions } from './launch-spec'
export {
  describeMinNodeVersion,
  resolveDshInterpreter,
  resolveDshRuntime,
  resolveDshShell,
  type ResolvedDshInterpreter,
  type ResolvedDshRuntime,
  type ResolvedDshShell,
} from './resolve'
export { materializeCordisConfig, type CordisComposition } from './cordis-config'
