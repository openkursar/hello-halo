const CAPTURE_CHARS = 64 * 1024;

/** Keeps command diagnostics without retaining everything a process prints. */
export class OutputBuffer {
  private head = '';
  private tail: string[] = [];
  private tailLength = 0;
  private total = 0;

  append(chunk: string): void {
    this.total += chunk.length;
    const headRemaining = CAPTURE_CHARS / 2 - this.head.length;
    if (headRemaining > 0) {
      this.head += chunk.slice(0, headRemaining);
      chunk = chunk.slice(headRemaining);
    }
    if (!chunk) return;
    this.tail.push(chunk);
    this.tailLength += chunk.length;
    while (this.tailLength > CAPTURE_CHARS / 2) {
      const first = this.tail[0];
      const excess = this.tailLength - CAPTURE_CHARS / 2;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailLength -= first.length;
      } else {
        this.tail[0] = first.slice(excess);
        this.tailLength -= excess;
      }
    }
  }

  get truncated(): boolean { return this.total > CAPTURE_CHARS; }

  text(): string {
    const marker = this.truncated
      ? `\n... [command output truncated: ${this.total - CAPTURE_CHARS} characters omitted; head and tail retained. Re-run with filters or redirect to your own file.] ...\n`
      : '';
    return this.head + marker + this.tail.join('');
  }
}
