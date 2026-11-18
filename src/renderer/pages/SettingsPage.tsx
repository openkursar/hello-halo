/**
 * Settings Page - App configuration
 * Modular design with left sidebar navigation and right content area
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../stores/app.store'
import { api } from '../api'
import type { HaloConfig } from '../types'
import { Header } from '../components/layout/Header'
import { SearchIcon } from '../components/search/SearchIcon'
import { useSearchStore } from '../stores/search.store'
import { useTranslation } from '../i18n'
import { useIsMobile } from '../hooks/useIsMobile'

// Import modular settings components
import {
  SettingsNav,
  scrollToSection,
  AISourcesSection,
  AppearanceSection,
  SystemSection,
  AdvancedSection,
  RemoteAccessSection,
  AboutSection,
  MessageChannelsSection,
  RegistrySection,
  RecommendSection
} from '../components/settings'

const FOCUS_SECTION = { 'claude-code': 'advanced', proxy: 'system', 'remote-access': 'remote' } as const

const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

/**
 * Brings a section to the top and keeps it there while the sections above it
 * finish loading and change height, until the user scrolls or it settles.
 * Returns the release.
 */
function holdSectionAtTop(scroller: HTMLElement, content: HTMLElement, sectionId: string): () => void {
  const align = () => document.getElementById(sectionId)?.scrollIntoView({ block: 'start' })
  const observer = new ResizeObserver(align)
  const release = () => {
    observer.disconnect()
    clearTimeout(timer)
    for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, release)
  }
  const timer = setTimeout(release, 3000)
  for (const type of USER_SCROLL_EVENTS) scroller.addEventListener(type, release, { passive: true })
  observer.observe(content)
  align()
  return release
}

export function SettingsPage() {
  const { t } = useTranslation()
  const { config, setConfig } = useAppStore()
  const { openSearch } = useSearchStore()
  const isMobile = useIsMobile()
  const isRemoteMode = api.isRemoteMode()

  // Active navigation section (click-only, no scroll spy - standard settings page behavior)
  const settingsFocus = useAppStore(state => state.settingsFocus)
  const [activeSection, setActiveSection] = useState(settingsFocus && !isRemoteMode ? FOCUS_SECTION[settingsFocus] : 'ai-model')
  const mainRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const releaseHold = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!settingsFocus) return
    useAppStore.getState().clearSettingsFocus()
    if (isRemoteMode || !mainRef.current || !contentRef.current) return
    const sectionId = FOCUS_SECTION[settingsFocus]
    setActiveSection(sectionId)
    releaseHold.current?.()
    releaseHold.current = holdSectionAtTop(mainRef.current, contentRef.current, sectionId)
  }, [settingsFocus, isRemoteMode])

  useEffect(() => () => releaseHold.current?.(), [])

  // Handle navigation click
  const handleNavClick = useCallback((sectionId: string) => {
    releaseHold.current?.()
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
            activeSection={activeSection}
            onSectionChange={handleNavClick}
          />
        )}

        {/* Right Content Area */}
        <main ref={mainRef} className="flex-1 overflow-auto">
          {/* Mobile Navigation Dropdown */}
          {isMobile && (
            <SettingsNav
              isRemoteMode={isRemoteMode}
              activeSection={activeSection}
              onSectionChange={handleNavClick}
            />
          )}

          {/* Scrollable Content */}
          <div className="p-6">
            <div ref={contentRef} className="max-w-2xl mx-auto space-y-6">
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

              {/* Advanced Section - Desktop only */}
              {!isRemoteMode && (
                <AdvancedSection config={config} setConfig={setConfig} />
              )}

              {/* Remote Access Section - Desktop only */}
              {!isRemoteMode && (
                <RemoteAccessSection config={config} setConfig={setConfig} />
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
