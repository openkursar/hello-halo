import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './metrics.mjs';

const samples = [
  { label: 'baseline', rss: 100_000_000, heapUsed: 10_000_000, eventLoopMaxMs: 20 },
  { label: 'final', rss: 100_000_000, heapUsed: 11_000_000, eventLoopMaxMs: 20 },
];
const osSamples = [
  { label: 'baseline', treeRss: 100_000_000, descriptors: 20, disk: { bytes: 1000 } },
  { label: 'final', treeRss: 100_000_000, descriptors: 20, disk: { bytes: 2000 } },
];

test('missing final memory evidence cannot pass', () => {
  assert.ok(evaluate(samples.slice(0, 1), osSamples, 'smoke').failures.includes('missing-retained-memory-samples'));
});

test('the independent sampler can fail RSS even if actor samples look healthy', () => {
  const observed = [...osSamples, { treeRss: 1024 ** 3, descriptors: 20, disk: { bytes: 2000 } }];
  assert.ok(evaluate(samples, observed, 'smoke').failures.includes('peakRssBytes'));
});

test('unsupported descriptor measurements cannot pass a soak', () => {
  const observed = osSamples.map(sample => ({ ...sample, descriptors: null }));
  assert.ok(evaluate(samples, observed, 'soak').failures.includes('unsupported-descriptor-measurement'));
});
