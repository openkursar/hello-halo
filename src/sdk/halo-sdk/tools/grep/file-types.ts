/**
 * @module tools/grep/file-types
 * Map of file type shorthand names to glob extensions.
 * @license MIT
 */

/** Map file type shorthand to file extensions (without leading dot). */
const FILE_TYPE_MAP: Record<string, string[]> = {
  rust: ['rs'],
  rs: ['rs'],
  js: ['js', 'jsx', 'mjs', 'cjs'],
  ts: ['ts', 'tsx', 'mts', 'cts'],
  py: ['py', 'pyi'],
  python: ['py', 'pyi'],
  go: ['go'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cpp', 'hpp', 'cc', 'hh', 'cxx'],
  rb: ['rb'],
  ruby: ['rb'],
  php: ['php'],
  swift: ['swift'],
  kt: ['kt', 'kts'],
  kotlin: ['kt', 'kts'],
  css: ['css', 'scss', 'sass', 'less'],
  html: ['html', 'htm'],
  json: ['json'],
  yaml: ['yaml', 'yml'],
  yml: ['yaml', 'yml'],
  toml: ['toml'],
  xml: ['xml'],
  md: ['md', 'markdown'],
  markdown: ['md', 'markdown'],
  sh: ['sh', 'bash', 'zsh'],
  shell: ['sh', 'bash', 'zsh'],
  bash: ['sh', 'bash', 'zsh'],
};

/**
 * Get file extensions for a given type shorthand.
 * Returns an empty array if the type is unknown.
 */
export function extensionsForType(type: string): string[] {
  return FILE_TYPE_MAP[type.toLowerCase()] ?? [];
}
