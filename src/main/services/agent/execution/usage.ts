import { addRunTokenUsage, type RunTokenUsage } from '../../../../shared/apps/app-types'

/** Every turn's usage and the delegated work's, summed once. */
export function createUsageLedger() {
  let total: RunTokenUsage | undefined
  return {
    add(usage: RunTokenUsage | undefined): void { total = addRunTokenUsage(total, usage) },
    total: (): RunTokenUsage | undefined => total,
  }
}
