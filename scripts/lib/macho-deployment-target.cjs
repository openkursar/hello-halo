const fs = require('node:fs');
const path = require('node:path');

const MACOS_BASELINE = '12.0.0';
const FORMATS = {
  cefaedfe: { little: true, header: 28 },
  cffaedfe: { little: true, header: 32 },
  feedface: { little: false, header: 28 },
  feedfacf: { little: false, header: 32 },
  cafebabe: { little: false, fat: 20 },
  bebafeca: { little: true, fat: 20 },
  cafebabf: { little: false, fat: 32 },
  bfbafeca: { little: true, fat: 32 },
};

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function decodeVersion(value) {
  return `${value >>> 16}.${(value >>> 8) & 255}.${value & 255}`;
}

function inspectMachO(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const read = (offset, size, limit = fileSize) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > limit) {
        throw new Error(`Truncated Mach-O data: ${file}`);
      }
      const buffer = Buffer.alloc(size);
      if (fs.readSync(fd, buffer, 0, size, offset) !== size) throw new Error(`Truncated Mach-O data: ${file}`);
      return buffer;
    };
    if (fileSize < 4) return { isMachO: false, slices: [] };
    const magic = read(0, 4).toString('hex');
    const format = FORMATS[magic];
    if (!format) return { isMachO: false, slices: [] };
    const uint = (buffer, offset, little) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const thin = (offset, size, expectedCpu) => {
      const limit = offset + size;
      const layout = FORMATS[read(offset, 4, limit).toString('hex')];
      if (!layout?.header) throw new Error(`Invalid Mach-O architecture slice: ${file}`);
      const header = read(offset, layout.header, limit);
      const cpu = uint(header, 4, layout.little);
      if (expectedCpu !== undefined && cpu !== expectedCpu) throw new Error(`Mach-O architecture table mismatch: ${file}`);
      const count = uint(header, 16, layout.little);
      const commandBytes = uint(header, 20, layout.little);
      if (count > 1024 || commandBytes > 512 * 1024) throw new Error(`Invalid Mach-O load commands: ${file}`);
      const commands = read(offset + layout.header, commandBytes, limit);
      let position = 0;
      let minimumMacOS;
      let platform;
      for (let index = 0; index < count; index++) {
        if (position + 8 > commands.length) throw new Error(`Truncated Mach-O load command: ${file}`);
        const command = uint(commands, position, layout.little);
        const length = uint(commands, position + 4, layout.little);
        if (length < 8 || position + length > commands.length) throw new Error(`Truncated Mach-O load command: ${file}`);
        if (command === 0x32 || command === 0x24) {
          const required = command === 0x32 ? 24 : 16;
          if (length < required) throw new Error(`Truncated Mach-O deployment command: ${file}`);
          const currentPlatform = command === 0x32 ? uint(commands, position + 8, layout.little) : 1;
          const version = decodeVersion(uint(commands, position + (command === 0x32 ? 12 : 8), layout.little));
          if (platform !== undefined && platform !== currentPlatform) throw new Error(`Conflicting Mach-O platforms: ${file}`);
          platform = currentPlatform;
          if (!minimumMacOS || compareVersions(version, minimumMacOS) > 0) minimumMacOS = version;
        }
        position += length;
      }
      if (position !== commandBytes) throw new Error(`Invalid Mach-O command size: ${file}`);
      const architecture = cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : `cpu-${cpu.toString(16)}`;
      return { architecture, platform, minimumMacOS };
    };
    if (format.header) return { isMachO: true, slices: [thin(0, fileSize)] };
    const count = uint(read(0, 8), 4, format.little);
    if (count < 1 || count > 64) throw new Error(`Invalid Mach-O universal header: ${file}`);
    const table = read(8, count * format.fat);
    const slices = [];
    const wide = (buffer, offset) => Number(format.little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));
    for (let index = 0; index < count; index++) {
      const position = index * format.fat;
      const offset = format.fat === 32 ? wide(table, position + 8) : uint(table, position + 8, format.little);
      const size = format.fat === 32 ? wide(table, position + 16) : uint(table, position + 12, format.little);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 8 + table.length || size < 28 || offset + size > fileSize) {
        throw new Error(`Invalid Mach-O architecture bounds: ${file}`);
      }
      slices.push(thin(offset, size, uint(table, position, format.little)));
    }
    return { isMachO: true, slices };
  } finally {
    fs.closeSync(fd);
  }
}

function validateMacOSDeploymentTarget(file, baseline = MACOS_BASELINE) {
  const result = inspectMachO(file);
  if (!result.isMachO) return { ...result, valid: false, reason: 'not a Mach-O binary' };
  const invalid = result.slices.find(slice => slice.platform !== 1 || !slice.minimumMacOS || slice.minimumMacOS === '0.0.0' || compareVersions(slice.minimumMacOS, baseline) > 0);
  const minimumMacOS = result.slices.map(slice => slice.minimumMacOS).filter(Boolean).sort(compareVersions).at(-1);
  if (invalid) {
    const reason = invalid.platform !== 1 || !invalid.minimumMacOS || invalid.minimumMacOS === '0.0.0' ? `missing macOS deployment target (${invalid.architecture}, platform ${invalid.platform ?? 'missing'})`
      : `macOS deployment target ${invalid.minimumMacOS ?? 'missing'} exceeds baseline ${baseline} (${invalid.architecture})`;
    return { ...result, minimumMacOS, valid: false, reason };
  }
  return { ...result, minimumMacOS, valid: true };
}

function findMachOFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findMachOFiles(file));
    else if (entry.isFile() && !entry.name.endsWith('.class')) {
      const fd = fs.openSync(file, 'r');
      try {
        const magic = Buffer.alloc(4);
        if (fs.readSync(fd, magic, 0, 4, 0) === 4 && FORMATS[magic.toString('hex')]) files.push(file);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return files;
}

/**
 * `floors` maps absolute paths of separately launched helpers to their own
 * floor; a helper that needs a newer macOS limits its feature, not the app.
 */
function assertMacOSDeploymentTargets(directory, baseline = MACOS_BASELINE, floors = {}) {
  const files = findMachOFiles(directory);
  const declared = new Map(Object.entries(floors).map(([file, floor]) => [path.resolve(file), floor]));
  const unmatched = [...declared.keys()].filter(file => !files.includes(file));
  if (unmatched.length) throw new Error(`macOS deployment gate: declared floors match no binary:\n${unmatched.join('\n')}`);
  const binaries = files.map(file => ({ file, ...validateMacOSDeploymentTarget(file, declared.get(file) ?? baseline) }));
  const failures = binaries.filter(binary => !binary.valid);
  if (failures.length) throw new Error(`macOS deployment gate failed:\n${failures.map(binary => `${binary.file}: ${binary.reason}`).join('\n')}`);
  return binaries;
}

module.exports = { MACOS_BASELINE, compareVersions, inspectMachO, validateMacOSDeploymentTarget, findMachOFiles, assertMacOSDeploymentTargets };
