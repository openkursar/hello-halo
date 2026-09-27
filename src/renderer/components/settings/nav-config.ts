/**
 * Settings Navigation Configuration
 * Data-driven navigation items for the settings page
 */

import { Brain, Palette, Settings, Globe, Info, Bell, Store, Code, Heart } from 'lucide-react'
import type { SettingsNavItem } from './types'

/**
 * Navigation items for settings sidebar
 * Order determines display order in the navigation
 */
export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    id: 'ai-model',
    // Same glyph as the chat header's ModelSelector (layout/ModelSelector.tsx)
    // — one icon for "AI model" everywhere it appears, not two.
    labelKey: 'AI Model',
    icon: Brain
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
    desktopOnly: true
  },
  {
    id: 'advanced',
    labelKey: 'Advanced',
    icon: Code,
    desktopOnly: true
  },
  {
    id: 'remote',
    labelKey: 'Remote Access',
    icon: Globe,
    desktopOnly: true
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
 */
export function getFilteredNavItems(isRemoteMode: boolean): SettingsNavItem[] {
  return SETTINGS_NAV_ITEMS.filter(item => !item.desktopOnly || !isRemoteMode)
}
