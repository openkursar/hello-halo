/**
 * JSON Schema utilities
 *
 * Transformations applied to tool `input_schema` / `parameters` payloads.
 * Nothing here runs on the default request path — a schema is rewritten only
 * when a specific upstream is known to reject the spec-compliant form.
 */

export type JsonSchemaNode = Record<string, unknown>

/** Recursion bound, defense-in-depth against pathological schemas. */
const DEREFERENCE_MAX_DEPTH = 64

/**
 * Local-ref forms accepted by `resolveLocalRef`:
 *   - `#/$defs/<Name>`        (JSON Schema 2019-09+ — what MCP servers typically emit)
 *   - `#/definitions/<Name>`  (legacy Draft 4-7 form, still common)
 *
 * External refs (URLs, file paths) are left untouched.
 */
function resolveLocalRef(
  ref: string,
  defs: Record<string, unknown>,
  legacyDefs: Record<string, unknown>
): unknown | undefined {
  if (ref.startsWith('#/$defs/')) {
    return defs[ref.slice('#/$defs/'.length)]
  }
  if (ref.startsWith('#/definitions/')) {
    return legacyDefs[ref.slice('#/definitions/'.length)]
  }
  return undefined
}

/**
 * Cycle protection: while a $ref is being expanded its pointer sits in
 * `seenRefs`; a nested $ref to the same target becomes `{}` (unconstrained),
 * which keeps the request valid instead of recursing forever.
 */
function dereferenceSchema(
  node: unknown,
  defs: Record<string, unknown>,
  legacyDefs: Record<string, unknown>,
  seenRefs: Set<string>,
  depth: number
): unknown {
  if (depth > DEREFERENCE_MAX_DEPTH) return {}
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    return node.map(item => dereferenceSchema(item, defs, legacyDefs, seenRefs, depth + 1))
  }

  const obj = node as JsonSchemaNode

  if (typeof obj['$ref'] === 'string') {
    const ref = obj['$ref'] as string
    if (seenRefs.has(ref)) return {}
    const target = resolveLocalRef(ref, defs, legacyDefs)
    if (target != null) {
      seenRefs.add(ref)
      const resolved = dereferenceSchema(target, defs, legacyDefs, seenRefs, depth + 1)
      seenRefs.delete(ref)
      return resolved
    }
    // External or unresolvable ref — leave intact for the upstream to handle.
    return obj
  }

  const result: JsonSchemaNode = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$defs' || key === 'definitions') continue
    result[key] = dereferenceSchema(value, defs, legacyDefs, seenRefs, depth + 1)
  }
  return result
}

/**
 * Inline every local `$ref` and drop the definition containers, producing a
 * self-contained schema.
 *
 * Lossless but larger: a definition referenced N times is emitted N times.
 * Apply only to upstreams that reject `$ref`, never as a global default —
 * every other upstream would pay the size for one vendor's gap.
 *
 * Returns the input untouched when there is nothing to inline, so callers can
 * detect a no-op by reference equality.
 */
export function inlineSchemaRefs(schema: JsonSchemaNode): JsonSchemaNode {
  const defs = (schema['$defs'] as Record<string, unknown> | undefined) ?? {}
  const legacyDefs = (schema['definitions'] as Record<string, unknown> | undefined) ?? {}
  if (Object.keys(defs).length === 0 && Object.keys(legacyDefs).length === 0) {
    return schema
  }
  return dereferenceSchema(schema, defs, legacyDefs, new Set(), 0) as JsonSchemaNode
}

/**
 * Inline `$ref` in every tool schema of an OpenAI-format request body.
 *
 * Handles both wire shapes: Chat Completions nests the schema under
 * `tool.function.parameters`, Responses puts it at `tool.parameters`.
 *
 * @returns how many tool schemas were rewritten
 */
export function inlineToolSchemaRefs(body: Record<string, unknown>): number {
  const tools = body['tools']
  if (!Array.isArray(tools)) return 0

  let rewritten = 0
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const entry = tool as Record<string, unknown>
    const holder = (entry['function'] as Record<string, unknown> | undefined) ?? entry
    const params = holder['parameters']
    if (!params || typeof params !== 'object' || Array.isArray(params)) continue

    const inlined = inlineSchemaRefs(params as JsonSchemaNode)
    if (inlined !== params) {
      holder['parameters'] = inlined
      rewritten++
    }
  }
  return rewritten
}
