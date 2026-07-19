/**
 * apps/runtime/im-channels -- ImChannelManager
 *
 * Manages all IM channel instances across all provider types.
 * Responsibilities:
 *   - Instance lifecycle (create / start / stop / reconnect)
 *   - Provider registration (built-in and future plugins)
 *   - Config change detection (hot-reload without restart)
 *   - Instance lookup by ID for push routing
 *
 * The Manager does NOT handle message routing — each instance's onInbound
 * callback is wired by the runtime index during initialization.
 *
 * Thread safety: All mutations are synchronous (single Node.js event loop).
 */

import type {
  ImChannelProvider,
  ImChannelInstance,
  ImChannelInstanceConfig,
  ImChannelType,
  ImChannelInstanceStatus,
} from '../../../../shared/types/im-channel'

// ============================================
// Manager Implementation
// ============================================

export class ImChannelManager {
  /** Registered providers by type */
  private providers = new Map<ImChannelType, ImChannelProvider>()
  /** Running instances by instance ID */
  private instances = new Map<string, ImChannelInstance>()
  /** Current config snapshot (for change detection) */
  private currentConfigs: ImChannelInstanceConfig[] = []
  /** Callback fired after each instance is torn down (for resource cleanup). */
  private onInstanceStop: ((instanceId: string) => void) | null = null

  // ── Provider Registration ──────────────────────────────────────

  /**
   * Register a channel type provider.
   * Must be called before applying config that uses this provider type.
   */
  registerProvider(provider: ImChannelProvider): void {
    if (this.providers.has(provider.type)) {
      console.warn(`[ImChannelManager] Provider "${provider.type}" already registered, replacing`)
    }
    this.providers.set(provider.type, provider)
    console.log(`[ImChannelManager] Provider registered: ${provider.type} (${provider.displayName})`)
  }

  /**
   * Get a registered provider by type.
   */
  getProvider(type: ImChannelType): ImChannelProvider | undefined {
    return this.providers.get(type)
  }

  /**
   * Get all registered providers.
   */
  getAllProviders(): ImChannelProvider[] {
    return Array.from(this.providers.values())
  }

  // ── Instance Lifecycle ─────────────────────────────────────────

  /**
   * Apply a new set of instance configs.
   *
   * Performs a diff against the current state:
   *   - New instances → create + start
   *   - Removed instances → stop + delete
   *   - Changed instances → stop old + create new + start
   *   - Unchanged instances → no-op
   *
   * @param configs - Full list of instance configs from HaloConfig.imChannels.instances
   * @param onInbound - Callback wired to each new instance for inbound message handling
   */
  applyConfig(
    configs: ImChannelInstanceConfig[],
    onInbound: (instanceId: string, appId: string, msg: import('../../../../shared/types/inbound-message').InboundMessage, reply: import('../../../../shared/types/inbound-message').ReplyHandle) => void
  ): void {
    const newConfigMap = new Map<string, ImChannelInstanceConfig>()
    for (const c of configs) {
      newConfigMap.set(c.id, c)
    }

    const oldConfigMap = new Map<string, ImChannelInstanceConfig>()
    for (const c of this.currentConfigs) {
      oldConfigMap.set(c.id, c)
    }

    // 1. Stop + remove instances that no longer exist in config
    for (const [id] of this.instances) {
      if (!newConfigMap.has(id)) {
        this.stopInstance(id)
      }
    }

    // 2. Create or update instances
    for (const cfg of configs) {
      const oldCfg = oldConfigMap.get(cfg.id)
      const existing = this.instances.get(cfg.id)

      if (existing && oldCfg && this.configEqual(oldCfg, cfg)) {
        // No change — skip
        continue
      }

      // Stop old instance if it exists (config changed)
      if (existing) {
        this.stopInstance(cfg.id)
      }

      // Create new instance if enabled and has required fields
      if (cfg.enabled && cfg.appId) {
        this.createAndStartInstance(cfg, onInbound)
      }
    }

    // Save current config snapshot
    this.currentConfigs = configs.map(c => ({ ...c, config: { ...c.config } }))

    const running = Array.from(this.instances.values()).filter(i => i.isConnected()).length
    console.log(
      `[ImChannelManager] Config applied: ${configs.length} configured, ` +
      `${this.instances.size} instantiated, ${running} connected`
    )
  }

  /**
   * Replace the stored config snapshot for one instance without any lifecycle
   * action (no stop/start/reconnect, no onInbound rewiring).
   *
   * Only safe for fields that configEqual ignores (owners, streaming,
   * replyScope, ...) — lifecycle-relevant changes must go through applyConfig.
   * Returns false when the instance is not in the current snapshot.
   */
  updateInstanceConfigSnapshot(cfg: ImChannelInstanceConfig): boolean {
    const idx = this.currentConfigs.findIndex(c => c.id === cfg.id)
    if (idx === -1) {
      return false
    }
    this.currentConfigs[idx] = { ...cfg, config: { ...cfg.config } }
    return true
  }

