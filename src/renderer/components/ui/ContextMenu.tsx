/**
 * ContextMenu - Lightweight right-click context menu component
 * Zero dependencies, uses Portal for rendering
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Menu dimension constants (must match CSS styles)
const MENU_WIDTH = 200
const MENU_ITEM_HEIGHT = 32
const MENU_PADDING = 8

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  separator?: boolean
  hidden?: boolean
}

interface ContextMenuProps {
  children: React.ReactNode
  items: ContextMenuItem[]
  /** Applied to the trigger wrapper div. Needed when a child relies on a
   * percentage height (e.g. `h-full`) — percentage heights only resolve
   * against a direct parent with a definite height, so callers in a
   * fixed-height slot (like a virtualized row) must pass `h-full` here too. */
  className?: string
}

export function ContextMenu({ children, items, className }: ContextMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)

  // Handle right-click event
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const { clientX, clientY } = e
    const visibleItems = items.filter(item => !item.hidden)
    const menuHeight = visibleItems.length * MENU_ITEM_HEIGHT + MENU_PADDING

    // Calculate menu position, avoid overflow
    let x = clientX
    let y = clientY

    if (x + MENU_WIDTH > window.innerWidth) {
      x = window.innerWidth - MENU_WIDTH - 8
    }

    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8
    }

    setPosition({ x, y })
    setIsOpen(true)
  }

  // Click outside to close menu
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    const handleScroll = () => setIsOpen(false)

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('wheel', handleScroll, { passive: true })

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('wheel', handleScroll)
    }
  }, [isOpen])

  // ESC key to close menu
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  const handleItemClick = (item: ContextMenuItem) => {
    item.onClick()
    setIsOpen(false)
  }

  return (
    <>
      <div ref={triggerRef} onContextMenu={handleContextMenu} className={className}>
        {children}
      </div>

      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-lg"
            style={{ left: position.x, top: position.y }}
          >
            {items.map((item, index) => {
              if (item.hidden) return null

              if (item.separator) {
                return (
                  <div key={index} className="my-1 h-px bg-border" />
                )
              }

              return (
                <button
                  key={index}
                  onClick={() => handleItemClick(item)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-secondary/60 transition-colors"
                >
                  {item.icon && <span className="w-4 h-4">{item.icon}</span>}
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}
