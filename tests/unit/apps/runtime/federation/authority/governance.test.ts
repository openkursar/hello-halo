/**
 * Unit tests for authority/governance -- invite governance policy.
 *
 * Pure decisions; no store required.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateAdmission,
  canMintInvite,
} from '../../../../../../src/main/apps/runtime/federation/authority/governance'
import { DEFAULT_OFFICE_SCOPE, type OfficeScope } from '../../../../../../src/main/apps/federation/types'

describe('authority/governance', () => {
  describe('evaluateAdmission (AC-7.4)', () => {
    it('approval-free policy admits a consented newcomer (positive)', () => {
      expect(evaluateAdmission({ policy: { requireApproval: false }, isCreatorOnline: true })).toBe('admit')
    })

    it('approval-required queues even when the creator is offline (negative — not auto-admitted)', () => {
      expect(evaluateAdmission({ policy: { requireApproval: true }, isCreatorOnline: false })).toBe(
        'await-approval',
      )
    })

    it('approval-required queues while the creator is online too', () => {
      expect(evaluateAdmission({ policy: { requireApproval: true }, isCreatorOnline: true })).toBe(
        'await-approval',
      )
    })

    it('creator presence never flips an approval-free admit', () => {
      expect(evaluateAdmission({ policy: { requireApproval: false }, isCreatorOnline: false })).toBe('admit')
    })
  })

  describe('canMintInvite (AC-7.4)', () => {
    it('a re-invite-capable scope may mint an invite (positive)', () => {
      expect(canMintInvite(DEFAULT_OFFICE_SCOPE)).toBe(true)
    })

    it('a scope without re-invite right may not (negative)', () => {
      const scope: OfficeScope = { ...DEFAULT_OFFICE_SCOPE, canReinvite: false }
      expect(canMintInvite(scope)).toBe(false)
    })
  })
})
