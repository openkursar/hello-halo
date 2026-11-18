import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const filters = process.argv.slice(2);
function run(command, args) {
  const result = spawnSync(command, args, { cwd: sdk, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
const generated = run(process.execPath, ['scripts/generate-native-text.mjs']);
if (generated) process.exit(generated);
const rust = filters.length ? 0 : run(process.env.CARGO || 'cargo', ['test', '--locked', '-p', 'halo-core', '--', '--test-threads=1']);
const node = run(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', ...filters]);
process.exitCode = rust || node;
