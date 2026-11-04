import express, { type RequestHandler } from 'express'

/** Skill packages carry bounded binary resources as base64; other JSON endpoints keep their existing limit. */
export function isSkillRequest(path: string): boolean {
  return path.startsWith('/api/skills/')
}

export const parseSkillBody: RequestHandler = express.json({ limit: '48mb' })
