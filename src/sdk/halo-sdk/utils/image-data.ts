/** Shared decoded-image size policy for file and MCP inputs. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** Validate padded base64 without allocating the decoded image. */
export function decodedImageBytes(data: string): number | null {
  if (data.length === 0 || data.length % 4 !== 0) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const body = data.slice(0, data.length - padding);
  if (/[^A-Za-z0-9+/]/.test(body)) return null;
  return data.length / 4 * 3 - padding;
}
