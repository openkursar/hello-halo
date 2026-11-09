import * as fs from 'node:fs';
import * as path from 'node:path';
import { open } from 'node:fs/promises';
import { isMap, parseDocument } from 'yaml';
import { DEFAULT_CONVENTIONS, resolveHome, userConfigDir } from '../core/conventions.js';
import { readBounded } from '../utils/bounded-read.js';
import { getLogger } from '../utils/logger.js';
import { BUILTIN_SKILLS } from './builtins.js';
import type { LoadedSkill, SkillCatalog, SkillContext, SkillEntry, SkillMetadata } from './types.js';

const METADATA_BYTES = 16 * 1024;
const MAX_SKILL_BYTES = 1024 * 1024;

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function warn(message: string, filePath: string, error: unknown): void {
  getLogger('Skills').warn(message, { path: filePath, code: (error as NodeJS.ErrnoException).code, error: String(error) });
}

/** Skill names address catalog entries, never arbitrary relative paths. */
export function normalizeSkillName(name: string): string | null {
  const normalized = name.trim().replace(/\.md$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\u0000-\u001f<>"&]/.test(normalized)) return null;
  return normalized;
}

export function skillSearchDirs(ctx: SkillContext): string[] {
  const conventions = ctx.conventions ?? DEFAULT_CONVENTIONS;
  const dirs: string[] = [];
  for (const agentDir of conventions.agentDirs) {
    dirs.push(path.join(ctx.cwd, agentDir, 'commands'), path.join(ctx.cwd, agentDir, 'skills'));
  }
  dirs.push(path.join(userConfigDir(ctx.env, conventions), 'skills'));
  for (const agentDir of conventions.agentDirs) {
    dirs.push(path.join(resolveHome(ctx.env), agentDir, 'commands'), path.join(resolveHome(ctx.env), agentDir, 'skills'));
  }
  return [...new Set(dirs)];
}

function fileKind(filePath: string): 'file' | 'directory' | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null;
  } catch (error) {
    if (!isMissing(error)) warn('Skill entry could not be inspected', filePath, error);
    return null;
  }
}

export function discoverSkillFiles(dirs: readonly string[]): Array<[string, string]> {
  const found = new Map<string, [string, string]>();
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();
  for (const dir of dirs) {
    let canonicalDir: string;
    let entries: fs.Dirent[];
    try {
      canonicalDir = fs.realpathSync(dir);
      if (seenDirs.has(canonicalDir)) continue;
      seenDirs.add(canonicalDir);
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (!isMissing(error)) warn('Skill directory could not be scanned', dir, error);
      continue;
    }

    const add = (name: string, filePath: string) => {
      const normalized = normalizeSkillName(name);
      if (!normalized || normalized.toLowerCase() === 'list') {
        getLogger('Skills').warn('Skill entry skipped because its name is invalid or reserved', { path: filePath });
        return;
      }
      const key = normalized.toLowerCase();
      if (found.has(key)) return;
      try {
        const canonicalFile = fs.realpathSync(filePath);
        if (seenFiles.has(canonicalFile)) return;
        seenFiles.add(canonicalFile);
        found.set(key, [normalized, filePath]);
      } catch (error) {
        warn('Discovered skill could not be resolved', filePath, error);
      }
    };

    // Flat files win even when a directory sorts before its namesake file.
    for (const entry of entries) {
      if (!entry.name.endsWith('.md') || entry.name === 'SKILL.md') continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isFile() || (entry.isSymbolicLink() && fileKind(filePath) === 'file')) add(entry.name.slice(0, -3), filePath);
    }
    for (const entry of entries) {
      const directory = path.join(dir, entry.name);
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && fileKind(directory) === 'directory')) continue;
      const filePath = path.join(directory, 'SKILL.md');
      if (fileKind(filePath) === 'file') add(entry.name, filePath);
    }
  }
  return [...found.values()].sort(([a], [b]) => a.localeCompare(b));
}

function splitDocument(content: string): { frontmatter?: string; body: string } {
  const match = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(content);
  return match ? { frontmatter: match[1], body: content.slice(match[0].length) } : { body: content };
}

