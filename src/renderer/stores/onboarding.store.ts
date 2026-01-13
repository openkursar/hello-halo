/**
 * Onboarding Store - Manages first-time user guided tour state
 *
 * Flow:
 * 1. step 1: Highlight Halo Space card on HomePage
 * 2. step 2: Pre-fill input with prompt, highlight send button
 * 3. step 3: Show mock AI response, highlight artifact
 * 4. User clicks artifact -> onboarding complete
 *
 * Note: Onboarding state is persisted to backend config (not localStorage)
 * to ensure consistency across different clients (app, web remote).
 */

import { create } from 'zustand'
import { api } from '../api'

export type OnboardingStep = 'halo-space' | 'send-message' | 'view-artifact' | 'completed'

interface OnboardingState {
  // Whether onboarding is currently active
  isActive: boolean

  // Current step in the onboarding flow
  currentStep: OnboardingStep

  // Whether user has ever completed onboarding (persisted to backend config)
  hasCompleted: boolean

  // Whether mock AI response animation is playing
  isMockAnimating: boolean

  // Whether AI is "thinking" (shows thinking animation, hides spotlight)
  isMockThinking: boolean

  // Actions
  startOnboarding: () => void
  nextStep: () => void
  skipOnboarding: () => void
  completeOnboarding: () => void
  setMockAnimating: (animating: boolean) => void
  setMockThinking: (thinking: boolean) => void

  // Initialize from backend config
  initialize: () => Promise<void>
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  isActive: false,
  currentStep: 'halo-space',
  hasCompleted: false,
  isMockAnimating: false,
  isMockThinking: false,

  initialize: async () => {
    try {
      // Load onboarding state from backend config
      const response = await api.getConfig()
      if (response.success && response.data) {
        const config = response.data as { onboarding?: { completed?: boolean } }
        const completed = config.onboarding?.completed === true
        set({ hasCompleted: completed })
        // Note: Don't auto-start onboarding here. HomePage will call startOnboarding
        // when user navigates there, so the spotlight targets the correct elements.
      }
    } catch (error) {
      console.error('[Onboarding] Failed to load state from config:', error)
      // Don't auto-start on error either
    }
  },

  startOnboarding: () => {
    set({ isActive: true, currentStep: 'halo-space' })
  },

  nextStep: () => {
    const { currentStep } = get()

    const stepOrder: OnboardingStep[] = ['halo-space', 'send-message', 'view-artifact', 'completed']
    const currentIndex = stepOrder.indexOf(currentStep)

    if (currentIndex < stepOrder.length - 1) {
      const nextStep = stepOrder[currentIndex + 1]
      set({ currentStep: nextStep })

      // If reached completed, finish onboarding
      if (nextStep === 'completed') {
        get().completeOnboarding()
      }
    }
  },

  skipOnboarding: () => {
    set({ isActive: false, currentStep: 'completed', hasCompleted: true })
    // Persist to backend config
    api.setConfig({ onboarding: { completed: true } }).catch(console.error)
  },

  completeOnboarding: () => {
    set({ isActive: false, currentStep: 'completed', hasCompleted: true })
    // Persist to backend config
    api.setConfig({ onboarding: { completed: true } }).catch(console.error)
  },

  setMockAnimating: (animating: boolean) => {
    set({ isMockAnimating: animating })
  },

  setMockThinking: (thinking: boolean) => {
    set({ isMockThinking: thinking })
  },
}))
