import type { Options } from '../types/config.js';
import { bindCodeSearchBridge, codeSearchBridge } from '../core/code-search.js';
import { inheritReadDenyFloor } from '../core/read-policy.js';

export function inheritOptionCapabilities<T extends Options>(target: T, source: Options): T {
  inheritReadDenyFloor(target, source);
  const search = codeSearchBridge(source);
  if (search) bindCodeSearchBridge(target, search);
  return target;
}
