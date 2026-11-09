import type { ContentBlock, Message } from '../types/provider.js';
import type { SDKAssistantMessage } from './query-types.js';
import { mergeToolContextRecords, TOOL_CONTEXT_LIMITS, type ToolContextRecord } from './tool-context/index.js';
import { getLogger } from '../utils/logger.js';

function metadataBytes(record: ToolContextRecord | undefined): number {
  return record ? Buffer.byteLength(JSON.stringify(record), 'utf8') : 0;
}

function checkMetadataBudget(bytes: number, responseUuid: string): void {
  if (bytes <= TOOL_CONTEXT_LIMITS.stateBytes * 2) return;
  getLogger('History').warn('Assistant checkpoint refused: grouped tool context exceeds restoration limit', {
    responseUuid, bytes, limit: TOOL_CONTEXT_LIMITS.stateBytes * 2,
  });
  throw new RangeError('Assistant tool context exceeds the history restoration limit');
}

/** Owns one retained assistant message while its completed blocks arrive. */
export class AssistantHistoryRecorder {
  private active?: { responseUuid: string; metadataBytes: number; message: Message & { role: 'assistant'; content: ContentBlock[] } };

  constructor(
    private readonly persist: (message: SDKAssistantMessage, responseUuid?: string) => void | Promise<void>,
    private readonly append?: (message: Message) => void,
    private readonly finalize?: (message: SDKAssistantMessage, responseUuid: string) => void | Promise<void>,
  ) {}

  async recordBlock(message: SDKAssistantMessage, responseUuid: string): Promise<void> {
    // Summed block sizes bound the merged record without serializing earlier blocks again.
    const bytes = metadataBytes(message.message.toolContext) + (this.active?.responseUuid === responseUuid ? this.active.metadataBytes : 0);
    checkMetadataBudget(bytes, responseUuid);
    await this.persist(message, responseUuid);
    if (this.active?.responseUuid === responseUuid) {
      const content = this.active.message.content;
      for (const block of message.message.content) content.push(block);
      const toolContext = mergeToolContextRecords(this.active.message.toolContext, message.message.toolContext);
      if (toolContext) this.active.message.toolContext = toolContext;
      this.active.metadataBytes = bytes;
    } else {
      const toolContext = (message.message as Message).toolContext;
      const retained = { role: 'assistant' as const, content: [...message.message.content], ...(toolContext ? { toolContext } : {}) };
      this.active = { responseUuid, metadataBytes: bytes, message: retained };
      this.append?.(retained);
    }
  }

  async recordMessage(message: SDKAssistantMessage): Promise<void> {
    checkMetadataBudget(metadataBytes(message.message.toolContext), message.uuid);
    if (this.active?.responseUuid === message.uuid) {
      this.active.message.content = message.message.content;
      const toolContext = message.message.toolContext ?? this.active.message.toolContext;
      if (toolContext) this.active.message.toolContext = toolContext;
      await this.finalize?.(message, this.active.responseUuid);
    } else {
      await this.persist(message);
      const toolContext = (message.message as Message).toolContext;
      this.append?.({ role: 'assistant', content: message.message.content, ...(toolContext ? { toolContext } : {}) });
    }
    this.active = undefined;
  }
}
