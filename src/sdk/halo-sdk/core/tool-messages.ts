/** A producer holds at most one message until the consumer advances. */
export class ToolMessages<T> {
  private pending?: { value: T; resolve: () => void; reject: (error: Error) => void };
  private wake?: () => void;
  private closed = false;
  private complete = false;
  private sending: Promise<void> = Promise.resolve();

  send(value: T): Promise<void> {
    const next = this.sending.then(() => {
      if (this.closed) throw new Error('Tool message consumer closed');
      return new Promise<void>((resolve, reject) => {
        this.pending = { value, resolve, reject };
        this.wake?.();
      });
    });
    this.sending = next.catch(() => {});
    return next;
  }

  finish(): void { this.complete = true; this.wake?.(); }

  close(): void {
    this.closed = true;
    this.pending?.reject(new Error('Tool message consumer closed'));
    this.pending = undefined;
    this.wake?.();
  }

  async *stream(): AsyncGenerator<T> {
    try {
      while (!this.closed) {
        const item = this.pending;
        if (item) {
          yield item.value;
          this.pending = undefined;
          item.resolve();
        } else if (this.complete) return;
        else await new Promise<void>(resolve => { this.wake = resolve; });
      }
    } finally { this.close(); }
  }
}
