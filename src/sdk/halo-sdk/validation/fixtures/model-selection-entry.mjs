import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const distribution = resolve(process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../../dist', import.meta.url)));
const paths = {
  native: 'native/index.js',
  worker: 'worker/index.js',
  collaboration: 'native/collaboration.js',
  'collaboration/protocol': 'collaboration/protocol.js',
  'collaboration/sdk': 'native/collaboration-sdk.js',
};

export function entryUrl(name) {
  if (!Object.hasOwn(paths, name)) throw new Error(`Unknown public SDK entry: ${name}`);
  const manifest = join(distribution, 'package.json');
  if (existsSync(manifest)) {
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    const target = metadata.exports?.[`./${name}`]?.import;
    if (typeof target !== 'string' || !target.startsWith('./')) throw new Error(`Missing public SDK export: ${name}`);
    return pathToFileURL(resolve(distribution, target)).href;
  }
  return pathToFileURL(join(distribution, paths[name])).href;
}

export const entry = name => import(entryUrl(name));
