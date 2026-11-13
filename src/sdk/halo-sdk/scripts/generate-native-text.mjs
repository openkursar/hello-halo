import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('..', import.meta.url));
const harness = join(sdk, 'native/crates/halo-core/src/harness');
const catalog = new Map();
async function readCatalogs(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await readCatalogs(path);
    else if (entry.name.endsWith('.json')) for (const [id, template] of Object.entries(JSON.parse(await readFile(path, 'utf8')))) {
      if (catalog.has(id)) throw new Error(`Duplicate Harness text identifier: ${id}`);
      catalog.set(id, template);
    }
  }
}
await readCatalogs(join(harness, 'catalogs'));
const ids = ['providers.error.rate_limit', 'providers.error.overloaded', 'providers.error.context_window',
  'providers.http.error', 'providers.http.error_without_body', 'context.execution.budget', 'context.execution.max_turns',
  'context.execution.aborted', 'context.error.compact', 'context.error.missing_result', 'context.history.unavailable', 'context.recovery.max_tokens',
  'prompt.how_you_work', 'prompt.how_you_work.ultra', 'prompt.communicating'];
const selected = Object.fromEntries(ids.map(id => {
  if (!catalog.has(id)) throw new Error(`Unknown Harness text identifier: ${id}`);
  return [id, catalog.get(id)];
}));
function materialize(value) {
  if (Array.isArray(value)) return value.map(materialize);
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && Object.hasOwn(value, '$harness')) {
    const template = catalog.get(value.$harness);
    if (!template || template.slots.length) throw new Error(`Resource requires a static Harness template: ${value.$harness}`);
    return template.text;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materialize(child)]));
}
async function output(name, content) {
  const path = join(sdk, name);
  await mkdir(dirname(path), { recursive: true });
  let previous;
  try { previous = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== content) await writeFile(path, content);
}
await output('harness/generated/text.ts', `// Generated from the Harness catalogs.\nexport const baselineTemplates = ${JSON.stringify(selected, null, 2)} as const;\n`);
const commands = materialize(JSON.parse(await readFile(join(harness, 'resources/command-definitions.json'), 'utf8'))).commands;
await output('native/generated/commands.ts', `// Generated from the Harness resources.\nexport const builtinCommandMetadata = ${JSON.stringify(commands, null, 2)} as const;\n`);
const constants = materialize(JSON.parse(await readFile(join(harness, 'resources/prompt-sections.json'), 'utf8'))).constants;
await output('harness/generated/constants.ts', `// Generated from the Harness resources.\n${Object.entries(constants).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join('\n')}\n`);
const collaboration = materialize(JSON.parse(await readFile(join(harness, 'resources/collaboration_tools.json'), 'utf8')));
await output('native/generated/collaboration.ts', `// Generated from the Harness resources.\nexport const baselineCollaborationDescriptors = ${JSON.stringify(collaboration, null, 2)} as const;\nexport const baselineCollaborationGuidance = ${JSON.stringify(catalog.get('collaboration.guidance').text)};\nexport const baselineCollaborationToolNames = ${JSON.stringify(collaboration.map(tool => tool.name))} as const;\n`);
