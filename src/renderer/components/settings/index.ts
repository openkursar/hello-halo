/**
 * Settings Components Index
 * Export all settings-related components and utilities
 */

// Types
export * from './types'

// Navigation
export * from './nav-config'
export { SettingsNav, scrollToSection } from './SettingsNav'

// Section Components (v2)
export { AISourcesSection } from './AISourcesSection'
export { ProviderSelector } from './ProviderSelector'
export { AppearanceSection } from './AppearanceSection'
export { SystemSection } from './SystemSection'
export { RemoteAccessSection } from './RemoteAccessSection'
export { FederationSection } from './FederationSection'
export { AboutSection } from './AboutSection'
export { RecommendSection } from './RecommendSection'
export { AdvancedSection } from './AdvancedSection'
export { MessageChannelsSection } from './MessageChannelsSection'
// Legacy exports — ImSessionsSection is reused inside digital human config (per-app mode)
export { ImSessionsSection } from './ImSessionsSection'
export { RegistrySection } from './RegistrySection'
export { CLIConfigSection } from './CLIConfigSection'

