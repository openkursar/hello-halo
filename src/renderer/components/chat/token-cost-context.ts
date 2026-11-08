import { createContext, useContext } from 'react'

/**
 * Whether a reply's dollar figures can be shown. On a group the engine prices
 * every reply by one fixed model, so they would be wrong and are left out.
 */
export const TokenCostContext = createContext(true)

export function useTokenCostShown(): boolean {
  return useContext(TokenCostContext)
}
