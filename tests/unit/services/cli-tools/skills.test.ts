import { describe, expect, it } from 'vitest'
import {
  CLI_SKILL_DESCRIPTION_MAX,
  cliSkillName,
  renderCliSkill,
  resolveSkillDescription,
  splitGuide,
} from '../../../../src/main/services/cli-tools/skills'

const names = { toolName: 'Example' }

describe('CLI skill descriptions', () => {
  it('reads only the description from guide frontmatter', () => {
    const guide = '---\ndescription: |\n  Query example\n  tickets.\nallowed-tools: Bash(*)\nname: test\n---\n\n# Example\nRun `example list`.\n'
    expect(splitGuide(guide)).toEqual({ description: 'Query example tickets.', body: '# Example\nRun `example list`.\n' })
    expect(splitGuide('\uFEFF# Tool\n---\nnot frontmatter\n')).toEqual({ body: '# Tool\n---\nnot frontmatter\n' })
    expect(splitGuide('---\ndescription: [unclosed\n---\nbody\n')).toEqual({ body: 'body\n' })
    expect(splitGuide('---\n---\nbody\n')).toEqual({ body: 'body\n' })
    expect(splitGuide('---\ndescription: 42\n---\nbody\n')).toEqual({ body: 'body\n' })
    expect(splitGuide('---\r\ndescription: Windows\r\n---\r\nbody\r\n')).toEqual({ description: 'Windows', body: 'body\r\n' })
  })

  it('chooses override, package, manifest, then generated description', () => {
    expect(resolveSkillDescription({ ...names, admin: 'A', package: 'P', manifest: 'M' })).toEqual({ description: 'A', source: 'admin' })
    expect(resolveSkillDescription({ ...names, admin: '  ', package: 'P', manifest: 'M' })).toEqual({ description: 'P', source: 'package' })
    expect(resolveSkillDescription({ ...names, manifest: 'M' })).toEqual({ description: 'M', source: 'manifest' })
    expect(resolveSkillDescription(names)).toEqual({ description: 'Use the Example command-line tool.', source: 'default' })
  })

  it('normalizes whitespace and caps Unicode characters', () => {
    const long = '工'.repeat(CLI_SKILL_DESCRIPTION_MAX + 20)
    expect(Array.from(resolveSkillDescription({ ...names, package: `${long}\n\nmore` }).description)).toHaveLength(CLI_SKILL_DESCRIPTION_MAX)
    expect(resolveSkillDescription({ ...names, admin: ' a\n\tb ' }).description).toBe('a b')
  })
})

describe('static CLI skills', () => {
  it('uses a stable bounded name and disambiguates equal slugs', () => {
    expect(cliSkillName('com.example-tool')).toMatch(/^cli-com-example-tool-[a-z0-9]{12}$/)
    expect(cliSkillName('com.example-tool')).not.toBe(cliSkillName('com.example.tool'))
    expect(cliSkillName(`${'a'.repeat(46)}-long-tool`)).toMatch(/^cli-a{46}-[a-z0-9]{12}$/)
    expect(cliSkillName('z'.repeat(128)).length).toBeLessThanOrEqual(64)
  })

  it('uses the active pin only, and tells the agent not to fall back', () => {
    const body = renderCliSkill('com.example-tool')
    expect(body).toContain('`com.example-tool`')
    expect(body).toContain('`$HALO_CLI_TOOLS_BIN/../TOOLS.md`')
    expect(body).toMatch(/unset or empty.*do not run this tool or fall back to a bare command/)
    expect(body).toMatch(/tool is unavailable or unlisted, do not run it or use another program in its place/)
    expect(body).toContain('from the launcher directory')
    expect(body).not.toMatch(/organization|^---/)
  })
})
