/**
 * Splash Screen - Brand display on startup
 */

import { useEffect, useState } from 'react'
import { HaloLogo } from '../brand/HaloLogo'
import { useTranslation } from '../../i18n'

export function SplashScreen() {
  const { t } = useTranslation()
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    // Trigger animation after mount
    const timer = setTimeout(() => setAnimate(true), 100)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background">
      {/* Halo Logo */}
      <div
        className={`transition-all duration-1000 ${
          animate ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        <HaloLogo size="lg" />
      </div>

      {/* Brand Name */}
      <h1
        className={`mt-8 text-4xl font-light tracking-wider transition-all duration-1000 delay-300 ${
          animate ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        }`}
      >
        Halo
      </h1>

      {/* Tagline */}
      <p
        className={`mt-3 text-muted-foreground text-sm transition-all duration-1000 delay-500 ${
          animate ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        }`}
      >
        {t('AI that gets things done')}
      </p>
    </div>
  )
}