  /**
   * Reconnect a specific instance with its current config.
   */
  reconnectInstance(instanceId: string): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      console.warn(`[ImChannelManager] Cannot reconnect: instance "${instanceId}" not found`)
      return false
    }
    instance.reconnect()
    return true
  }

  /**
   * Stop all instances and clear state. Called during shutdown.
   */
  stopAll(): void {
    for (const [id] of this.instances) {
      this.stopInstance(id)
    }
    this.currentConfigs = []
    console.log('[ImChannelManager] All instances stopped')
  }

  setOnInstanceStop(handler: ((instanceId: string) => void) | null): void {
    this.onInstanceStop = handler
  }

  // ── Instance Lookup ────────────────────────────────────────────

  /**
   * Get a running instance by ID.
   */
  getInstance(instanceId: string): ImChannelInstance | undefined {
    return this.instances.get(instanceId)
  }

  /**
   * Get all running instances for a specific app.
   */
  getInstancesForApp(appId: string): ImChannelInstance[] {
    const result: ImChannelInstance[] = []
    for (const [id, instance] of this.instances) {
      const cfg = this.currentConfigs.find(c => c.id === id)
      if (cfg?.appId === appId) {
        result.push(instance)
      }
    }
    return result
  }

  /**
   * Get the appId bound to a specific instance.
   */
  getAppIdForInstance(instanceId: string): string | undefined {
    return this.currentConfigs.find(c => c.id === instanceId)?.appId
  }

  /**
   * Get the full persisted config for a specific instance.
   * Used by dispatch-inbound to check streaming/replyScope settings.
   */
  getInstanceConfig(instanceId: string): ImChannelInstanceConfig | undefined {
    return this.currentConfigs.find(c => c.id === instanceId)
  }

  /**
   * Get status of all configured instances.
   */
  getAllStatuses(): ImChannelInstanceStatus[] {
    return this.currentConfigs.map(cfg => ({
      id: cfg.id,
      type: cfg.type,
      enabled: cfg.enabled,
      connected: this.instances.get(cfg.id)?.isConnected() ?? false,
      appId: cfg.appId,
    }))
  }

  /**
   * Get status of a specific instance.
   */
  getInstanceStatus(instanceId: string): ImChannelInstanceStatus | null {
    const cfg = this.currentConfigs.find(c => c.id === instanceId)
    if (!cfg) return null
    return {
      id: cfg.id,
      type: cfg.type,
      enabled: cfg.enabled,
      connected: this.instances.get(cfg.id)?.isConnected() ?? false,
      appId: cfg.appId,
    }
  }

  // ── Internal ───────────────────────────────────────────────────

  private createAndStartInstance(
    cfg: ImChannelInstanceConfig,
    onInbound: (instanceId: string, appId: string, msg: import('../../../../shared/types/inbound-message').InboundMessage, reply: import('../../../../shared/types/inbound-message').ReplyHandle) => void
  ): void {
    const provider = this.providers.get(cfg.type)
    if (!provider) {
      console.error(`[ImChannelManager] No provider for type "${cfg.type}" — skipping instance "${cfg.id}"`)
      return
    }

    const validationError = provider.validateConfig(cfg.config)
    if (validationError) {
      console.warn(`[ImChannelManager] Invalid config for instance "${cfg.id}": ${validationError}`)
      return
    }

    try {
      const instance = provider.createInstance(cfg.id, cfg.config)

      // Wire inbound handler — binds instanceId + appId into the callback
      instance.onInbound((msg, reply) => {
        onInbound(cfg.id, cfg.appId, msg, reply)
      })

      instance.start()
      this.instances.set(cfg.id, instance)
      console.log(`[ImChannelManager] Instance started: id=${cfg.id}, type=${cfg.type}, appId=${cfg.appId}`)
    } catch (err) {
      console.error(`[ImChannelManager] Failed to create instance "${cfg.id}":`, err)
    }
  }

  private stopInstance(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      try {
        instance.stop()
      } catch (err) {
        console.error(`[ImChannelManager] Error stopping instance "${id}":`, err)
      }
      this.instances.delete(id)
      if (this.onInstanceStop) {
        try {
          this.onInstanceStop(id)
        } catch (err) {
          console.error(
            `[ImChannelManager] onInstanceStop handler threw for id="${id}":`,
            err
          )
        }
      }
      console.log(`[ImChannelManager] Instance stopped: id=${id}`)
    }
  }

  /**
   * Compare two instance configs for equality.
   * Deep-compares the provider-specific config object.
   *
   * Note: streaming/replyScope are intentionally excluded — they are read at
   * dispatch time from currentConfigs (updated unconditionally in applyConfig)
   * and do NOT require a WebSocket reconnect when changed.
   */
  private configEqual(a: ImChannelInstanceConfig, b: ImChannelInstanceConfig): boolean {
    return (
      a.id === b.id &&
      a.type === b.type &&
      a.enabled === b.enabled &&
      a.appId === b.appId &&
      JSON.stringify(a.config) === JSON.stringify(b.config)
    )
  }
}
