import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [role, argument] = process.argv.slice(2);
const script = fileURLToPath(import.meta.url);
const deadline = Date.now() + 180_000;
const finished = () => existsSync('finish') || Date.now() >= deadline;
function mark(name, value = '1') {
  writeFileSync(`${name}.tmp`, String(value));
  renameSync(`${name}.tmp`, name);
}
async function waitFor(name) {
  while (!finished() && !existsSync(name)) await delay(25);
  return !finished();
}
function child(kind, index) {
  const proc = spawn(process.execPath, [script, kind, String(index)], { stdio: 'ignore', windowsHide: true });
  return new Promise(resolve => {
    proc.once('error', () => resolve(false));
    proc.once('exit', code => resolve(code === 0));
  });
}

try {
  if (role === 'neighbour') {
    mark('before');
    if (await waitFor('observe-stop')) mark('during');
    if (await waitFor('go')) mark('after');
  } else if (role === 'leaf' || role === 'step') {
    const n = Number(argument);
    if (!Number.isSafeInteger(n) || n < 0 || n > 511) throw Error();
    mark(`child-${n}.pid`, process.pid);
    if (role === 'step') await delay(180);
    else while (!finished()) await delay(50);
  } else if (role === 'native-tree' || role === 'churn') {
    mark('parent.pid', process.pid);
    for (let n = 0; n < 512 && !finished(); n++) {
      // Announce each launch before spawning: a stop between spawn and registration stays visible as unknown.
      mark(`launch-${n}`);
      const success = child(role === 'native-tree' ? 'leaf' : 'step', n);
      if (!await waitFor(`child-${n}.pid`)) break;
      if ((role === 'native-tree' && n === 0) || (role === 'churn' && n === 1)) mark('ready');
      const exited = await success;
      if (exited) mark(`exit-${n}`);
      if (role === 'native-tree' || !exited) break;
    }
  } else throw Error();
} catch { process.exitCode = 1; }
