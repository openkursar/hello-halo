/**
 * Settings Navigation Configuration
 * Data-driven navigation items for the settings page
 */

import { Brain, Palette, Settings, Globe, Info, Bell, Store, Code, Heart, Network, ShieldCheck } from 'lucide-react'
import type { SettingsNavItem } from './types'

/**
 * Navigation items for settings sidebar
 * Order determines display order in the navigation
 */
export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    id: 'ai-model',
    // Same glyph as the chat header's ModelSelector (ai-config/ModelSelector.tsx)
    // — one icon for "AI model" everywhere it appears, not two.
    labelKey: 'AI Model',
    icon: Brain
  },
  {
    // Shown only in builds that provide a company sign-in.
    id: 'enterprise-identity',
    labelKey: 'Enterprise identity',
    icon: ShieldCheck
  },
  {
    id: 'message-channels',
    labelKey: 'Message Channels',
    icon: Bell
  },
  {
    id: 'app-store',
    labelKey: 'App Store',
    icon: Store
  },
  {
    id: 'appearance',
    labelKey: 'Appearance',
    icon: Palette
  },
  {
    id: 'system',
    labelKey: 'System',
    icon: Settings,
    audience: 'desktop'
  },
  {
    id: 'advanced',
    labelKey: 'Advanced',
    icon: Code,
    audience: 'node'
  },
  {
    id: 'remote',
    labelKey: 'Remote Access',
    icon: Globe,
    audience: 'desktop'
  },
  {
    id: 'federation',
    labelKey: 'Federation Gateway',
    icon: Network,
    audience: 'headless'
  },
  {
    id: 'recommend',
    labelKey: 'Recommend Halo',
    icon: Heart
  },
  {
    id: 'about',
    labelKey: 'About',
    icon: Info
  }
]

/**
 * Get filtered navigation items based on mode
 * @param isRemoteMode - Whether running in remote/web mode
 * @param serverBackend - Whether the remote backend is a headless server
 * @param hiddenIds - Sections this build or state does not show
 */
export function getFilteredNavItems(
  isRemoteMode: boolean,
  serverBackend = false,
  hiddenIds: readonly string[] = []
): SettingsNavItem[] {
  return SETTINGS_NAV_ITEMS.filter(({ id, audience }) => {
    if (hiddenIds.includes(id)) return false
    if (audience === 'desktop') return !isRemoteMode
    if (audience === 'headless') return isRemoteMode && serverBackend
    if (audience === 'node') return !isRemoteMode || serverBackend
    return true
  })
}
