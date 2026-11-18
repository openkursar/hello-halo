import { loadBinding } from './binding.js';
import { decodeWire, encodeWire } from './wire.js';

function value<T>(method: string, input: unknown): T {
  const result = loadBinding().redactionValue(method, JSON.stringify(encodeWire(input)));
  return decodeWire(JSON.parse(result)) as T;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers);
  const references = Object.fromEntries(entries.map(([key], index) => [key, index]));
  const returned = value<Record<string, number | string>>('headers', references);
  const result: Record<string, string> = {};
  for (const [key, reference] of Object.entries(returned)) {
    result[key] = typeof reference === 'number' ? entries[reference][1] : reference;
  }
  return result;
}

export function redactSecrets(text: string): string { return value('secrets', text); }
export function truncateField(text: string, maxChars = 2048): string { return value('truncate', [text, maxChars]); }
