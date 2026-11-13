import type { ForkSessionOptions, ForkSessionResult, GetArchivedRecordMessagesOptions, GetSessionInfoOptions, GetSessionMessagesOptions,
  ListArchivedRecordsOptions, ListSessionsOptions, SDKSessionInfo, SessionMessage, SessionMutationOptions } from '../index.js';
import { runPublic } from './operation.js';

function history<T>(operation: string, payload: Record<string, unknown>, options?: Record<string, unknown>): Promise<T> {
  return runPublic(`history.${operation}`, { cwd: process.cwd(), ...options }, payload, undefined, { decodeValues: false,
    result: value => value && typeof value === 'object' && Object.keys(value).length === 1 && value.__haloSdkNativeUndefined === true ? undefined : value });
}
export function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]> { return history('listSessions', {}, options as Record<string, unknown>); }
export function getSessionInfo(sessionId: string, options?: GetSessionInfoOptions): Promise<SDKSessionInfo | undefined> { return history('getSessionInfo', { sessionId }, options as Record<string, unknown>); }
export function getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]> { return history('getSessionMessages', { sessionId }, options as Record<string, unknown>); }
export function getArchivedRecordMessages(sessionId: string, agentId: string, options?: GetArchivedRecordMessagesOptions): Promise<SessionMessage[]> { return history('getArchivedRecordMessages', { sessionId, agentId }, options as Record<string, unknown>); }
export function listArchivedRecords(sessionId: string, options?: ListArchivedRecordsOptions): Promise<string[]> { return history('listArchivedRecords', { sessionId }, options as Record<string, unknown>); }
export function forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult> { return history('forkSession', { sessionId }, options as Record<string, unknown>); }
export function renameSession(sessionId: string, title: string, options?: SessionMutationOptions): Promise<void> { return history('renameSession', { sessionId, title }, options as Record<string, unknown>); }
export function tagSession(sessionId: string, tag: string | null, options?: SessionMutationOptions): Promise<void> { return history('tagSession', { sessionId, tag }, options as Record<string, unknown>); }
