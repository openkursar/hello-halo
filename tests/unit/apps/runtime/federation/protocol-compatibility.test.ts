import { describe, expect, it } from 'vitest'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/shared/federation/protocol-version'
import { isSameProtocol, M2_FRAME_KINDS } from '../../../../../src/main/apps/runtime/federation/protocol-m2'

describe('ordinary office protocol compatibility', () => {
  it('retains protocol 4 without participant or recipient-ticket control frames', () => {
    expect(FEDERATION_PROTOCOL_VERSION).toBe(4)
    expect(isSameProtocol(4)).toBe(true)
    expect(isSameProtocol(7)).toBe(false)
    for (const kind of ['participant-status', 'recipient-fence-request', 'recipient-fence-response']) {
      expect(M2_FRAME_KINDS.has(kind)).toBe(false)
    }
    for (const kind of ['stop-turn-request', 'stop-turn-response', 'blackboard-replicate', 'catchup-request']) {
      expect(M2_FRAME_KINDS.has(kind)).toBe(true)
    }
  })
})
