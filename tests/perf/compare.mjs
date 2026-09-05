#!/usr/bin/env node
/**
 * Compares two labeled result sets under tests/perf/results/<label>/*.json
 * and prints a markdown table per scenario: metric × before × after × delta%.
 *
 * Usage:
 *   node tests/perf/compare.mjs <beforeLabel> <afterLabel>            (full, ~40 metrics/scenario)
 *   node tests/perf/compare.mjs <beforeLabel> <afterLabel> --summary  (6 metrics/scenario, report-ready)
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const resultsRoot = path.join(__dirname, 'results')

const args = process.argv.slice(2)
const summaryMode = args.includes('--summary')
const [beforeLabel, afterLabel] = args.filter((a) => !a.startsWith('--'))

if (!beforeLabel || !afterLabel) {
  console.error('Usage: node tests/perf/compare.mjs <beforeLabel> <afterLabel> [--summary]')
  process.exit(1)
}

// Electron's app.getAppMetrics() cpu.percentCPUUsage is normalized against
// total system capacity (100% = every core saturated), not against one core
// — we've already misread this once (6.97% read as "better than VS Code's
// 28.6%" when the real per-core-equivalent figure is 55.8%, i.e. worse).
// Every cpu.*/idleCpu.*Percent value gets converted to "% of one core" here
// so nobody downstream has to remember which convention a raw number is in.
const CORE_COUNT = os.cpus().length

function isCpuPercentMetric(metricPath) {
  return metricPath.startsWith('cpu.') || /idleCpu\.(avgPercent|maxPercent|first15AvgPercent)$/.test(metricPath)
}

function toPerCore(value, metricPath) {
  if (value === null || value === undefined || typeof value !== 'number') return value
  return isCpuPercentMetric(metricPath) ? value * CORE_COUNT : value
}

function loadLabel(label) {
  const dir = path.join(resultsRoot, label)
  if (!fs.existsSync(dir)) {
    console.error(`No results directory: ${dir}`)
    process.exit(1)
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  const byScenario = new Map()
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
    byScenario.set(data.scenario, data)
  }
  return byScenario
}

function fmt(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return 'n/a (unmeasured)'
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)
}

/**
 * WP7 harness audit P1-5: `null` means "the collector could not measure
 * this" (see types.ts), which must never be treated as the number 0 — that
 * would either compute a nonsense delta (arithmetic coerces null to 0) or,
 * if both sides happen to be null, print a clean "0%" that looks identical
 * to "measured twice, genuinely unchanged". Both are wrong in different
 * ways, so null is checked before any arithmetic runs.
 */
function deltaPct(before, after) {
  if (before === undefined || after === undefined) return 'n/a'
  if (before === null || after === null) return 'n/a (unmeasured)'
  if (before === 0) return after === 0 ? '0%' : 'n/a'
  const pct = ((after - before) / Math.abs(before)) * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

/** Flattens a PerfResult into a flat list of [metricPath, value] leaves. `null` is kept (not dropped) so "unmeasured" is visible instead of silently missing from the table. Arrays (e.g. idleCpu.samples) are intentionally skipped — raw sample arrays belong in the archived JSON, not a delta table. */
function flatten(obj, prefix = '') {
  const rows = []
  for (const [key, value] of Object.entries(obj)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      rows.push(...flatten(value, nextPrefix))
    } else if (typeof value === 'number' || value === null) {
      rows.push([nextPrefix, value])
    }
  }
  return rows
}

function samplingNote(result) {
  if (!result?.sampling) return null
  const { plannedTicks, succeededTicks } = result.sampling
  if (plannedTicks > 0 && succeededTicks < plannedTicks) {
    return `sampling: ${succeededTicks}/${plannedTicks} process-metrics ticks succeeded`
  }
  return null
}

// Per Lead: the report needs a 6-metric-per-scenario view, not the full
// ~40-metric dump — durationMs (user wait), longtask.maxMs (freeze length,
// closest to "卡"), nodes.delta (DOM scale / virtualization evidence),
// mem.byProcessType.renderer.deltaMB (memory cost), idleCpu.first15AvgPercent
// (the render "tail" — this is what an optimization should shorten), plus a
// trust line (status/valid/crashCount) so nobody reads a number that came
// from a crashed run as if it were real.
const SUMMARY_METRICS = [
  ['durationMs', 'durationMs'],
  ['longtask.maxMs', 'longtask.maxMs'],
  ['nodes.delta', 'nodes.delta'],
  ['mem.byProcessType.renderer.deltaMB', 'mem.renderer.deltaMB'],
  ['idleCpu.first15AvgPercent', 'idleCpu.first15AvgPercent (% of one core)']
]

const beforeByScenario = loadLabel(beforeLabel)
const afterByScenario = loadLabel(afterLabel)

const scenarios = new Set([...beforeByScenario.keys(), ...afterByScenario.keys()])
const missingBefore = [...scenarios].filter((s) => !beforeByScenario.has(s))
const missingAfter = [...scenarios].filter((s) => !afterByScenario.has(s))

