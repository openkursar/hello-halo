/**
 * Tests for llm/tool-calling/mode-detection.ts
 * @license MIT
 */

import { describe, it, expect } from 'vitest';
import { resolveToolCallingMode, detectModelFamily } from './mode-detection.js';

// ---------------------------------------------------------------------------
// detectModelFamily
// ---------------------------------------------------------------------------

describe('detectModelFamily', () => {
  it('detects anthropic for claude- prefix', () => {
    expect(detectModelFamily('claude-sonnet-4-6')).toBe('anthropic');
    expect(detectModelFamily('claude-opus-4')).toBe('anthropic');
    expect(detectModelFamily('claude-haiku-3-5')).toBe('anthropic');
  });

  it('detects openai for gpt- prefix', () => {
    expect(detectModelFamily('gpt-4o')).toBe('openai');
    expect(detectModelFamily('gpt-3.5-turbo')).toBe('openai');
  });

  it('detects openai for o-series prefix', () => {
    expect(detectModelFamily('o1-mini')).toBe('openai');
    expect(detectModelFamily('o3')).toBe('openai');
    expect(detectModelFamily('o4-mini')).toBe('openai');
    expect(detectModelFamily('chatgpt-4o')).toBe('openai');
  });

  it('detects google for gemini prefix', () => {
    expect(detectModelFamily('gemini-pro')).toBe('google');
    expect(detectModelFamily('gemini-1.5-flash')).toBe('google');
  });

  it('detects deepseek for deepseek prefix', () => {
    expect(detectModelFamily('deepseek-r1')).toBe('deepseek');
    expect(detectModelFamily('deepseek-v2')).toBe('deepseek');
  });

  it('detects qwen for qwen prefix', () => {
    expect(detectModelFamily('qwen-turbo')).toBe('qwen');
    expect(detectModelFamily('qwen2.5-72b')).toBe('qwen');
  });

  it('detects glm for glm prefix', () => {
    expect(detectModelFamily('glm-4')).toBe('glm');
    expect(detectModelFamily('chatglm3-6b')).toBe('glm');
  });

  it('detects kimi for kimi/moonshot prefix', () => {
    expect(detectModelFamily('kimi-k1.5')).toBe('kimi');
    expect(detectModelFamily('moonshot-v1-8k')).toBe('kimi');
  });

  it('detects minimax for minimax/abab prefix', () => {
    expect(detectModelFamily('minimax-text-01')).toBe('minimax');
    expect(detectModelFamily('abab6.5s-chat')).toBe('minimax');
  });

  it('detects glm in multi-segment provider paths', () => {
    expect(detectModelFamily('Pro/zai-org/GLM-5')).toBe('glm');
    expect(detectModelFamily('zhipu/chatglm-pro')).toBe('glm');
  });

  it('returns unknown for unrecognized models', () => {
    expect(detectModelFamily('llama-3-70b')).toBe('unknown');
    expect(detectModelFamily('phi-3-mini')).toBe('unknown');
    expect(detectModelFamily('mistral-7b')).toBe('unknown');
  });

  it('handles OpenRouter provider/model format — strips provider prefix', () => {
    expect(detectModelFamily('anthropic/claude-sonnet-4')).toBe('anthropic');
    expect(detectModelFamily('openai/gpt-4o')).toBe('openai');
    expect(detectModelFamily('deepseek/deepseek-r1')).toBe('deepseek');
    expect(detectModelFamily('google/gemini-pro')).toBe('google');
  });

  it('is case-insensitive', () => {
    expect(detectModelFamily('CLAUDE-sonnet')).toBe('anthropic');
    expect(detectModelFamily('DeepSeek-r1')).toBe('deepseek');
    expect(detectModelFamily('QWEN-turbo')).toBe('qwen');
  });
});

// ---------------------------------------------------------------------------
// resolveToolCallingMode
// ---------------------------------------------------------------------------

describe('resolveToolCallingMode', () => {
  // Native-mode models
  it('uses native for Claude', () => {
    expect(resolveToolCallingMode('claude-sonnet-4-6')).toBe('native');
    expect(resolveToolCallingMode('claude-opus-4')).toBe('native');
  });

  it('uses native for GPT', () => {
    expect(resolveToolCallingMode('gpt-4o')).toBe('native');
  });

  it('uses native for o-series', () => {
    expect(resolveToolCallingMode('o1-mini')).toBe('native');
    expect(resolveToolCallingMode('o3')).toBe('native');
  });

  it('uses native for Gemini', () => {
    expect(resolveToolCallingMode('gemini-pro')).toBe('native');
  });

  it('uses native for DeepSeek', () => {
    expect(resolveToolCallingMode('deepseek-r1')).toBe('native');
    expect(resolveToolCallingMode('deepseek-v2')).toBe('native');
  });

  it('uses native for Qwen', () => {
    expect(resolveToolCallingMode('qwen-turbo')).toBe('native');
  });

  it('uses native for GLM', () => {
    expect(resolveToolCallingMode('glm-4')).toBe('native');
    expect(resolveToolCallingMode('chatglm3-6b')).toBe('native');
  });

  it('uses native for Kimi / Moonshot', () => {
    expect(resolveToolCallingMode('kimi-k1.5')).toBe('native');
    expect(resolveToolCallingMode('moonshot-v1')).toBe('native');
  });

  it('uses native for MiniMax / ABAB', () => {
    expect(resolveToolCallingMode('minimax-text-01')).toBe('native');
    expect(resolveToolCallingMode('abab5')).toBe('native');
  });

  it('falls back to native for unknown models', () => {
    expect(resolveToolCallingMode('llama-3-70b')).toBe('native');
    expect(resolveToolCallingMode('phi-3-mini')).toBe('native');
    expect(resolveToolCallingMode('totally-unknown-model')).toBe('native');
  });

  // Explicit override
  it('respects explicit native override for domestic model', () => {
    expect(resolveToolCallingMode('deepseek-r1', { toolCallingMode: 'native' })).toBe('native');
    expect(resolveToolCallingMode('qwen-turbo', { toolCallingMode: 'native' })).toBe('native');
  });

  it('respects explicit xml override for Claude', () => {
    expect(resolveToolCallingMode('claude-sonnet-4-6', { toolCallingMode: 'xml' })).toBe('xml');
  });

  it('ignores undefined toolCallingMode option', () => {
    expect(resolveToolCallingMode('claude-sonnet', { toolCallingMode: undefined })).toBe('native');
    expect(resolveToolCallingMode('deepseek-r1', { toolCallingMode: undefined })).toBe('native');
  });

  // OpenRouter format
  it('handles OpenRouter format', () => {
    expect(resolveToolCallingMode('anthropic/claude-sonnet-4')).toBe('native');
    expect(resolveToolCallingMode('deepseek/deepseek-r1')).toBe('native');
  });
});
