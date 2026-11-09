import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const legalName = /^(?:licen[cs]es?|copying|notices?|copyright)(?:[._-].*)?$/i;
const licenseName = /^(?:licen[cs]es?|copying)(?:[._-].*)?$/i;

function isWithin(directory, path) {
  const child = relative(directory, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

async function packageForFile(file, cache) {
  let directory = dirname(await realpath(file));
  const visited = [];
  let owner;
  while (true) {
    if (cache.has(directory)) {
      owner = cache.get(directory);
      break;
    }
    visited.push(directory);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read package metadata for bundled input ${file}`, { cause: error });
    }
    if (typeof manifest?.name === 'string' && manifest.name) {
      owner = { directory, manifest };
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot identify the package owning bundled input ${file}`);
    directory = parent;
  }
  for (const visitedDirectory of visited) cache.set(visitedDirectory, owner);
  return owner;
}

async function legalDocuments(owner) {
  const { directory, manifest } = owner;
  const files = new Map();
  const directories = new Set();
  async function add(path, license) {
    const canonical = await realpath(path);
    if (!isWithin(directory, canonical)) {
      throw new Error(`License document escapes package ${manifest.name}: ${relative(directory, path)}`);
    }
    const entries = await readdir(canonical, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    if (entries) {
      if (directories.has(canonical)) return;
      directories.add(canonical);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        await add(join(canonical, entry.name), license);
      }
      return;
    }
    const text = await readFile(canonical, 'utf8');
    if (!text.trim()) throw new Error(`Empty legal document in ${manifest.name}: ${relative(directory, path)}`);
    const previous = files.get(canonical);
    files.set(canonical, { name: relative(directory, path).split(sep).join('/'), text, license: license || previous?.license });
  }

  for (const entry of (await readdir(directory)).sort()) {
    if (legalName.test(entry)) await add(join(directory, entry), licenseName.test(entry));
  }
  const declared = typeof manifest.license === 'string' && /^SEE LICENSE IN\s+(.+)$/i.exec(manifest.license);
  if (declared) {
    if (isAbsolute(declared[1])) throw new Error(`License document must use a package-relative path in ${manifest.name}`);
    await add(resolve(directory, declared[1]), true);
  }
  if (![...files.values()].some(file => file.license)) {
    throw new Error(`Missing license text for bundled dependency ${manifest.name}@${manifest.version ?? 'unknown'}`);
  }
  return [...files.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export async function bundledLicenseNotice(metafile, workingDirectory, projectDirectory) {
  const project = await realpath(projectDirectory);
  const cache = new Map();
  const packages = new Map();
  // Inputs also cover dependency source text retained in the source map.
  for (const input of Object.keys(metafile.inputs)) {
    const owner = await packageForFile(resolve(workingDirectory, input), cache);
    if (owner.directory !== project) packages.set(owner.directory, owner);
  }
  const sections = [];
  const ordered = [...packages.values()].sort((a, b) =>
    `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`, 'en'));
  for (const owner of ordered) {
    const { name, version, license } = owner.manifest;
    if (typeof version !== 'string' || !version || typeof license !== 'string' || !license) {
      throw new Error(`Missing version or license declaration for bundled dependency ${name}`);
    }
    const documents = await legalDocuments(owner);
    sections.push(`${name}@${version}\nLicense: ${license}\n\n${documents.map(document =>
      `--- ${document.name} ---\n${document.text}`).join('\n\n')}`);
  }
  return `Third-party notices for the bundled worker and its source map.\n\n${sections.join('\n\n========================================\n\n')}\n`;
}
