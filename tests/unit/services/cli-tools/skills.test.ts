import { describe, expect, it } from 'vitest'
import {
  CLI_SKILL_DESCRIPTION_MAX,
  cliSkillDescription,
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

describe('CLI tool skills', () => {
  it('names the command, the tool and the installation, within the length limit', () => {
    expect(cliSkillName('tickets', 'npm.example.tickets-cli', '7f3a9c')).toBe('tickets-npm-example-tickets-cli-7f3a9c')
    expect(cliSkillName('tool', 'com.example.tool', '')).toBe('tool-com-example-tool')
    const long = cliSkillName('tool', `com.example.${'very-long-name.'.repeat(8)}a`, '7f3a9c')
    const other = cliSkillName('tool', `com.example.${'very-long-name.'.repeat(8)}b`, '7f3a9c')
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toMatch(/^tool-com-example-very-long-name-.*-[0-9a-f]{8}-7f3a9c$/)
    expect(long).not.toBe(other)
  })

  it('says which command a description belongs to', () => {
    expect(cliSkillDescription('tickets', 'Query tickets.')).toBe('Companion skill for the tickets command-line tool. Query tickets.')
    expect(Array.from(cliSkillDescription('tickets', '工'.repeat(400)))).toHaveLength(CLI_SKILL_DESCRIPTION_MAX)
  })

  it('names the launcher by absolute path ahead of the guide, and nothing about sessions', () => {
    const body = renderCliSkill({
      toolId: 'com.example.tool', installId: '7f3a9c',
      launches: [{ command: 'tool', path: '/data/cli/tools/com.example.tool/bin/tool', cmdPath: 'C:\\data\\tool.cmd' }],
      guide: '# Example\nRun `tool list`.\n',
    })
    expect(body).toContain('- `tool`: `/data/cli/tools/com.example.tool/bin/tool`')
    expect(body).toContain('(cmd.exe and PowerShell: `C:\\data\\tool.cmd`)')
    expect(body.indexOf('/bin/tool')).toBeLessThan(body.indexOf('Run `tool list`.'))
    expect(body).toContain('install 7f3a9c')
    expect(body).not.toMatch(/HALO_CLI_TOOLS_BIN|TOOLS\.md|PATH/)
    expect(renderCliSkill({ toolId: 'x', installId: 'a', launches: [{ command: 'x', path: '/x' }] })).toContain('`--help`')
  })
})
