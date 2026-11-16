export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 529 || status >= 500 && status < 600;
}

export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return error.message;
  const detail = (cause as { code?: unknown }).code ?? cause.message;
  if (typeof detail !== 'string' || !detail || error.message.includes(detail)) return error.message;
  return `${error.message} (${detail})`;
}
