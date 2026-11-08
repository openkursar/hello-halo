import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Page } from '@playwright/test'
import type { RpcClient, RpcResponse } from '../../../src/shared/rpc/define'
import type { skillsRpc } from '../../../src/shared/rpc/contracts/skills.contract'
import type { SkillCopy, SkillImportInput, SkillRef } from '../../../src/shared/types/skills'
import { expect } from '@playwright/test'

type SkillsClient = RpcClient<typeof skillsRpc>

export async function skillRequest<K extends keyof SkillsClient>(
  page: Page,
  method: K,
  input: Parameters<SkillsClient[K]>[0],
): Promise<Awaited<ReturnType<SkillsClient[K]>>> {
  return page.evaluate(async ({ method, input }) => {
    const api = (window as unknown as { halo: SkillsClient }).halo
    const call = api[method] as (input: unknown) => Promise<RpcResponse<unknown>>
    if (typeof call !== 'function') throw new Error(`Missing production skill API: ${method}`)
    return call(input)
  }, { method, input }) as Promise<Awaited<ReturnType<SkillsClient[K]>>>
}

export function requireSkillData<T>(result: RpcResponse<T>): T {
  expect(result.success, result.error ?? 'The production skill operation must succeed').toBe(true)
  expect(result.data).toBeDefined()
  return result.data!
}

export function skillRef(copy: SkillCopy, spaceId: string | null = copy.spaceId): SkillRef {
  return { spaceId, id: copy.id }
}

export function skillMarkdown(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Inspect isolated acceptance evidence\nuser-invocable: true\nx-acceptance-metadata: preserve-me\n---\n\n${body}\n`
}

export function skillImport(spaceId: string | null, name: string, body: string): SkillImportInput {
  return {
    spaceId,
    requestId: randomUUID(),
    spec: {
      spec_version: '1.0', type: 'skill', name, display_name: name,
      description: 'Inspect isolated acceptance evidence',
      version: '1.0.0', author: 'Acceptance author',
      skill_files: {
        'SKILL.md': skillMarkdown(name, body),
        'references/nested/evidence.md': 'Preserve this supporting evidence.\n',
      },
      skill_assets: {
        'templates/evidence.bin': { encoding: 'base64', content: Buffer.from([0, 255, 128, 13, 10, 0, 42]).toString('base64') },
      },
    },
  }
}

export function ownedSkillFile(profile: string, copy: SkillCopy): string {
  const file = copy.path
  const owned = relative(realpathSync(profile), realpathSync(file))
  expect(owned.length > 0 && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`), 'Skill writes must remain inside the isolated profile').toBe(true)
  return file
}

export function readSkillPackage(profile: string, copy: SkillCopy) {
  const file = ownedSkillFile(profile, copy)
  return {
    content: readFileSync(file, 'utf8'),
    reference: readFileSync(join(dirname(file), 'references/nested/evidence.md'), 'utf8'),
    binary: readFileSync(join(dirname(file), 'templates/evidence.bin')).toString('base64'),
  }
}
