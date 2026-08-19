/**
 * Notification Store
 *
 * Unified in-app toast notification system.
 * Manages a queue of toast notifications displayed as floating overlays.
 *
 * Sources:
 * - IPC 'notification:toast' from main process (e.g. app events when window is focused)
 * - Updater events (update downloaded / manual download)
 * - Future: any module can push toasts via store actions
 *
 * Design:
 * - Visual style matches the existing UpdateNotification component
 * - Each toast auto-dismisses after a configurable duration
 * - Toasts stack from bottom-right, newest at the bottom
 */

import { create } from 'zustand'
import type { ToastVariant, ToastBodyFormat } from '../../shared/types/notification'

// ============================================
// Types
// ============================================

export type { ToastVariant, ToastBodyFormat }

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  /** Unique ID for this toast instance */
  id: string
  /** Notification title (short, bold) */
  title: string
  /** Notification body text */
  body?: string
  /**
   * How to render `body`. Defaults to plain text.
   * 'markdown' routes through RichText — use it for server-authored copy
   * (release notes, announcements) that needs lists or inline links.
   */
  bodyFormat?: ToastBodyFormat
  /** Visual variant — controls icon and accent color */
  variant: ToastVariant
  /** Primary action button (e.g. "Restart now", "View") */
  action?: ToastAction
  /** Secondary action button (e.g. "Later") */
  secondaryAction?: ToastAction
  /** Auto-dismiss duration in ms. 0 = sticky (manual dismiss only). Default: 6000 */
  duration: number
  /** When this toast was created (for ordering) */
  createdAt: number
}

/** Payload accepted by the `show` action — id and createdAt are auto-generated */
export type ToastInput = Omit<ToastItem, 'id' | 'createdAt'> & {
  id?: string
}

// ============================================
// Store Interface
// ============================================

interface NotificationState {
  toasts: ToastItem[]
  show: (input: ToastInput) => string
  dismiss: (id: string) => void
  clear: () => void
}

// ============================================
// Store
// ============================================

let toastCounter = 0

export const useNotificationStore = create<NotificationState>((set) => ({
  toasts: [],

  show: (input) => {
    const id = input.id ?? `toast-${++toastCounter}-${Date.now()}`
    const toast: ToastItem = {
      ...input,
      id,
      createdAt: Date.now(),
    }

    set((state) => ({
      // Replace existing toast with same id, or append
      toasts: [
        ...state.toasts.filter((t) => t.id !== id),
        toast,
      ],
    }))

    return id
  },

  dismiss: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }))
  },

  clear: () => {
    set({ toasts: [] })
  },
}))
