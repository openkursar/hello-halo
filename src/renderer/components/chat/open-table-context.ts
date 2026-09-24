/**
 * Where a rendered markdown table can be opened at full size, as CSV.
 * Provided by pages that host a place to show it; without a provider tables
 * get no open action.
 */

import { createContext } from 'react'

export const OpenTableContext = createContext<((csv: string) => void) | null>(null)
