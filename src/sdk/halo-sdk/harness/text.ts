import { baselineTemplates } from './generated/text.js';

type TextId = keyof typeof baselineTemplates;
export interface HarnessMessage { kind: 'template'; id: TextId; values: [string, { kind: 'data'; text: string }][] }
export function baselineText(id: TextId, values: Record<string, string> = {}): string {
  const template = baselineTemplates[id];
  return template.text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => (template.slots as readonly string[]).includes(key) ? values[key] : match);
}
export function attachHarness<T extends Error>(error: T, id: TextId, values: Record<string, string> = {}): T {
  const harness: HarnessMessage = { kind: 'template', id, values: baselineTemplates[id].slots.map(key => [key, { kind: 'data', text: values[key] }]) };
  return Object.assign(error, { harness });
}