const lines = []
lines.push(`# Perf comparison: ${beforeLabel} → ${afterLabel}${summaryMode ? ' (summary)' : ''}`)
lines.push('')
lines.push(`CPU metrics below are converted to **% of one core** (raw Electron value × ${CORE_COUNT} cores on this machine) — the raw \`getAppMetrics()\` value is normalized against total system capacity and reads as deceptively low otherwise.`)
lines.push('')
lines.push(`**⚠️ DOM node counts (\`nodes.*\`) are only comparable within the same kind of screen** — e.g. S5's file types against each other (all "opened one file in the canvas"). S1 (Home page) vs S4/S5/S6 (chat+canvas view) is not a valid comparison; they are different screens by definition, not a virtualization regression. This table diffs the same scenario across labels, which is always valid — the warning is for anyone eyeballing raw numbers across *different* scenario rows.`)
lines.push('')
// WP7 harness audit P1-9: a scenario that hung so badly the test itself
// timed out never gets a JSON written — previously that only showed up as
// one easy-to-miss line buried in its own section. A totally missing
// scenario and a totally healthy one looked equally unremarkable in a long
// table; this line in front makes "we lost data" impossible to scroll past.
lines.push(`**Scenario coverage**: ${beforeLabel} ${beforeByScenario.size}/${scenarios.size}` +
  `${missingBefore.length ? ` (missing: ${missingBefore.join(', ')})` : ''}, ` +
  `${afterLabel} ${afterByScenario.size}/${scenarios.size}` +
  `${missingAfter.length ? ` (missing: ${missingAfter.join(', ')})` : ''}`)
lines.push('')

for (const scenario of [...scenarios].sort()) {
  const before = beforeByScenario.get(scenario)
  const after = afterByScenario.get(scenario)
  lines.push(`## ${scenario}`)
  lines.push('')

  if (!before || !after) {
    lines.push(`Missing in ${!before ? beforeLabel : afterLabel} — skipped.`)
    lines.push('')
    continue
  }

  // status:'skipped' (e.g. no API key/mock configured) — surface it
  // explicitly rather than let it fall through into the numeric table as a
  // wall of zeros/nulls.
  if (before.status === 'skipped' || after.status === 'skipped') {
    const culprit = before.status === 'skipped' && after.status === 'skipped'
      ? `${beforeLabel} and ${afterLabel}`
      : before.status === 'skipped' ? beforeLabel : afterLabel
    lines.push(`**跳过** — ${culprit}: ${(before.status === 'skipped' ? before.note : after.note) ?? 'no reason recorded'}`)
    lines.push('')
    continue
  }

  // valid === false means the renderer got silently reloaded/crashed
  // mid-scenario — every buffer this harness reads reset partway through,
  // so any % delta computed from these numbers would be comparing "how bad
  // it got before it reloaded" against noise, not a real measurement.
  if (before.valid === false || after.valid === false) {
    const culprit = before.valid === false && after.valid === false
      ? `${beforeLabel} and ${afterLabel}`
      : before.valid === false ? beforeLabel : afterLabel
    lines.push(`**触发无响应恢复/崩溃，数据不可用** — renderer reloaded or crashed during ${culprit} ` +
      `(rendererReloads: before=${before.rendererReloads ?? 'n/a'}, after=${after.rendererReloads ?? 'n/a'}; ` +
      `crashCount: before=${before.crashCount ?? 'n/a'}, after=${after.crashCount ?? 'n/a'}). ` +
      `Not included in the delta table below.`)
    lines.push('')
    lines.push(`| metric | before | after |`)
    lines.push(`|---|---|---|`)
    lines.push(`| durationMs | ${fmt(before.durationMs)} | ${fmt(after.durationMs)} |`)
    lines.push(`| unresponsiveCount | ${fmt(before.unresponsiveCount)} | ${fmt(after.unresponsiveCount)} |`)
    lines.push(`| rendererReloads | ${fmt(before.rendererReloads)} | ${fmt(after.rendererReloads)} |`)
    lines.push(`| crashCount | ${fmt(before.crashCount)} | ${fmt(after.crashCount)} |`)
    lines.push('')
    continue
  }

  const beforeWarn = samplingNote(before)
  const afterWarn = samplingNote(after)
  if (beforeWarn || afterWarn || before.warnings?.length || after.warnings?.length) {
    lines.push('⚠️ data-quality warnings:')
    if (beforeWarn) lines.push(`- ${beforeLabel}: ${beforeWarn}`)
    if (afterWarn) lines.push(`- ${afterLabel}: ${afterWarn}`)
    for (const w of before.warnings ?? []) lines.push(`- ${beforeLabel}: ${w}`)
    for (const w of after.warnings ?? []) lines.push(`- ${afterLabel}: ${w}`)
    lines.push('')
  }

  const beforeFlat = new Map(flatten(before))
  const afterFlat = new Map(flatten(after))

  lines.push(`data quality: valid=${before.valid}/${after.valid}, status=${before.status ?? 'ok'}/${after.status ?? 'ok'}, ` +
    `crashCount=${before.crashCount ?? 0}/${after.crashCount ?? 0}, ` +
    `loadAverage(1m)=${before.loadAverage?.[0]?.toFixed(2) ?? 'n/a'}/${after.loadAverage?.[0]?.toFixed(2) ?? 'n/a'}`)
  lines.push('')

  lines.push('| metric | before | after | delta |')
  lines.push('|---|---|---|---|')

  if (summaryMode) {
    for (const [metric, label] of SUMMARY_METRICS) {
      const b = toPerCore(beforeFlat.has(metric) ? beforeFlat.get(metric) : undefined, metric)
      const a = toPerCore(afterFlat.has(metric) ? afterFlat.get(metric) : undefined, metric)
      lines.push(`| ${label} | ${fmt(b)} | ${fmt(a)} | ${deltaPct(b, a)} |`)
    }
  } else {
    const metrics = new Set([...beforeFlat.keys(), ...afterFlat.keys()])
    for (const metric of [...metrics].sort()) {
      const b = toPerCore(beforeFlat.has(metric) ? beforeFlat.get(metric) : undefined, metric)
      const a = toPerCore(afterFlat.has(metric) ? afterFlat.get(metric) : undefined, metric)
      lines.push(`| ${metric} | ${fmt(b)} | ${fmt(a)} | ${deltaPct(b, a)} |`)
    }
  }
  lines.push('')
}

const markdown = lines.join('\n')
console.log(markdown)
