/**
 * Model Pricing — List Prices From Model IDs
 *
 * Data lives in src/shared/data/model-pricing.json (USD per million tokens,
 * with the source of every vendor's figures under `_meta`).
 *
 * A wire id is resolved against the table after normalisation, first hit wins:
 *   1. The id with any `[1m]` marker and routing prefix removed, lowercased
 *      ("Pro/zai-org/GLM-4.7" → "glm-4.7", "claude-opus-4-6[1m]" → "claude-opus-4-6")
 *   2. The same without a trailing snapshot date
 *      ("claude-haiku-4-5-20251001" → "claude-haiku-4-5"); a dated entry of
 *      its own, priced differently, is caught by step 1
 *   3. Steps 1–2 with dots read as dashes, for gateways that spell versions
 *      with dots ("anthropic/claude-opus-4.8" → "claude-opus-4-8")
 * Anything else has no price: no family guessing, since a wrong price reads as
 * a real one.
 */

import pricingData from '../data/model-pricing.json'

/** Token prices in USD per million tokens. */
export interface ModelPrice {
  inputPerMtk: number
  outputPerMtk: number
  cacheCreationPerMtk: number
  cacheReadPerMtk: number
}

interface ModelPricingData {
  models: Record<string, ModelPrice & { source: string }>
}

const ONE_M_MARKER = /\[1m\]$/i
const SNAPSHOT_DATE = /-(\d{8}|\d{4}-\d{2}-\d{2})$/

function normalizePricingId(raw: string): string {
  const id = raw.trim().replace(ONE_M_MARKER, '')
  const lastSlash = id.lastIndexOf('/')
  return (lastSlash >= 0 ? id.slice(lastSlash + 1) : id).toLowerCase()
}

const dotsAsDashes = (id: string): string => id.replace(/\./g, '-')

const byId = new Map<string, ModelPrice>()
const byDashedId = new Map<string, ModelPrice>()
/** Every priced id under both its vendor spelling and its lowercase form. */
const exactTable: Record<string, ModelPrice> = {}
for (const [id, entry] of Object.entries((pricingData as ModelPricingData).models)) {
  const price: ModelPrice = {
    inputPerMtk: entry.inputPerMtk,
    outputPerMtk: entry.outputPerMtk,
    cacheCreationPerMtk: entry.cacheCreationPerMtk,
    cacheReadPerMtk: entry.cacheReadPerMtk
  }
  const key = id.toLowerCase()
  byId.set(key, price)
  byDashedId.set(dotsAsDashes(key), price)
  exactTable[id] = price
  exactTable[key] = price
}

/** List price for a wire model id, or null when none is known. */
export function findModelPrice(modelId: string | undefined | null): ModelPrice | null {
  if (!modelId) return null
  const id = normalizePricingId(modelId)
  if (!id) return null
  const undated = id.replace(SNAPSHOT_DATE, '')
  return byId.get(id)
    ?? byId.get(undated)
    ?? byDashedId.get(dotsAsDashes(id))
    ?? byDashedId.get(dotsAsDashes(undated))
    ?? null
}

/**
 * A price table for an engine that matches model ids exactly: every known
 * model under its vendor spelling and lowercase form, plus each of `modelIds`
 * under the exact spelling the engine will look up, when it resolves to a price.
 */
export function buildModelPricingTable(modelIds: readonly string[]): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = { ...exactTable }
  for (const id of modelIds) {
    const price = findModelPrice(id)
    if (price) table[id] = price
  }
  return table
}
