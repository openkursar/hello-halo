import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface RecipientAddress { teamId: string; epochId: string; appId: string }
export interface RecipientFences {
  read(target: RecipientAddress): string
  accepts(target: RecipientAddress, fence?: string): boolean
  rotate(target: RecipientAddress): string
  clearEpoch(teamId: string, epochId: string): void
}

/** Normal delivery is read-only; stop and clear persist an irreversible incarnation change. */
export function createRecipientFences(db: Database.Database): RecipientFences {
  const read = db.prepare(`SELECT incarnation FROM collaboration_recipient_fences WHERE team_id = ? AND epoch_id = ? AND app_id = ?
    UNION ALL SELECT incarnation FROM collaboration_recipient_epochs WHERE team_id = ? AND epoch_id = ? LIMIT 1`)
  const set = db.prepare(`INSERT INTO collaboration_recipient_fences(team_id, epoch_id, app_id, incarnation) VALUES (?, ?, ?, ?)
    ON CONFLICT(team_id, epoch_id, app_id) DO UPDATE SET incarnation = excluded.incarnation`)
  const current = (target: RecipientAddress) => (read.get(target.teamId, target.epochId, target.appId, target.teamId, target.epochId) as { incarnation: string } | undefined)?.incarnation ?? 'initial'
  return {
    read: current,
    accepts: (target, fence) => (fence ?? 'initial') === current(target),
    rotate(target) { const value = randomUUID(); set.run(target.teamId, target.epochId, target.appId, value); return value },
    clearEpoch: db.transaction((teamId, epochId) => {
      db.prepare('DELETE FROM collaboration_recipient_fences WHERE team_id = ? AND epoch_id = ?').run(teamId, epochId)
      db.prepare(`INSERT INTO collaboration_recipient_epochs(team_id, epoch_id, incarnation) VALUES (?, ?, ?)
        ON CONFLICT(team_id, epoch_id) DO UPDATE SET incarnation = excluded.incarnation`).run(teamId, epochId, randomUUID())
    }),
  }
}
