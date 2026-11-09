import type { SDKMessage } from '../core/query-types.js';
import { aborted } from './rpc.js';

export interface StreamBatch {
  scope: string;
  streamId: string;
  sequence: number;
  messages: SDKMessage[];
  done?: boolean;
  error?: { name: string; message: string; stack?: string };
}

/** At most one unacknowledged batch and one bounded batch under construction. */
export class StreamWriter {
  private messages: SDKMessage[] = [];
  private bytes = 0;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: { promise: Promise<void>; resolve(): void; reject(error: Error): void; sequence: number };
  private stopped = false;
  constructor(private readonly scope: string, private readonly streamId: string, private readonly send: (batch: StreamBatch) => void) {}

  async push(message: SDKMessage): Promise<void> {
    if (this.stopped) throw aborted();
    if (this.flight) await this.flight.promise;
    if (this.stopped) throw aborted();
    const bytes = JSON.stringify(message).length * 2;
    if (bytes > 64 * 1024 * 1024) throw new Error('Worker stream message exceeds the 64 MiB transport limit');
    this.messages.push(message);
    this.bytes += bytes;
    if (this.messages.length >= 64 || this.bytes >= 128 * 1024) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 16);
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.messages.length || this.stopped) return;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {}); // stop() may run before the producer asks for the next slot.
    const sequence = ++this.sequence;
    this.flight = { promise, resolve, reject, sequence };
    const messages = this.messages;
    this.messages = [];
    this.bytes = 0;
    this.send({ scope: this.scope, streamId: this.streamId, sequence, messages });
  }

  ack(sequence: number): void {
    if (this.flight?.sequence !== sequence) return;
    this.flight.resolve();
    this.flight = undefined;
  }

  async finish(error?: StreamBatch['error']): Promise<void> {
    if (this.stopped) return;
    if (this.flight) await this.flight.promise;
    this.flush();
    if (this.flight) await this.flight.promise;
    if (!this.stopped) this.send({ scope: this.scope, streamId: this.streamId, sequence: ++this.sequence, messages: [], done: true, error });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.messages = [];
    this.flight?.reject(aborted());
    this.flight = undefined;
  }
}
