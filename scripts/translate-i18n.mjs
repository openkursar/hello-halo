#!/usr/bin/env node
/**
 * Auto-translate empty values in i18n files
 *
 * Usage:
 *   npm run i18n:translate          # Incremental (only empty values)
 *   npm run i18n:translate -- --force  # Full translation
 *
 * Environment variables (from .env.local):
 *   HALO_TEST_API_KEY - API Key
 *   HALO_TEST_API_URL - API URL
 *   HALO_TEST_MODEL   - Model name
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

// Load .env.local
function loadEnv() {
  const envPath = path.join(ROOT_DIR, '.env.local')
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env.local not found')
    process.exit(1)
  }

  const content = fs.readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [key, ...valueParts] = trimmed.split('=')
    if (key && valueParts.length > 0) {
      process.env[key] = valueParts.join('=')
    }
  }
}

// Configuration
const CONFIG = {
  localesDir: path.join(ROOT_DIR, 'src/renderer/i18n/locales'),
  sourceLocale: 'en',
  targetLocales: ['zh-CN', 'zh-TW', 'ja', 'es', 'fr', 'de'],
  batchSize: 50, // Keys per batch
  maxRetries: 3, // Retry count on failure
  retryDelayMs: 2000 // Retry delay in milliseconds
}

// Language name mapping
const LANG_NAMES = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  ja: 'Japanese (日本語)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)'
}

// Translation guidelines
const TRANSLATION_GUIDELINES = {
  'zh-CN': 'Use Mainland China conventions. Formal but friendly tone.',
  'zh-TW': 'Use Taiwan/Hong Kong conventions. 使用台灣用語。',
  ja: 'Use polite form (です/ます). Keep technical terms in katakana when appropriate.',
  es: 'Use Latin American neutral Spanish. Use informal "tú" form for UI.',
  fr: 'Use formal "vous" form.',
  de: 'Use formal "Sie" form.'
}

// Product context
const APP_CONTEXT = `
## Product Context
Halo is a desktop AI assistant application (similar to Cursor/Claude Desktop).

Key concepts:
- "Space" = A workspace/project folder where AI can read/write files (NOT outer space)
- "Artifacts" = AI-generated files like code, documents, spreadsheets (NOT archaeological artifacts)
- "Canvas" = The panel showing AI-generated content
- "MCP" = Model Context Protocol, a way to extend AI capabilities
- "Deep Thinking" = Extended reasoning mode for complex tasks

Features:
- AI Agent like claude code
- Built-in browser for AI to browse the web
- File read/write capabilities
- Terminal command execution
- Remote access via QR code

Target users: developers, creators, professionals
Tone: Professional, friendly, concise. Like a smart assistant.
`

// Read JSON file
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

// Write JSON file
function writeJson(filePath, data) {
  // Sort by key
  const sorted = Object.keys(data)
    .sort()
    .reduce((obj, key) => {
      obj[key] = data[key]
      return obj
    }, {})
  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + '\n')
}

// Find keys that need translation
function getKeysToTranslate(sourceJson, targetJson, force = false) {
  if (force) return Object.keys(sourceJson)
  return Object.keys(sourceJson).filter((key) => !targetJson[key] || targetJson[key] === '')
}

// Call LLM API for translation
async function translateBatch(texts, targetLocale) {
  const apiKey = process.env.HALO_TEST_API_KEY
  const apiUrl = process.env.HALO_TEST_API_URL
  const model = process.env.HALO_TEST_MODEL

  if (!apiKey || !apiUrl) {
    throw new Error('Missing HALO_TEST_API_KEY or HALO_TEST_API_URL in .env.local')
  }

  // Build examples
  const exampleInput = { "Save": "Save", "Space": "Space", "{{count}} files": "{{count}} files" }
  const exampleOutputs = {
    'zh-CN': { "Save": "保存", "Space": "空间", "{{count}} files": "{{count}} 个文件" },
    'zh-TW': { "Save": "儲存", "Space": "空間", "{{count}} files": "{{count}} 個檔案" },
    'ja': { "Save": "保存", "Space": "スペース", "{{count}} files": "{{count}} ファイル" },
    'es': { "Save": "Guardar", "Space": "Espacio", "{{count}} files": "{{count}} archivos" },
    'fr': { "Save": "Enregistrer", "Space": "Espace", "{{count}} files": "{{count}} fichiers" },
    'de': { "Save": "Speichern", "Space": "Bereich", "{{count}} files": "{{count}} Dateien" }
  }

  const prompt = `You are a professional translator for a software application.
${APP_CONTEXT}

## Task
Translate the following JSON from English to ${LANG_NAMES[targetLocale]}.

## Rules
1. Keep JSON keys unchanged, only translate values
2. Keep {{variables}} placeholders exactly as-is (e.g., {{count}}, {{name}})
3. Keep brand name "Halo" untranslated
4. Keep technical terms like "MCP", "API", "JSON" untranslated
5. ${TRANSLATION_GUIDELINES[targetLocale]}

## Output Format
You MUST wrap your response in a JSON code block like this:
\`\`\`json
{
  "key": "translated value"
}
\`\`\`

## Example
Input:
\`\`\`json
${JSON.stringify(exampleInput, null, 2)}
\`\`\`

Output:
\`\`\`json
${JSON.stringify(exampleOutputs[targetLocale], null, 2)}
\`\`\`

## Now translate this:
\`\`\`json
${JSON.stringify(texts, null, 2)}
\`\`\`
`

  const response = await fetch(`${apiUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 32768,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`API error: ${response.status} - ${error}`)
  }

  const data = await response.json()
  const content = data.content[0].text

  // Extract JSON (robust parsing)
  const parsed = extractJson(content)
  if (!parsed) {
    console.error('Failed to parse response:', content.substring(0, 500))
    throw new Error('Invalid JSON response from API')
  }

  return parsed
}

// Robust JSON extraction
function extractJson(content) {
  // Method 1: Extract ```json ``` code block
  const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)```/)
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim())
    } catch (e) {
      // Try other methods
    }
  }

  // Method 2: Extract any ``` ``` code block
  const codeBlockMatch = content.match(/```\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim())
    } catch (e) {
      // Try other methods
    }
  }

  // Method 3: Parse entire content directly
  try {
    return JSON.parse(content.trim())
  } catch (e) {
    // Try other methods
  }

  // Method 4: Find content between first { and last }
  const firstBrace = content.indexOf('{')
  const lastBrace = content.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(content.substring(firstBrace, lastBrace + 1))
    } catch (e) {
      // Parse failed
    }
  }

  return null
}

// Batch processing
function chunk(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

// Translation with retry
async function translateBatchWithRetry(texts, targetLocale, batchIndex, totalBatches) {
  let lastError = null

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const translated = await translateBatch(texts, targetLocale)
      return translated
    } catch (error) {
      lastError = error
      if (attempt < CONFIG.maxRetries) {
        console.log(`   ⚠ Batch ${batchIndex + 1}/${totalBatches} attempt ${attempt} failed: ${error.message}`)
        console.log(`     Retrying in ${CONFIG.retryDelayMs / 1000}s... (${CONFIG.maxRetries - attempt} retries left)`)
        await new Promise((r) => setTimeout(r, CONFIG.retryDelayMs))
      }
    }
  }

  // All retries failed
  throw lastError
}

// Main function
async function main() {
  loadEnv()

  const force = process.argv.includes('--force')
  const dryRun = process.argv.includes('--dry-run')

  console.log('\n🌍 i18n Auto Translator\n')
  console.log(`   Mode: ${force ? 'Force (translate all)' : 'Incremental (empty values only)'}`)
  console.log(`   API: ${process.env.HALO_TEST_API_URL}`)
  console.log(`   Model: ${process.env.HALO_TEST_MODEL}\n`)

  // Read source file
  const sourceFile = path.join(CONFIG.localesDir, `${CONFIG.sourceLocale}.json`)
  const sourceJson = readJson(sourceFile)
  const totalKeys = Object.keys(sourceJson).length

  console.log(`📖 Source: ${totalKeys} keys in en.json\n`)

  let totalTranslated = 0

  // Translate each language
  for (const locale of CONFIG.targetLocales) {
    const targetFile = path.join(CONFIG.localesDir, `${locale}.json`)
    const targetJson = readJson(targetFile)

    const keysToTranslate = getKeysToTranslate(sourceJson, targetJson, force)

    if (keysToTranslate.length === 0) {
      console.log(`✅ [${locale}] Complete (${totalKeys}/${totalKeys})`)
      continue
    }

    console.log(`🔄 [${locale}] Translating ${keysToTranslate.length} keys...`)

    if (dryRun) {
      console.log(`   (dry-run) Would translate: ${keysToTranslate.slice(0, 3).join(', ')}...`)
      continue
    }

    // Batch translation
    const batches = chunk(keysToTranslate, CONFIG.batchSize)
    let successCount = 0
    let failedKeys = []

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      const textsToTranslate = {}
      batch.forEach((key) => {
        textsToTranslate[key] = sourceJson[key]
      })

      try {
        const translated = await translateBatchWithRetry(textsToTranslate, locale, i, batches.length)
        Object.assign(targetJson, translated)
        successCount += batch.length
        console.log(`   ✓ Batch ${i + 1}/${batches.length}: ${batch.length} keys`)
      } catch (error) {
        console.error(`   ✗ Batch ${i + 1} failed after ${CONFIG.maxRetries} retries: ${error.message}`)
        failedKeys.push(...batch)
        // Continue to next batch
      }

      // Avoid rate limit
      if (i < batches.length - 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    // Report failed keys
    if (failedKeys.length > 0) {
      console.log(`   ⚠ ${failedKeys.length} keys failed, will retry on next run`)
    }

    // Write back to file
    writeJson(targetFile, targetJson)
    totalTranslated += successCount
    console.log(`✅ [${locale}] Done (${successCount}/${keysToTranslate.length} keys)\n`)
  }

  console.log('─'.repeat(40))
  console.log(`🎉 Translation complete! ${totalTranslated} keys translated.\n`)
}

main().catch((err) => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
