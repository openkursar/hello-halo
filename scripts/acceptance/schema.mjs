import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { moduleSchema, storySchema, contractSchema, approvalSchema, bindingSchema } from '../../tests/acceptance/schemas/model.mjs'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
for (const [name, schema] of Object.entries({ module: moduleSchema, story: storySchema, contract: contractSchema, approval: approvalSchema, binding: bindingSchema })) {
  const filename = path.join(root, 'tests/acceptance/schemas', `${name}.schema.json`)
  const content = JSON.stringify(zodToJsonSchema(schema, { name, $refStrategy: 'none' }), null, 2) + '\n'
  if (process.argv.includes('--check')) {
    if (await fs.readFile(filename, 'utf8') !== content) throw new Error(`${name} schema is out of date; run npm run acceptance:schema`)
  } else await fs.writeFile(filename, content)
}
