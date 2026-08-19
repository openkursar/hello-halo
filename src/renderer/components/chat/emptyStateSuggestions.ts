/**
 * Empty-state suggestion pool.
 *
 * Clickable example prompts shown on the chat empty state so new users
 * immediately see what Halo can do. The pool samples Halo's capability
 * breadth (files, browser automation, data, scheduled digital humans,
 * research); a random subset is drawn per mount so users discover
 * different capabilities over time.
 *
 * All text goes through i18n; prompts must be self-contained so clicking
 * one can be sent directly without extra context.
 */

import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import {
  FolderOpen,
  Globe,
  BarChart3,
  Bot,
  FileText,
  BookOpen,
  HardDrive,
  Languages,
  Layout,
  CalendarClock,
} from 'lucide-react'

export interface EmptyStateSuggestion {
  icon: LucideIcon
  prompt: string
}

export function getEmptyStateSuggestionPool(t: TFunction): EmptyStateSuggestion[] {
  return [
    { icon: FolderOpen, prompt: t('Organize my Downloads folder by file type') },
    { icon: Globe, prompt: t("Open the browser and find today's top tech news") },
    { icon: BarChart3, prompt: t('Turn data I paste into an interactive chart') },
    { icon: Bot, prompt: t('Create a digital human that sends me a daily news briefing') },
    { icon: FileText, prompt: t('Draft a reusable weekly report template') },
    { icon: BookOpen, prompt: t('Research a topic in depth and summarize it as a note') },
    { icon: HardDrive, prompt: t('Find the largest files taking up my disk space') },
    { icon: Languages, prompt: t('Translate a document while keeping its formatting') },
    { icon: Layout, prompt: t('Build a personal homepage and preview it live') },
    { icon: CalendarClock, prompt: t('Set up a scheduled task that runs every morning') },
  ]
}

export function pickEmptyStateSuggestions(t: TFunction, count: number): EmptyStateSuggestion[] {
  const pool = getEmptyStateSuggestionPool(t)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count)
}
