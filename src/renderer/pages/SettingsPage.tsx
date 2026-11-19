/**
 * Settings Page - App configuration
 * Modular design with left sidebar navigation and right content area
 */

import { useState, useCallback, useEffect } from 'react'
import { useAppStore } from '../stores/app.store'
import { api } from '../api'
import type { HaloConfig } from '../types'
import { Header } from '../components/layout/Header'
import { SearchIcon } from '../components/search/SearchIcon'
import { useSearchStore } from '../stores/search.store'
import { useTranslation } from '../i18n'
import { useIsMobile } from '../hooks/useIsMobile'
import { useServerBackend } from '../hooks/useServerBackend'

// Import modular settings components
import {
  SettingsNav,
  scrollToSection,
  AISourcesSection,
  AppearanceSection,
  SystemSection,
  AdvancedSection,
  RemoteAccessSection,
  FederationSection,
  AboutSection,
  MessageChannelsSection,
  RegistrySection,
  RecommendSection
} from '../components/settings'

export function SettingsPage() {
  const { t } = useTranslation()
  const { config, setConfig } = useAppStore()
  const { openSearch } = useSearchStore()
  const isMobile = useIsMobile()
  const isRemoteMode = api.isRemoteMode()
  // A headless server has no desktop window, so its web client also gets the
  // node-level sections a desktop owner would change locally.
  const serverBackend = useServerBackend()
  const showNodeSettings = !isRemoteMode || serverBackend

  // Active navigation section (click-only, no scroll spy - standard settings page behavior)
  const settingsFocus = useAppStore(state => state.settingsFocus)
  const focusSection = settingsFocus === 'proxy' ? 'system' : 'advanced'
  const [activeSection, setActiveSection] = useState(settingsFocus && !isRemoteMode ? focusSection : 'ai-model')
  useEffect(() => {
    if (!settingsFocus) return
    if (!isRemoteMode) scrollToSection(focusSection)
    useAppStore.getState().clearSettingsFocus()
  }, [settingsFocus, focusSection, isRemoteMode])

  // Handle navigation click
  const handleNavClick = useCallback((sectionId: string) => {
    setActiveSection(sectionId)
    scrollToSection(sectionId)
  }, [])

  return (
    <div className="h-full w-full flex flex-col">
      {/* Header */}
      <Header
        left={<span className="text-sm font-semibold text-foreground whitespace-nowrap">{t('Settings')}</span>}
        right={<SearchIcon onClick={() => openSearch('global')} />}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Navigation - Desktop only */}
        {!isMobile && (
          <SettingsNav
            isRemoteMode={isRemoteMode}
            serverBackend={serverBackend}
            activeSection={activeSection}
            onSectionChange={handleNavClick}
          />
        )}

        {/* Right Content Area */}
        <main className="flex-1 overflow-auto">
          {/* Mobile Navigation Dropdown */}
          {isMobile && (
            <SettingsNav
              isRemoteMode={isRemoteMode}
              serverBackend={serverBackend}
              activeSection={activeSection}
              onSectionChange={handleNavClick}
            />
          )}

          {/* Scrollable Content */}
          <div className="p-6">
            <div className="max-w-2xl mx-auto space-y-6">
              {/* AI Sources Section (v2) */}
              <section id="ai-model" className="bg-card rounded-xl border border-border-faint p-6">
                <h2 className="text-lg font-medium mb-4">{t('AI Model')}</h2>
                <AISourcesSection config={config as HaloConfig} setConfig={setConfig} />
              </section>

              {/* Message Channels (unified: notification channels + WeCom Bot) */}
              <MessageChannelsSection config={config} setConfig={setConfig} />

              {/* App Store Registry Section */}
              <RegistrySection />

              {/* Appearance Section */}
              <AppearanceSection config={config} setConfig={setConfig} />

              {/* System Section - Desktop only */}
              {!isRemoteMode && (
                <SystemSection config={config} setConfig={setConfig} proxyFocused={settingsFocus === 'proxy'} />
              )}

              {/* Advanced Section - desktop, or the web client of a headless server;
                  its desktop-only parts gate themselves */}
              {showNodeSettings && (
                <AdvancedSection config={config} setConfig={setConfig} />
              )}

              {/* Remote Access Section - Desktop only */}
              {!isRemoteMode && (
                <RemoteAccessSection />
              )}

              {/* Federation Gateway - desktop, or the web client of a headless server */}
              {showNodeSettings && (
                <FederationSection config={config} setConfig={setConfig} />
              )}

              {/* Recommend Section */}
              <RecommendSection />

              {/* About Section */}
              <AboutSection />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
