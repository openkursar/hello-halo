import type { Message } from '../types/provider.js';
import { normalizeSkillName, resolveSkillCatalog, type SkillContext } from '../skills/index.js';
import { buildSystemReminderMessage } from '../utils/system-reminder.js';

const CATALOG_CHAR_BUDGET = 16_000;
const ACTIVE_SKILL_BYTE_BUDGET = 1024;
const ACTIVE_SKILL_LIMIT = 3;

/** Advertise metadata only; instruction bodies are loaded through a selected skill. */
export function buildSkillContextMessage(ctx: SkillContext, enabled = true): Message | null {
  if (!enabled) return null;
  const skills = resolveSkillCatalog(ctx);
  if (!skills.length) return null;
  const lines = ['# skills', 'Available workflows. Load a matching entry with Skill before using its instructions.'];
  let length = lines.join('\n').length;
  let included = 0;
  for (const entry of skills) {
    const description = entry.description.replace(/\s+/g, ' ').slice(0, 200);
    const line = `- ${entry.name}: ${description}`;
    if (length + line.length + 1 > CATALOG_CHAR_BUDGET - 100) break;
    lines.push(line);
    length += line.length + 1;
    included++;
  }
  if (included < skills.length) lines.push(`${skills.length - included} more skills are available through Skill with skill="list".`);
  return buildSystemReminderMessage(lines.join('\n'));
}

export interface ActiveSkillReference { name: string }

function addReference(references: ActiveSkillReference[], name: unknown): void {
  if (typeof name !== 'string') return;
  const normalized = normalizeSkillName(name);
  if (!normalized || normalized === 'list' || Buffer.byteLength(normalized, 'utf8') > 256) return;
  const previous = references.findIndex(reference => reference.name.toLowerCase() === normalized.toLowerCase());
  if (previous >= 0) references.splice(previous, 1);
  references.push({ name: normalized });
  if (references.length > ACTIVE_SKILL_LIMIT) references.shift();
}

function collectMarkedText(text: string, references: ActiveSkillReference[]): void {
  const invocation = /^<skill-instructions name="([^"\n]+)">\n/.exec(text);
  if (invocation) addReference(references, invocation[1]);
  const restored = /^<system-reminder>\s*<active-skills>([^\n]{1,1024})<\/active-skills>/.exec(text);
  if (!restored) return;
  try {
    const entries: unknown = JSON.parse(restored[1]);
    if (Array.isArray(entries)) for (const entry of entries.slice(-ACTIVE_SKILL_LIMIT)) addReference(references, entry?.name);
  } catch {
    // Conversation text that resembles a marker is not a state record.
  }
}

/** Called at history rewrite boundaries, not for each model request. */
export function collectActiveSkillReferences(
  messages: readonly Message[],
  previous: readonly ActiveSkillReference[] = [],
): ActiveSkillReference[] {
  const references: ActiveSkillReference[] = [];
  for (const entry of previous.slice(-ACTIVE_SKILL_LIMIT)) addReference(references, entry.name);
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (message.role === 'user') collectMarkedText(message.content, references);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      if (message.role === 'assistant' && block.type === 'tool_use' && block.name === 'Skill') {
        const input = block.input;
        const name = input && typeof input === 'object' && typeof input.skill === 'string'
          ? normalizeSkillName(input.skill) : null;
        if (name && name !== 'list') pending.set(block.id, name);
      } else if (message.role === 'user' && block.type === 'tool_result') {
        const name = pending.get(block.tool_use_id);
        if (name && !block.is_error) addReference(references, name);
        pending.delete(block.tool_use_id);
      } else if (message.role === 'user' && block.type === 'text') {
        collectMarkedText(block.text, references);
      }
    }
  }
  return references;
}

export function buildActiveSkillContextMessage(references: readonly ActiveSkillReference[]): Message | null {
  const bounded: ActiveSkillReference[] = [];
  for (const entry of references.slice(-ACTIVE_SKILL_LIMIT)) addReference(bounded, entry.name);
  while (bounded.length) {
    const message = buildSystemReminderMessage(
      `<active-skills>${JSON.stringify(bounded)}</active-skills>\n` +
      'These skills were loaded earlier. If their instructions were removed from view and still apply to the current request, reload them with Skill before continuing. Use the retained request for arguments. This reminder does not authorize new actions.',
    );
    const text = (message.content as Array<{ type: 'text'; text: string }>)[0].text;
    if (Buffer.byteLength(text, 'utf8') <= ACTIVE_SKILL_BYTE_BUDGET) return { ...message, isMeta: true };
    bounded.shift();
  }
  return null;
}
