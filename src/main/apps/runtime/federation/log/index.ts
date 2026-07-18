/**
 * apps/runtime/federation/log -- Unified feed log substrate (public API)
 *
 * The bare, location-independent core shared by every cross-node plane: a
 * hybrid logical clock (causal order), a durable per-author append log (the
 * outbox), and a reliable sync engine (effectively-once delivery + gap-fill).
 * Message/activity/history planes and the blackboard replication layer are all
 * consumers of this core — it holds no quorum, term, or election logic itself.
 */

export {
  createHybridClock,
  encodeHlc,
  decodeHlc,
  compareHlc,
  DEFAULT_MAX_DRIFT_MS,
  type HybridClock,
  type HybridClockOptions,
  type HlcParts,
} from './hlc'

export { createDurableFeedLog, type DurableFeedLog, type DurableFeedLogDeps } from './durable-log'

export { createFeedService, type FeedService, type FeedServiceDeps } from './feed-service'

export {
  createFeedProducer,
  createFeedConsumer,
  type FeedProducer,
  type FeedProducerDeps,
  type FeedConsumer,
  type FeedConsumerDeps,
} from './sync-engine'

export {
  feedIdKey,
  parseFeedIdKey,
  type FeedId,
  type FeedKind,
  type FeedEntry,
  type FeedSubscribeFrame,
  type FeedEntriesFrame,
  type FeedAckFrame,
  type FeedNackFrame,
  type FeedSyncFrame,
} from './types'
