/**
 * The federation protocol version. Two nodes federate only when they run the
 * same one: the authority refuses a join from any other version, and a joiner
 * refuses an authority that grants another. Bump it to ship a breaking protocol
 * change (see "Compatibility policy" in apps/runtime/federation/DESIGN.md).
 */
export const FEDERATION_PROTOCOL_VERSION = 4
