import { expect, it } from 'vitest'
import { peopleContextReferences } from '../../../src/renderer/components/chat/tool-result/people-context'

it('renders only structured references from the authorized context query tool', () => {
  const output = JSON.stringify({ references: [{ kind: 'team', teamId: 't', appId: 'a', label: 'Research', epochId: 'task' }] })
  expect(peopleContextReferences('mcp__halo__read_digital_human_context', output)?.[0].epochId).toBe('task')
  expect(peopleContextReferences('Bash', output)).toBeNull()
  expect(peopleContextReferences('read_digital_human_context', 'See team https://malicious.example')).toBeNull()
})
it('rejects malformed routes and deduplicates object references without interpreting links', () => {
  const reference = { kind: 'team', teamId: 't', appId: 'a', label: '<script>not executed</script>' }
  expect(peopleContextReferences('read_digital_human_context', JSON.stringify({ references: [reference, reference, { ...reference, epochId: 12 }, { ...reference, kind: 'delete' }] }))).toEqual([reference])
})
