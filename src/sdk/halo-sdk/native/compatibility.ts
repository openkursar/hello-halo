import type { Options } from '../types/config.js';
import { attachHarness, baselineText } from '../harness/text.js';
import { createSession } from './session.js';

export { createSession as unstable_v2_createSession } from './session.js';
export async function unstable_v2_prompt(message: string, options: Options): Promise<Record<string, unknown>> {
  const session = await createSession(options);
  try {
    await session.send(message);
    for await (const event of session.stream()) if (event.type === 'result') return event as unknown as Record<string, unknown>;
    throw attachHarness(new Error(baselineText('context.error.missing_result')), 'context.error.missing_result');
  } finally { session.close(); }
}
export async function unstable_v2_resumeSession(sessionId: string, options: Parameters<typeof createSession>[0]): ReturnType<typeof createSession> {
  return createSession({ ...options, sessionId, resume: sessionId });
}
