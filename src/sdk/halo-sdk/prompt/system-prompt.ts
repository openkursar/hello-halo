/**
 * @module prompt/system-prompt
 * System prompt assembly — combines cacheable and dynamic sections.
 * @license MIT
 */

import type { Tool } from '../types/tool.js';
import type { PromptProfileSelection } from '../types/config.js';
import { PROMPT_CACHE_BOUNDARY } from './constants.js';
import { resolvePromptProfile } from './profiles/index.js';
import {
  identitySection,
  howYouWorkSection,
  computerSafetySection,
  runtimeSection,
  toolUseSection,
  communicatingSection,
  sessionGuidanceSection,
  windowsShellSection,
  environmentInfoSection,
} from './sections.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemPromptConfig {
  /** Enabled tools; decides which tool-specific guidance lines are included. */
  tools: Tool[];
  /** Current working directory */
  cwd: string;
  /** Platform string (e.g. 'darwin', 'linux', 'win32') */
  platform?: string;
  /**
   * Current git branch (optional), shown in the environment block. Full git
   * status is delivered separately via `buildSystemContextMessage()`.
   */
  gitBranch?: string;
  /** Model identifier */
  model: string;
  promptProfile?: PromptProfileSelection;
  ultraEffort?: boolean;
  /**
   * Pre-loaded memory content (raw concatenation, no path headers), injected
   * inside a `<memory>` block. For the path-annotated format use
   * `buildUserContextMessage()` instead.
   */
  memoryContent?: string;
  /** MCP server instructions */
  mcpInstructions?: string;
  /** Custom text appended to the end of the prompt */
  customAppend?: string;
  /** Complete system prompt replacement (skips all default sections) */
  customReplace?: string;
}

// ---------------------------------------------------------------------------
// Main assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the complete system prompt string.
 *
 * Section order:
 * ```
 * [CACHEABLE — before the dynamic boundary]
 * ├── Identity
 * ├── # How you work
 * ├── # Safety on the user's computer
 * ├── # The system you run in
 * ├── # Using tools (tool-conditional lines)
 * └── # Communicating
 *
 * __HALO_PROMPT_CACHE_BOUNDARY__
 *
 * [DYNAMIC — after the boundary]
 * ├── # Session guidance (tool-conditional)
 * ├── # Windows shell notes (win32 only)
 * ├── # Environment
 * ├── <memory> (if any)
 * ├── MCP instructions (if any)
 * └── Custom append (if any)
 * ```
 */
export function assembleSystemPrompt(config: SystemPromptConfig): string {
  return createSystemPromptBuilder(config)(config.model);
}

/** Keep environment probes outside model switches and reuse the current compiled prompt. */
export function createSystemPromptBuilder(
  config: Omit<SystemPromptConfig, 'model'>,
): (model: string) => string {
  if (config.customReplace !== undefined) {
    return () => `${config.customReplace}\n\n${PROMPT_CACHE_BOUNDARY}`;
  }

  const environment = environmentInfoSection({
    cwd: config.cwd,
    platform: config.platform,
    gitBranch: config.gitBranch,
  });
  let previousModel: string | undefined;
  let previousPrompt = '';
  return (model) => {
    if (model !== previousModel) {
      previousPrompt = assemblePreset({ ...config, model }, environment);
      previousModel = model;
    }
    return previousPrompt;
  };
}

function assemblePreset(config: SystemPromptConfig, environment: string): string {
  const profile = resolvePromptProfile(config.model, config.promptProfile);

  const parts: string[] = [
    identitySection(),
    howYouWorkSection(config.ultraEffort),
    computerSafetySection(),
    runtimeSection(),
    toolUseSection(config.tools),
    communicatingSection(),
    ...(profile.conversationGuidance ? [profile.conversationGuidance] : []),
    PROMPT_CACHE_BOUNDARY,
  ];

  const sessionGuidance = sessionGuidanceSection(config.tools);
  if (sessionGuidance) parts.push(sessionGuidance);

  if ((config.platform ?? process.platform) === 'win32') {
    parts.push(windowsShellSection());
  }

  parts.push(`${environment}\n - You are powered by the model ${config.model}.`);

  if (config.memoryContent) {
    parts.push(`<memory>\n${config.memoryContent}\n</memory>`);
  }
  if (config.mcpInstructions) {
    parts.push(config.mcpInstructions);
  }
  if (config.customAppend) {
    parts.push(config.customAppend);
  }

  return parts.join('\n\n');
}

/**
 * Split a system prompt string at the dynamic boundary for prompt caching.
 *
 * Returns `[cacheablePart, dynamicPart]`.
 * If the boundary is not found, the entire prompt is treated as cacheable.
 */
export function splitAtBoundary(
  prompt: string,
): [cacheable: string, dynamic: string] {
  const idx = prompt.indexOf(PROMPT_CACHE_BOUNDARY);
  if (idx === -1) {
    return [prompt, ''];
  }
  const cacheable = prompt.slice(0, idx).trimEnd();
  const dynamic = prompt
    .slice(idx + PROMPT_CACHE_BOUNDARY.length)
    .trimStart();
  return [cacheable, dynamic];
}
