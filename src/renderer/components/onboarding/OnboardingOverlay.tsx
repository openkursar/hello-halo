/**
 * OnboardingOverlay - Main controller for the onboarding experience
 *
 * Renders the appropriate spotlight and content for each onboarding step.
 * This component should be rendered at the app root level.
 */

import { useOnboardingStore } from '../../stores/onboarding.store'
import { Spotlight } from './Spotlight'
import { Sparkles, Send, FileText, ArrowRight } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'

// Step configurations with their spotlight targets and messages
// Note: titles and descriptions are translation keys
const STEP_CONFIGS = {
  'halo-space': {
    targetSelector: '[data-onboarding="halo-space"]',
    tooltipPosition: 'bottom' as const,
    titleKey: 'Start your first conversation',
    descriptionKey: 'Click to enter Halo space and experience how AI can help you',
    icon: Sparkles,
    iconColor: 'text-primary',
    buttonText: null, // User must click the target
  },
  'send-message': {
    targetSelector: '[data-onboarding="send-button"]',
    tooltipPosition: 'top' as const,
    titleKey: 'Send a task to AI',
    descriptionKey: 'We have prepared an example task for you. Click send to see what happens',
    icon: Send,
    iconColor: 'text-emerald-500',
    buttonText: null,
  },
  'view-artifact': {
    targetSelector: '[data-onboarding="artifact-card"]',
    tooltipPosition: 'left' as const,
    titleKey: 'View AI artifacts',
    descriptionKey: 'This is a file created by AI. Click to open and view',
    icon: FileText,
    iconColor: 'text-amber-500',
    buttonText: null,
  },
}

export function OnboardingOverlay() {
  const { isActive, currentStep, skipOnboarding, nextStep, isMockThinking, isMockAnimating } = useOnboardingStore()
  const { t } = useTranslation()

  // Don't show onboarding in remote mode (user must enable remote access in desktop app first, so not a new user)
  if (api.isRemoteMode()) {
    return null
  }

  // Don't render if not active or completed
  if (!isActive || currentStep === 'completed') {
    return null
  }

  // During AI thinking/animating phase, show a semi-transparent blocking overlay
  // This prevents user from clicking anything while keeping the chat visible
  if (isMockThinking || isMockAnimating) {
    return (
      <div className="fixed inset-0 z-[100] bg-black/30 pointer-events-auto">
        {/* Status indicator - top right */}
        <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-2 bg-card/90 backdrop-blur border border-border rounded-lg shadow-lg">
          <div className="w-4 h-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <span className="text-sm text-muted-foreground">
            {isMockThinking ? t('AI is thinking...') : t('AI is responding...')}
          </span>
        </div>
      </div>
    )
  }

  const config = STEP_CONFIGS[currentStep]
  if (!config) return null

  const Icon = config.icon

  // For view-artifact step, don't pass onTargetClick
  // The ArtifactRail handles completion after opening the file
  const handleTargetClick = currentStep === 'view-artifact' ? undefined : nextStep

  return (
    <Spotlight
      targetSelector={config.targetSelector}
      tooltipPosition={config.tooltipPosition}
      showSkip={true}
      onSkip={skipOnboarding}
      onTargetClick={handleTargetClick}
    >
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl bg-card flex items-center justify-center flex-shrink-0 border border-border ${config.iconColor}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold mb-1">{t(config.titleKey)}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t(config.descriptionKey)}
          </p>
          {config.buttonText && (
            <button
              onClick={nextStep}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium
                bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
            >
              {config.buttonText}
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mt-4 pt-3 border-t border-border">
        {['halo-space', 'send-message', 'view-artifact'].map((step, index) => (
          <div
            key={step}
            className={`w-2 h-2 rounded-full transition-colors ${
              step === currentStep
                ? 'bg-primary'
                : index < ['halo-space', 'send-message', 'view-artifact'].indexOf(currentStep)
                ? 'bg-primary/50'
                : 'bg-muted'
            }`}
          />
        ))}
        <span className="text-xs text-muted-foreground ml-2">
          {['halo-space', 'send-message', 'view-artifact'].indexOf(currentStep) + 1} / 3
        </span>
      </div>
    </Spotlight>
  )
}
