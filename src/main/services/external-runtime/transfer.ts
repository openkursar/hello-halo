import { proxyFetch } from '../proxy-fetch';
import { RuntimeError } from './errors';
export const MAX_BINARY_BYTES = 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
const effectiveUrls = new WeakMap<Response, string>();
export function transferAbortError(signal: AbortSignal): RuntimeError {
  return signal.reason instanceof RuntimeError ? signal.reason : new RuntimeError('cancelled');
}
function networkError(cause: unknown): RuntimeError {
  const error = cause as {
    code?: string;
    cause?: {
      code?: string;
    };
  };
  return new RuntimeError(/TIMEOUT|TIMEDOUT/.test(error?.code || error?.cause?.code || '') ? 'source-timeout' : 'source-unreachable', {
    cause
  });
}
export function validateTransferUrl(input: string, requireHttps = false): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RuntimeError('invalid-source');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || requireHttps && url.protocol !== 'https:') {
    throw new RuntimeError('invalid-source');
  }
  return url;
}
export async function responseBody(url: string, signal: AbortSignal, metadata = false): Promise<Response> {
  let current = validateTransferUrl(url);
  let secure = current.protocol === 'https:';
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (signal.aborted) {
      throw transferAbortError(signal);
    }
    let response: Response;
    try {
      response = await proxyFetch(current.toString(), {
        signal,
        redirect: 'manual'
      });
    } catch (cause) {
      if (signal.aborted) {
        throw transferAbortError(signal);
      }
      throw networkError(cause);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) {
        throw new RuntimeError('source-unreachable');
      }
      let next: URL;
      try {
        next = validateTransferUrl(new URL(location, current).toString(), secure);
      } catch {
        throw new RuntimeError('invalid-source');
      }
      current = next;
      secure ||= next.protocol === 'https:';
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if ([401, 403, 407].includes(response.status)) {
        throw new RuntimeError('source-unauthorized');
      }
      if ([408, 504].includes(response.status)) {
        throw new RuntimeError('source-timeout');
      }
      if (response.status === 404 && metadata) {
        throw new RuntimeError('version-not-found');
      }
      if (response.status >= 500 || response.status === 429) {
        throw new RuntimeError('source-unreachable');
      }
      throw new RuntimeError(metadata ? 'invalid-manifest' : 'download-failed');
    }
    effectiveUrls.set(response, current.toString());
    return response;
  }
  throw new RuntimeError('source-unreachable');
}
export async function readMetadata(url: string, signal: AbortSignal): Promise<string> {
  return (await readMetadataResponse(url, signal)).text;
}
export async function readMetadataResponse(url: string, signal: AbortSignal): Promise<{ text: string; url: string }> {
  const response = await responseBody(url, signal, true);
  const reader = response.body!.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abort, {
    once: true
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failure: unknown;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) {
        break;
      }
      bytes += next.value.length;
      if (bytes > MAX_METADATA_BYTES) {
        throw new RuntimeError('invalid-manifest');
      }
      chunks.push(Buffer.from(next.value));
    }
    signal.throwIfAborted();
    return { text: Buffer.concat(chunks).toString('utf8'), url: effectiveUrls.get(response)! };
  } catch (error) {
    failure = error;
    if (signal.aborted) {
      throw transferAbortError(signal);
    }
    if (error instanceof RuntimeError) {
      throw error;
    }
    throw networkError(error);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(error => {
      if (error !== failure) {
        console.warn('[ExternalRuntime] Metadata stream cleanup failed', {
          name: (error as Error).name
        });
      }
    });
  }
}
