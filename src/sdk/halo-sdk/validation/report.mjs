import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mib = bytes => typeof bytes === 'number' ? (bytes / 1024 / 1024).toFixed(2) : 'unavailable';
const cell = value => String(value ?? 'unavailable').replaceAll('|', '\\|').replaceAll('\n', ' ');

export async function writeReport(report, directory) {
  const lines = [
    '# SDK resource validation', '',
    `Result: **${report.passed ? 'PASS' : 'FAIL'}**. Profile: ${cell(report.profile)}. Provider: ${report.settings.live ? cell(report.settings.model) + ' (live API)' : 'scripted local HTTP/SSE peer'}.`, '',
    `Environment: ${cell(report.platform)}/${cell(report.arch)}, ${cell(report.node)}.`,
    `Provider protocol: ${report.settings.live ? cell(report.settings.providerType ?? 'anthropic') : 'openai-compat'}. Endpoint: ${report.settings.live ? cell(report.settings.baseUrl ?? 'https://api.deepseek.com/anthropic') : 'local fixture'}. Thinking: ${cell(report.settings.thinking ?? 'disabled')}. Effort: ${cell(report.settings.effort ?? 'SDK default')}. Maximum output tokens: ${report.settings.maxOutputTokens ?? 2048}.`,
    `Run: ${cell(report.startedAt)} to ${cell(report.finishedAt)}.`,
    `Source: ${cell(report.source.head)}; copied-source SHA-256: ${cell(report.source.snapshotSha256)}.`, '',
    `Requested load: ${report.settings.concurrency} concurrent sessions, at least ${report.settings.rounds} rounds and ${report.settings.durationSeconds} seconds; minimum batch interval ${report.settings.roundIntervalSeconds ?? 0} seconds.`, '',
    '| Scenario | Result | Completed rounds | Tool calls |',
    '|---|---|---:|---:|',
  ];
  for (const scenario of report.scenarios) {
    const checks = scenario.checks?.at(-1);
    lines.push(`| ${cell(scenario.scenario)} | ${scenario.passed ? 'PASS' : 'FAIL'} | ${checks?.rounds ?? '—'} | ${checks?.toolCalls ?? '—'} |`);
  }
  for (const scenario of report.scenarios) {
    if (scenario.resources) {
      const { observed, limits, unsupported } = scenario.resources;
      lines.push('', `## ${cell(scenario.scenario)} resources`, '',
        '| Measurement | Observed | Gate |', '|---|---:|---:|',
        `| Sampled peak RSS, including observed descendants | ${mib(observed.peakRssBytes)} MiB | ${mib(limits.peakRssBytes)} MiB |`,
        `| Retained heap change after closing sessions | ${mib(observed.retainedHeapGrowthBytes)} MiB | ${mib(limits.retainedHeapGrowthBytes)} MiB |`,
        `| Descriptor change | ${cell(observed.descriptorGrowth)} | ${limits.descriptorGrowth} |`,
        `| Maximum event-loop delay | ${observed.peakEventLoopDelayMs.toFixed(2)} ms | ${limits.peakEventLoopDelayMs} ms |`,
        `| Output disk peak | ${mib(observed.sandboxBytes)} MiB | ${mib(limits.sandboxBytes)} MiB |`, '',
        `Samples: ${scenario.samples.length} actor measurements, ${scenario.osSamples.length} independent supervisor measurements.`,
        `Unsupported measurements: ${unsupported.length ? unsupported.map(cell).join(', ') : 'none'}.`);
      const checks = scenario.checks?.at(-1);
      if (checks?.usage) {
        lines.push(`SDK-reported usage: ${checks.usage.input} uncached input tokens and ${checks.usage.output} output tokens (summary calls may be excluded).`);
        if (checks.usage.cacheRead !== undefined) lines.push(`Cache reads: ${checks.usage.cacheRead} tokens; cache creation: ${checks.usage.cacheCreation} tokens.`);
      }
      if (checks?.compactions !== undefined) lines.push(`Observed model compactions: ${checks.compactions}.`);
      if (scenario.compactionBudgetFailures !== undefined) lines.push(`Rejected over-budget summaries: ${scenario.compactionBudgetFailures}.`);
      if (checks?.previewMemory) lines.push(`Retained heap change for twenty large-file previews: ${mib(checks.previewMemory.retainedHeapGrowthBytes)} MiB.`);
    }
    if (scenario.errors.length) lines.push('', `## ${cell(scenario.scenario)} failures`, '', ...scenario.errors.map(error => `- ${cell(error)}`));
  }
  if (report.error) lines.push('', '## Harness failure', '', cell(report.error));
  lines.push('', '## Interpretation', '',
    'This report applies to the recorded source snapshot, machine, duration and workload. A short sampled peak can be missed. Explicit GC is used at labeled checkpoints. A passing run is not a guarantee for arbitrary workloads or longer operation.', '',
    'The full JSON report includes samples, exact gates and settings. See the validation README for resource ownership, OS coverage and the distinction between worker failure and host-process death.', '');
  await fs.writeFile(join(directory, 'report.md'), lines.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2]);
  await writeReport(JSON.parse(await fs.readFile(path, 'utf8')), dirname(path));
  console.log(join(dirname(path), 'report.md'));
}
