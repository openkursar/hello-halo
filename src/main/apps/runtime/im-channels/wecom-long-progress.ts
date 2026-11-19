import type { WorkProgressEvent } from '../../../../shared/types/inbound-message'

const SUMMARY_IDLE_MS = 15 * 60 * 1000
const SUMMARY_MIN_OPERATIONS = 20
const MAX_NAMED_KINDS = 3

const OPERATION_LABELS = {
  read: (count: number) => `读取了 ${count} 个文件`,
  command: (count: number) => `运行了 ${count} 条命令`,
  write: (count: number) => `写入了 ${count} 个文件`,
  edit: (count: number) => `编辑了 ${count} 个文件`,
  find: (count: number) => `查找了 ${count} 次文件`,
  search: (count: number) => `搜索了 ${count} 次`,
  browser: (count: number) => `操作了 ${count} 次浏览器`,
  web: (count: number) => `查看了 ${count} 个网页`,
  other: (count: number) => `完成了 ${count} 项工具操作`,
}

type OperationKind = keyof typeof OPERATION_LABELS

function operationKind(tool: string): OperationKind | undefined {
  switch (tool) {
    case 'Read': return 'read'
    case 'Bash': return 'command'
    case 'Write': return 'write'
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit'
    case 'Glob': return 'find'
    case 'Grep': case 'WebSearch': return 'search'
    case 'WebFetch': return 'web'
    case 'TodoRead': case 'TodoWrite': case 'AskUserQuestion': case 'report_to_user': return undefined
    default:
      if (tool.endsWith('__report_to_user')) return undefined
      if (tool.startsWith('mcp__ai-browser__')) return 'browser'
      if (tool.startsWith('mcp__ai-terminal__')) return 'command'
      if (tool.startsWith('mcp__web-search__')) return 'search'
      return 'other'
  }
}

export interface LongProgressUpdate {
  text: string
  operations: ReadonlyMap<OperationKind, number>
}

export function mergeLongProgress(earlier: LongProgressUpdate | undefined, next: LongProgressUpdate): LongProgressUpdate {
  if (!earlier) return next
  const operations = new Map(earlier.operations)
  for (const [kind, count] of next.operations) operations.set(kind, (operations.get(kind) ?? 0) + count)
  return { operations, text: [earlier.text, next.text].filter(Boolean).join('\n\n') }
}

export function formatLongProgress({ text, operations }: LongProgressUpdate): string {
  const kinds = [...operations]
  const parts = kinds.slice(0, MAX_NAMED_KINDS).map(([kind, count]) => OPERATION_LABELS[kind](count))
  const remaining = kinds.slice(MAX_NAMED_KINDS).reduce((total, [, count]) => total + count, 0)
  if (remaining) parts.push(`另有 ${remaining} 项操作`)
  return [parts.length ? `_${parts.join('，')}_` : '', text].filter(Boolean).join('\n\n')
}

export class WecomLongProgress {
  private readonly outstanding = new Map<string, OperationKind>()
  private readonly settled = new Set<string>()
  private operations = new Map<OperationKind, number>()
  private completed = 0
  private speech: string[] = []
  private lastVisibleAt: number | undefined
  private summaryAttempted = false

  start(now: number): void {
    this.lastVisibleAt = now
  }

  visible(now: number): void {
    this.lastVisibleAt = now
  }

  observe(event: WorkProgressEvent, now: number, sending: boolean): LongProgressUpdate | undefined {
    switch (event.type) {
      case 'speech':
        if (this.lastVisibleAt !== undefined && event.text.trim()) this.speech.push(event.text.trim())
        break
      case 'speech_delta': break
      case 'operation_started': {
        if (this.settled.has(event.id) || this.outstanding.has(event.id)) break
        const kind = operationKind(event.tool)
        if (!kind) break
        this.outstanding.set(event.id, kind)
        // The next tool proves the preceding words were narration, not the final answer.
        if (this.speech.length) return this.take(this.speech.join('\n\n'))
        break
      }
      case 'operation_finished': {
        const kind = this.outstanding.get(event.id)
        if (!kind) break
        this.outstanding.delete(event.id)
        this.settled.add(event.id)
        if (this.lastVisibleAt === undefined || !event.success) break
        this.operations.set(kind, (this.operations.get(kind) ?? 0) + 1)
        this.completed += 1
        if (!sending && !this.speech.length && !this.summaryAttempted &&
          this.completed >= SUMMARY_MIN_OPERATIONS && now - this.lastVisibleAt >= SUMMARY_IDLE_MS) {
          this.summaryAttempted = true
          return this.take('')
        }
        break
      }
    }
  }

  wordsSoFar(): string {
    return this.speech.join('\n\n')
  }

  take(text: string): LongProgressUpdate {
    const update = { text, operations: this.operations }
    this.operations = new Map()
    this.completed = 0
    this.speech = []
    return update
  }
}
