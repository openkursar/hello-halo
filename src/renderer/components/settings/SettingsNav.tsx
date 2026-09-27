/**
 * Settings Navigation Component
 * Left sidebar navigation with scroll sync and mobile responsive dropdown
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'
import { getFilteredNavItems } from './nav-config'
import type { SettingsNavItem } from './types'
import { cn } from '../../lib/utils'

interface SettingsNavProps {
  /** Whether running in remote mode */
  isRemoteMode: boolean
  /** Currently active section id */
  activeSection: string
  /** Callback when section changes */
  onSectionChange: (sectionId: string) => void
}

/**
 * Desktop sidebar navigation button
 */
function NavButton({
  item,
  active,
  onClick
}: {
  item: SettingsNavItem
  active: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  const Icon = item.icon

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left transition-colors",
        "hover:bg-secondary",
        active && "bg-primary/10 text-primary border-l-2 border-primary",
        !active && "border-l-2 border-transparent"
      )}
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="truncate">{t(item.labelKey)}</span>
    </button>
  )
}

/**
 * Mobile dropdown selector
 */
function MobileNavDropdown({
  navItems,
  activeSection,
  onSectionChange
}: {
  navItems: SettingsNavItem[]
  activeSection: string
  onSectionChange: (sectionId: string) => void
}) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Find active item
  const activeItem = navItems.find(item => item.id === activeSection) || navItems[0]
  const ActiveIcon = activeItem?.icon

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "w-full flex items-center justify-between gap-2 px-4 py-3",
          "bg-card border border-border rounded-lg",
          "text-sm font-medium transition-colors",
          isOpen && "ring-2 ring-primary"
        )}
      >
        <div className="flex items-center gap-2">
          {ActiveIcon && <ActiveIcon className="w-4 h-4 text-primary" />}
          <span>{t(activeItem?.labelKey || '')}</span>
        </div>
        <ChevronDown className={cn(
          "w-4 h-4 text-muted-foreground transition-transform",
          isOpen && "rotate-180"
        )} />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = item.id === activeSection
            return (
              <button
                key={item.id}
                onClick={() => {
                  onSectionChange(item.id)
                  setIsOpen(false)
                }}
                className={cn(
                  "w-full flex items-center gap-2.5 px-4 py-3 text-sm text-left transition-colors",
                  "hover:bg-secondary",
                  isActive && "bg-primary/10 text-primary"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span>{t(item.labelKey)}</span>
                {isActive && (
                  <span className="ml-auto text-xs text-primary">●</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Main Settings Navigation Component
 * Renders sidebar on desktop, dropdown on mobile
 */
export function SettingsNav({ isRemoteMode, activeSection, onSectionChange }: SettingsNavProps) {
  const isMobile = useIsMobile()
  const navItems = getFilteredNavItems(isRemoteMode)

  if (isMobile) {
    return (
      <div className="px-4 py-3 border-b border-border bg-background sticky top-0 z-10">
        <MobileNavDropdown
          navItems={navItems}
          activeSection={activeSection}
          onSectionChange={onSectionChange}
        />
      </div>
    )
  }

  // Desktop sidebar
  return (
    <nav className="w-48 shrink-0 border-r border-border bg-background overflow-y-auto">
      <div className="py-2">
        {navItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={activeSection === item.id}
            onClick={() => onSectionChange(item.id)}
          />
        ))}
      </div>
    </nav>
  )
}

/**
 * Scroll to a section smoothly
 */
export function scrollToSection(sectionId: string) {
  const element = document.getElementById(sectionId)
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}
