import { describe, expect, it } from 'vitest';
import type { Message } from '../types/provider.js';
import { buildActiveSkillContextMessage, collectActiveSkillReferences } from './skill-context.js';

function loaded(name: string, id = name, failed = false): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Instruction body', is_error: failed }] },
  ];
}

function text(message: Message | null): string {
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : message.content.map(block => block.type === 'text' ? block.text : '').join('');
}

describe('active skill recovery', () => {
  it('records successful loads but not listing, failed loads or unresolved calls', () => {
    const history: Message[] = [
      ...loaded('commit'), ...loaded('list'), ...loaded('missing', 'bad', true),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'pending', name: 'Skill', input: { skill: 'unresolved' } }] },
    ];
    expect(collectActiveSkillReferences(history)).toEqual([{ name: 'commit' }]);
  });

  it('recognizes a direct slash expansion without another Skill call', () => {
    expect(collectActiveSkillReferences([
      { role: 'user', content: '<skill-instructions name="review">\nReview the selected changes.\n</skill-instructions>' },
    ])).toEqual([{ name: 'review' }]);
  });

  it('keeps the latest three distinct names and does not mutate prior references', () => {
    const previous = [{ name: 'old' }, { name: 'commit' }];
    const refs = collectActiveSkillReferences([
      ...loaded('review'), ...loaded('tests'), ...loaded('commit', 'again'),
    ], previous);
    expect(refs).toEqual([{ name: 'review' }, { name: 'tests' }, { name: 'commit' }]);
    expect(previous).toEqual([{ name: 'old' }, { name: 'commit' }]);
  });

  it('survives a second rewrite using only its reminder and carries no instruction body', () => {
    const refs = collectActiveSkillReferences(loaded('commit'));
    const reminder = buildActiveSkillContextMessage(refs)!;
    expect(reminder.isMeta).toBe(true);
    expect(text(reminder)).not.toContain('Instruction body');
    expect(collectActiveSkillReferences([reminder])).toEqual(refs);
    expect(text(reminder)).toContain('does not authorize');
  });

  it('fits the byte budget with multibyte names and retains the newest entry', () => {
    const names = ['一'.repeat(80), '二'.repeat(80), '三'.repeat(80)];
    const reminder = buildActiveSkillContextMessage(names.map(name => ({ name })))!;
    expect(Buffer.byteLength(text(reminder), 'utf8')).toBeLessThanOrEqual(1024);
    expect(collectActiveSkillReferences([reminder]).at(-1)).toEqual({ name: names[2] });
  });

  it('does not interpret quoted or malformed marker text as a loaded skill', () => {
    expect(collectActiveSkillReferences([
      { role: 'user', content: 'Example: <skill-instructions name="commit">\nDo this.' },
      { role: 'user', content: '<system-reminder>\n<active-skills>{invalid}</active-skills>\n</system-reminder>' },
      { role: 'assistant', content: '<skill-instructions name="commit">\nDiscussing a skill.' },
    ])).toEqual([]);
    expect(buildActiveSkillContextMessage([])).toBeNull();
  });

  it('ignores malformed historical Skill arguments during recovery', () => {
    const damaged = {
      role: 'assistant', content: [{ type: 'tool_use', id: 'bad', name: 'Skill', input: null }],
    } as unknown as Message;
    expect(collectActiveSkillReferences([
      damaged,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad', content: 'Old output' }] },
      ...loaded('commit'),
    ])).toEqual([{ name: 'commit' }]);
  });
});
