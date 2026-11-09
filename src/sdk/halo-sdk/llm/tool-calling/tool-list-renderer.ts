/**
 * @module llm/tool-calling/tool-list-renderer
 * Parameter extraction shared by the XML and JSON prompt-injection renderers.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface ParamInfo {
  name: string;
  required: boolean;
  type: string;
  description: string;
  enumValues?: unknown[];
  defaultValue?: unknown;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for use by format renderers)
// ---------------------------------------------------------------------------

/** Extract parameter metadata from a JSON Schema definition. */
export function extractParams(schema: Record<string, unknown>): ParamInfo[] {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return [];

  const required = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    required: required.has(name),
    type: String(prop.type ?? 'string'),
    description: String(prop.description ?? ''),
    enumValues: Array.isArray(prop.enum) ? prop.enum : undefined,
    defaultValue: prop.default,
  }));
}

