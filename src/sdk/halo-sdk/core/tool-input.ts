/**
 * @module core/tool-input
 * Checks the arguments a model produced against the schema the tool published,
 * and phrases any mismatch so the model can correct it.
 *
 * Deliberately partial: it rejects only on the keywords it fully understands
 * and stays silent on the rest. A false rejection locks a model out of a tool
 * for the rest of the session, while a false acceptance leaves the tool exactly
 * where it stood without the check. That asymmetry decides every judgement call
 * in this module, and matters most for MCP servers, whose schemas we do not
 * control.
 * @license MIT
 */

/** Keywords whose presence means we cannot reason about this subtree. */
const COMPOSITION_KEYWORDS = ['oneOf', 'anyOf', 'allOf', 'not', '$ref'];

/** How many problems to report at once, so the model gets a fixable list. */
const MAX_REPORTED_PROBLEMS = 5;

type Schema = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the schema uses a construct this module deliberately ignores. */
function isUninterpretable(schema: Schema): boolean {
  return COMPOSITION_KEYWORDS.some((keyword) => keyword in schema);
}

/** The name a reader would use for a runtime value, matching JSON Schema's vocabulary. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Whether a value satisfies one JSON Schema type name. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      // An unrecognised type name is not grounds for rejection.
      return true;
  }
}

/** Human-readable path used in messages: `filters.tags[0]`. */
function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function collectProblems(
  schema: Schema,
  value: unknown,
  path: string,
  problems: string[],
): void {
  if (problems.length >= MAX_REPORTED_PROBLEMS) return;
  if (isUninterpretable(schema)) return;

  const declaredType = schema.type;
  const types = typeof declaredType === 'string'
    ? [declaredType]
    : Array.isArray(declaredType)
      ? declaredType.filter((t): t is string => typeof t === 'string')
      : [];

  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    const label = path ? `"${path}"` : 'the arguments';
    problems.push(
      `${label} must be ${types.join(' or ')}, but received ${describeType(value)}`,
    );
    // The value is the wrong shape, so its contents cannot be checked further.
    return;
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    // Compared by identity, which covers the primitives an enum realistically holds.
    const comparable = value === null || typeof value !== 'object';
    if (comparable && !enumValues.includes(value)) {
      problems.push(
        `"${path}" must be one of ${enumValues.map((v) => JSON.stringify(v)).join(', ')}, ` +
        `but received ${JSON.stringify(value)}`,
      );
      return;
    }
  }

  if (isPlainObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key !== 'string') continue;
        if (value[key] === undefined) {
          problems.push(`"${joinPath(path, key)}" is required but was not provided`);
          if (problems.length >= MAX_REPORTED_PROBLEMS) return;
        }
      }
    }

    const properties = schema.properties;
    if (isPlainObject(properties)) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!isPlainObject(propertySchema)) continue;
        if (value[key] === undefined) continue;
        collectProblems(propertySchema, value[key], joinPath(path, key), problems);
        if (problems.length >= MAX_REPORTED_PROBLEMS) return;
      }
    }
    return;
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      collectProblems(schema.items, value[i], `${path}[${i}]`, problems);
      if (problems.length >= MAX_REPORTED_PROBLEMS) return;
    }
  }
}

/**
 * Check a tool call's arguments against the tool's published schema.
 *
 * Returns a message addressed to the model, or null when nothing checkable is
 * wrong. The message names every problem it found so one correction can fix
 * them all, rather than trading a turn per field.
 */
export function validateToolInput(
  toolName: string,
  schema: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): string | null {
  if (!isPlainObject(schema)) return null;

  const problems: string[] = [];
  collectProblems(schema, input, '', problems);
  if (problems.length === 0) return null;

  return (
    `Invalid arguments for ${toolName}: ${problems.join('; ')}. ` +
    `Correct the arguments and call ${toolName} again.`
  );
}
