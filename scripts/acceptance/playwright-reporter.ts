import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter'
import { redact } from './lib/process.mjs'
import { beginEvidenceProducer, finishEvidenceProducer, assertEvidenceOutputWritable } from './lib/ci-evidence.mjs'

function bindings(test: TestCase) {
  return test.annotations.filter(annotation => annotation.type === 'acceptance').map(annotation => JSON.parse(annotation.description ?? ''))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  return value
}

function selection(tests: Array<Record<string, unknown>>) {
  return JSON.stringify(tests.map(test => canonical({ id: test.id, file: test.file, project: test.project, bindings: test.bindings ?? [] })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
}

export default class AcceptanceReporter implements Reporter {
  private root = process.env.HALO_ACCEPTANCE_ROOT ?? process.cwd()
  private output = process.env.HALO_ACCEPTANCE_REPORT

  constructor() {
    assertEvidenceOutputWritable(this.root, this.output)
    const producer = beginEvidenceProducer(this.root, 'playwright-reporter', { self: true })
    if (producer) process.once('exit', code => {
      try { finishEvidenceProducer(producer, { exitCode: code }) }
      catch (error) { console.error(`acceptance: reporter completion could not be recorded: ${error instanceof Error ? error.message : String(error)}`); if (!code) process.exitCode = 1 }
    })
  }

  printsToStdio() { return false }

  private emit(event: Record<string, unknown>) {
    if (!this.output) throw new Error('HALO_ACCEPTANCE_REPORT must name the acceptance discovery or event output')
    assertEvidenceOutputWritable(this.root, this.output)
    fs.mkdirSync(path.dirname(this.output), { recursive: true })
    const clean = (value: unknown): unknown => {
      if (typeof value === 'string') return redact(value, this.root)
      if (Array.isArray(value)) return value.map(clean)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]))
      return value
    }
    const fd = fs.openSync(this.output, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o640)
    try { fs.writeSync(fd, JSON.stringify(clean(event)) + '\n') } finally { fs.closeSync(fd) }
  }

  onBegin(config: FullConfig, suite: Suite) {
    this.root = process.env.HALO_ACCEPTANCE_ROOT ?? process.cwd()
    let tests
    try {
      tests = suite.allTests().map(test => ({
      id: test.id, title: test.title, titlePath: test.titlePath().slice(1), executor: 'playwright',
      file: path.relative(this.root, test.location.file).split(path.sep).join('/'),
      line: test.location.line, project: test.parent.project()?.name ?? '',
      expectedStatus: test.expectedStatus, bindings: bindings(test),
      }))
      if (process.env.HALO_ACCEPTANCE_SELECTION_FILE || process.env.HALO_ACCEPTANCE_SELECTION) {
        const expected = JSON.parse(process.env.HALO_ACCEPTANCE_SELECTION_FILE ? fs.readFileSync(process.env.HALO_ACCEPTANCE_SELECTION_FILE, 'utf8') : process.env.HALO_ACCEPTANCE_SELECTION!)
        if (!Array.isArray(expected) || selection(tests) !== selection(expected)) throw new Error('Discovered execution does not match the selected test plan and acceptance bindings')
      } else if (process.env.HALO_ACCEPTANCE_TEST_IDS) {
        throw new Error('Execution requires the full acceptance selection, not test IDs alone')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'error', message })
      console.error(redact(`acceptance: ${message}`, this.root))
      // Playwright catches reporter exceptions and still starts tests; selection refusal must stop the runner.
      process.exit(1)
    }
    this.emit({ type: 'begin', tests, workers: config.workers })
  }

  private attachment(attachment: TestResult['attachments'][number]) {
    const result = { name: attachment.name, contentType: attachment.contentType, path: '' }
    if (!this.output) return result
    let ownedTextFile: string | undefined
    try {
      const runDirectory = fs.realpathSync(path.dirname(this.output))
      if (!attachment.path) {
        if (!Buffer.isBuffer(attachment.body)) throw new Error('Attachment has neither a file nor an inline body')
        if (attachment.body.length > 16 * 1024 * 1024) throw new Error('Inline attachment exceeds the export limit')
        const directory = path.join(runDirectory, 'inline-attachments')
        fs.mkdirSync(directory, { recursive: true })
        if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Inline attachment directory is not owned by this run')
        const isText = /^text\//i.test(attachment.contentType) || /json|xml|yaml|javascript|svg/i.test(attachment.contentType)
        const extension = isText ? '.txt' : attachment.contentType === 'image/png' ? '.png' : attachment.contentType === 'image/jpeg' ? '.jpg' : '.bin'
        const target = path.join(directory, randomUUID() + extension)
        fs.writeFileSync(target, isText ? redact(attachment.body.toString('utf8'), this.root) : attachment.body, { flag: 'wx', mode: 0o600 })
        result.path = path.relative(runDirectory, target).split(path.sep).join('/')
        return result
      }
      const file = fs.realpathSync(attachment.path)
      const relative = path.relative(runDirectory, file)
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.lstatSync(attachment.path).isFile()) throw new Error('Attachment is outside the owned run directory or is not a regular file')
      const isText = /^text\//i.test(attachment.contentType) || /json|xml|yaml|javascript|svg/i.test(attachment.contentType) || /\.(?:txt|log|jsonl?|html?|xml|ya?ml|md|csv|har)$/i.test(file)
      if (isText) {
        ownedTextFile = file
        if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('Text attachment exceeds the redaction limit')
        fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8'), this.root))
      }
      if (redact(relative, this.root) !== relative) {
        const directory = path.join(runDirectory, 'redacted-attachments')
        fs.mkdirSync(directory, { recursive: true })
        const name = createHash('sha256').update(relative).digest('hex') + (isText ? '.txt' : '.bin')
        const target = path.join(directory, name)
        fs.renameSync(file, target)
        result.path = path.relative(runDirectory, target).split(path.sep).join('/')
      } else result.path = relative.split(path.sep).join('/')
    } catch (error) {
      if (ownedTextFile) {
        try { fs.writeFileSync(ownedTextFile, 'Acceptance evidence was omitted because it could not be safely redacted.\n') }
        catch {
          try { fs.unlinkSync(ownedTextFile) }
          catch (removeError) { this.emit({ type: 'error', message: `Unsafe text evidence could not be removed: ${removeError instanceof Error ? removeError.message : String(removeError)}` }) }
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'error', message: `Acceptance attachment export failed: ${message}` })
    }
    return result
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.emit({ type: 'test', id: test.id, title: test.title, bindings: bindings(test), expectedStatus: test.expectedStatus,
      status: result.status, retry: result.retry, duration: result.duration, startedAt: result.startTime.toISOString(),
      isolation: test.annotations.filter(annotation => annotation.type === 'acceptance-isolation').map(annotation => annotation.description),
      errors: result.errors.map(error => error.message ?? 'Unknown test failure'),
      attachments: result.attachments.map(attachment => this.attachment(attachment)),
    })
  }

  onError(error: { message?: string }) {
    this.emit({ type: 'error', message: error.message ?? 'Test runner error' })
  }

  onEnd(result: FullResult) {
    this.emit({ type: 'end', status: result.status, duration: result.duration })
  }
}
