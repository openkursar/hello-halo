import { fileURLToPath } from 'node:url'

/** Seed workers are CommonJS; these public, engine-independent SDK entries must be bundled. */
export const seedSdkAliases = Object.fromEntries([
  '@hello-halo/agent-sdk/collaboration',
  '@hello-halo/agent-sdk/collaboration/protocol',
  '@hello-halo/agent-sdk/collaboration/turn-gate',
  '@hello-halo/agent-sdk/collaboration/workspaces',
].map(name => [name, fileURLToPath(import.meta.resolve(name))]))
