export type BusyDisposition = 'buffer' | 'skip';
export type DeliverDisposition = 'dispatched' | 'mid_turn' | 'buffered' | 'skipped';
export interface TurnGateHooks<TJob> {
    dispatch(sessionKey: string, job: TJob): Promise<void>;
    isBusy(sessionKey: string): boolean;
    getJobIdentity?(job: TJob): string | undefined;
    getActiveIdentity?(sessionKey: string): string | undefined;
    mergeJobs?(jobs: readonly TJob[]): TJob;
    refreshJob?(job: TJob): TJob | undefined;
    deliverMidTurn?(sessionKey: string, job: TJob): boolean;
}
export interface TurnGateOptions<TJob> {
    bufferCap?: number;
    recheckMs?: number;
    reservationTtlMs?: number;
    retryDispatch?: (error: unknown, job: TJob) => boolean;
    getCoalescingKey?: (job: TJob) => string | undefined;
    onDiscard?: (job: TJob, reason: string) => void;
    canOpenTurn?: (job: TJob) => boolean;
}
export interface TurnGate<TJob> {
    deliver(sessionKey: string, job: TJob, onBusy?: BusyDisposition): Promise<DeliverDisposition>;
    tryDeliverLive(sessionKey: string, job: TJob): boolean;
    runExclusive<T>(sessionKey: string, run: () => Promise<T>): Promise<T>;
    release(sessionKey: string): void;
    drain(sessionKey: string): void;
    notifyReady(sessionKey: string): void;
    isOccupied(sessionKey: string): boolean;
    bufferedJobs(sessionKey: string): readonly Readonly<TJob>[];
    bufferedCount(sessionKey: string): number;
    hasBuffered(sessionKey: string): boolean;
    hasAnyBuffered(match: (sessionKey: string) => boolean): boolean;
    discard(match: (sessionKey: string) => boolean, reason: string): number;
    discardJobs(match: (sessionKey: string, job: TJob) => boolean, reason: string): number;
    park(sessionKey: string): void;
    putBack(sessionKey: string, jobs: readonly TJob[]): void;
}