export function readSkillMetadata(filePath: string): SkillMetadata {
  let content: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Skill source is not a regular file');
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, METADATA_BYTES));
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    content = buffer.toString('utf8', 0, length);
  } catch (error) {
    warn('Skill metadata could not be read', filePath, error);
    return { description: '' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const { frontmatter, body } = splitDocument(content);
  if (frontmatter === undefined && /^\uFEFF?---[^\S\r\n]*\r?\n/.test(content)) {
    getLogger('Skills').warn('Skill metadata header is incomplete or exceeds its read limit', { path: filePath, limitBytes: METADATA_BYTES });
    return { description: '' };
  }
  const fields: Record<string, string> = {};
  if (frontmatter !== undefined) {
    const doc = parseDocument(frontmatter, { schema: 'failsafe', logLevel: 'silent' });
    if (doc.errors.length || !isMap(doc.contents)) getLogger('Skills').warn('Invalid skill metadata; using body description', { path: filePath });
    else {
      for (const key of ['description', 'whenToUse', 'argumentHint', 'argument-hint']) {
        const value = doc.get(key);
        if (typeof value === 'string' && value.trim()) fields[key] = value.trim();
      }
    }
  }
  const fallback = body.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#')) ?? '';
  return {
    description: fields.description ?? fallback,
    whenToUse: fields.whenToUse,
    argumentHint: fields.argumentHint ?? fields['argument-hint'],
  };
}

export function snapshotSkillCatalog(catalog: SkillCatalog): SkillCatalog {
  const invalid = (index: number, reason: string): never => {
    getLogger('Skills').warn('Explicit skill catalog rejected', { index, reason });
    throw new TypeError(`Invalid skillCatalog entry ${index}: ${reason}`);
  };
  if (!Array.isArray(catalog)) invalid(-1, 'expected an array');
  const names = new Set<string>();
  return Object.freeze(catalog.map((entry, index) => {
    if (!entry || typeof entry.name !== 'string') invalid(index, 'name must be a string');
    const name = normalizeSkillName(entry.name);
    if (!name || name.toLowerCase() === 'list') return invalid(index, 'invalid or reserved name');
    if (names.has(name.toLowerCase())) invalid(index, 'duplicate name');
    names.add(name.toLowerCase());
    if (typeof entry.description !== 'string') invalid(index, 'description must be a string');
    for (const key of ['whenToUse', 'argumentHint'] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') invalid(index, `${key} must be a string`);
    }
    const source = entry.source;
    if (!source || (source.kind !== 'file' && source.kind !== 'builtin')) invalid(index, 'invalid source');
    if (source.kind === 'file' && (typeof source.path !== 'string' || !path.isAbsolute(source.path) || source.path.includes('\0'))) invalid(index, 'file source must be an absolute path');
    if (source.kind === 'builtin' && !BUILTIN_SKILLS.some(skill => skill.name === source.name)) invalid(index, 'unknown builtin source');
    return Object.freeze({ name, description: entry.description, whenToUse: entry.whenToUse,
      argumentHint: entry.argumentHint, source: Object.freeze(source.kind === 'file'
        ? { kind: 'file' as const, path: source.path }
        : { kind: 'builtin' as const, name: source.name }) });
  }));
}

export function resolveSkillCatalog(ctx: SkillContext): SkillCatalog {
  if (ctx.skillCatalog !== undefined) return ctx.skillCatalog;
  const entries: SkillEntry[] = discoverSkillFiles(skillSearchDirs(ctx)).map(([name, filePath]) => ({
    name, source: { kind: 'file', path: filePath }, ...readSkillMetadata(filePath),
  }));
  const names = new Set(entries.map(entry => entry.name.toLowerCase()));
  for (const skill of BUILTIN_SKILLS) {
    if (!names.has(skill.name)) entries.push({
      name: skill.name, description: skill.description, argumentHint: skill.argumentHint,
      source: { kind: 'builtin', name: skill.name },
    });
  }
  return Object.freeze(entries.sort((a, b) => a.name.localeCompare(b.name)).map(entry =>
    Object.freeze({ ...entry, source: Object.freeze({ ...entry.source }) }),
  ));
}

export function resolveSkill(name: string, ctx: SkillContext): SkillEntry | undefined {
  const normalized = normalizeSkillName(name);
  if (!normalized) return undefined;
  if (ctx.skillCatalog !== undefined) return ctx.skillCatalog.find(entry => entry.name.toLowerCase() === normalized.toLowerCase());
  const disk = discoverSkillFiles(skillSearchDirs(ctx)).find(([candidate]) => candidate.toLowerCase() === normalized.toLowerCase());
  if (disk) return { name: disk[0], source: { kind: 'file', path: disk[1] }, ...readSkillMetadata(disk[1]) };
  const builtin = BUILTIN_SKILLS.find(skill => skill.name === normalized.toLowerCase());
  return builtin ? {
    name: builtin.name, description: builtin.description, argumentHint: builtin.argumentHint,
    source: { kind: 'builtin', name: builtin.name },
  } : undefined;
}

export async function loadSkill(entry: SkillEntry, args = ''): Promise<LoadedSkill> {
  try {
    let body: string;
    const source = entry.source;
    if (source.kind === 'builtin') {
      const builtin = BUILTIN_SKILLS.find(skill => skill.name === source.name);
      if (!builtin) throw new Error(`Built-in skill '${entry.name}' is unavailable`);
      body = builtin.instructions;
    } else {
      const handle = await open(source.path, 'r');
      try { body = splitDocument((await readBounded(handle, MAX_SKILL_BYTES)).toString('utf8')).body; }
      finally { await handle.close(); }
    }
    const prompt = body.replace(/\$ARGUMENTS_SUFFIX|\$ARGUMENTS/g, token => token === '$ARGUMENTS_SUFFIX' ? (args.trim() ? `: ${args}` : '') : args).trim();
    if (!prompt) throw new Error(`Skill '${entry.name}' expanded to empty content.`);
    if (Buffer.byteLength(prompt, 'utf8') > MAX_SKILL_BYTES) throw new Error(`Skill '${entry.name}' exceeds the ${MAX_SKILL_BYTES} byte instruction limit.`);
    return { name: entry.name, source: entry.source, prompt };
  } catch (error) {
    getLogger('Skills').warn('Skill instructions could not be loaded', { name: entry.name, source: entry.source.kind, error: String(error) });
    throw error;
  }
}
