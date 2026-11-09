import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const exec = promisify(execFile);

export async function processTable() {
  if (process.platform === 'win32') return { supported: false, processes: [] };
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,lstart='], { maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
  const all = stdout.trim().split('\n').map(line => {
    const fields = line.trim().split(/\s+/);
    const [pid, parent, rssKiB] = fields.slice(0, 3).map(Number);
    return { pid, parent, rss: rssKiB * 1024, identity: fields.slice(3).join(' ') };
  });
  return { supported: true, processes: all };
}

export async function processTree(root) {
  const table = await processTable();
  const all = table.processes;
  const descendants = new Set([root]);
  let previous;
  do {
    previous = descendants.size;
    for (const item of all) if (descendants.has(item.parent)) descendants.add(item.pid);
  } while (previous !== descendants.size);
  return { supported: table.supported, processes: all.filter(item => descendants.has(item.pid)) };
}

export async function processIdentity(pid) {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000 });
    return stdout.trim().split(/\s+/).join(' ') || null;
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}

export async function descriptorCount(pid) {
  if (process.platform === 'linux') return (await fs.readdir(`/proc/${pid}/fd`)).length;
  if (process.platform === 'darwin') {
    const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Ff'], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return stdout.split('\n').filter(line => /^f\d/.test(line)).length;
  }
  return null;
}

export async function diskUsage(directory) {
  let bytes = 0;
  let files = 0;
  const visit = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (dir === directory && entry.name === 'fixtures')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        files++;
        if (files > 100_000) throw new Error('Validation sandbox exceeded 100,000 files');
        try { bytes += (await fs.stat(path)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  };
  await visit(directory);
  return { bytes, files };
}

export function evaluate(samples, osSamples, profile) {
  const baseline = samples.find(sample => sample.label === 'baseline');
  const final = samples.findLast(sample => sample.label === 'final');
  const osBaseline = osSamples.find(sample => sample.label === 'baseline');
  const osFinal = osSamples.find(sample => sample.label === 'final');
  const limits = { peakRssBytes: 768 * 1024 * 1024, retainedHeapGrowthBytes: 48 * 1024 * 1024,
    descriptorGrowth: 12, peakEventLoopDelayMs: 2000, sandboxBytes: 512 * 1024 * 1024 };
  const observed = {
    peakRssBytes: Math.max(0, ...samples.map(sample => sample.rss), ...osSamples.map(sample => sample.treeRss)),
    retainedHeapGrowthBytes: baseline && final ? final.heapUsed - baseline.heapUsed : null,
    peakEventLoopDelayMs: Math.max(0, ...samples.map(sample => sample.eventLoopMaxMs)),
    descriptorGrowth: osBaseline?.descriptors != null && osFinal?.descriptors != null
      ? osFinal.descriptors - osBaseline.descriptors : null,
    sandboxBytes: Math.max(0, ...osSamples.map(sample => sample.disk.bytes)),
  };
  const failures = Object.keys(limits).filter(key => observed[key] !== null && observed[key] > limits[key]);
  if (!baseline || !final) failures.push('missing-retained-memory-samples');
  if (profile === 'soak' && observed.descriptorGrowth === null) failures.push('unsupported-descriptor-measurement');
  if (profile === 'soak' && osSamples.length < 10) failures.push('insufficient-resource-samples');
  return { limits, observed, failures, unsupported: observed.descriptorGrowth === null ? ['descriptor-growth'] : [] };
}
