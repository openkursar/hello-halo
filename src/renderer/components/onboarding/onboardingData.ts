/**
 * Onboarding Preset Data
 *
 * Contains all pre-generated content for the onboarding flow:
 * - User prompt (displayed in input)
 * - AI response text
 * - HTML artifact content (a beautiful PPT introducing Halo)
 *
 * All text is built from i18n translations so onboarding follows the selected language.
 */

import type { TFunction } from 'i18next'

import i18n, { getCurrentLanguage } from '../../i18n'

export const ONBOARDING_ARTIFACT_NAME = 'halo-intro.html'
export const ONBOARDING_ARTIFACT_TYPE = 'file' as const

function getTranslator(translator?: TFunction): TFunction {
  return translator || i18n.t.bind(i18n)
}

export function getOnboardingPrompt(translator?: TFunction): string {
  const t = getTranslator(translator)
  return t(
    'Help me create an HTML slide deck introducing Halo (1920x1080) with a clean, modern style. Include: 1) What is Halo 2) Core capabilities 3) Use cases 4) Getting started'
  )
}

export function getOnboardingAiResponse(translator?: TFunction): string {
  const t = getTranslator(translator)
  return t(
    "Sure, I'll create a polished HTML presentation that introduces Halo's core features and how to use it. The slides use a modern, minimal design, support left/right arrow navigation, and fit 1920x1080."
  )
}

export function getOnboardingConversationTitle(translator?: TFunction): string {
  const t = getTranslator(translator)
  return t('Welcome to Halo')
}

export function getOnboardingHtmlArtifact(translator?: TFunction, lang: string = getCurrentLanguage()): string {
  const t = getTranslator(translator)

  const docTitle = t('Halo - AI that gets things done')
  const tagline = t('AI that gets things done')
  const whatIsHalo = t('What is Halo?')
  const moreThanChatTitle = t('More than chat')
  const moreThanChatDesc = t('Halo understands your goals, plans tasks, and can execute autonomously—not just answer questions.')
  const createsFilesTitle = t('Creates real files')
  const createsFilesDesc = t('Code, documents, spreadsheets, and web pages are saved as real files you can open anytime.')
  const naturalLangTitle = t('Natural language interface')
  const naturalLangDesc = t('Describe what you want in plain language; Halo will understand and act.')
  const localFirstTitle = t('Local-first')
  const localFirstDesc = t('Your data stays on your machine under your control. You can use your own API key.')
  const coreCapabilities = t('Core capabilities')
  const writeCodeTitle = t('Write code')
  const writeCodeDesc = t('Describe your needs and Halo will generate complete code across languages and frameworks.')
  const dataTitle = t('Work with data')
  const dataDesc = t('Analyze tables, generate reports, and organize data while AI handles the busywork.')
  const webTitle = t('Research with the web')
  const webDesc = t('Need fresh information? Halo can search online and summarize what matters.')
  const docsTitle = t('Write documents')
  const docsDesc = t('Reports, proposals, emails—tell Halo what you need and it will draft it.')
  const useCases = t('Use cases')
  const devsTitle = t('Developers')
  const devsDesc = t('Generate code quickly, debug issues, and scaffold projects.')
  const prosTitle = t('Professionals')
  const prosDesc = t('Write reports, build slides, organize meeting notes, and analyze data.')
  const creatorsTitle = t('Creators')
  const creatorsDesc = t('Write articles, design web pages, and generate ideas.')
  const learnersTitle = t('Learners')
  const learnersDesc = t('Answer questions, organize notes, and create study materials.')
  const readyText = t('Ready to start?')
  const startText = t('Start using Halo')
  const navHint = t('Use ← → to move between slides')

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1920, height=1080">
  <title>${docTitle}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
      overflow: hidden;
    }

    .slides {
      width: 1920px;
      height: 1080px;
      position: relative;
    }

    .slide {
      width: 1920px;
      height: 1080px;
      position: absolute;
      top: 0;
      left: 0;
      display: none;
      padding: 80px 120px;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
    }

    .slide.active {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    /* Slide 1: Title */
    .slide-1 {
      align-items: center;
      text-align: center;
    }

    .logo {
      width: 160px;
      height: 160px;
      border-radius: 50%;
      border: 4px solid #3b82f6;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 48px;
      box-shadow: 0 0 60px rgba(59, 130, 246, 0.3);
      animation: pulse 3s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 60px rgba(59, 130, 246, 0.3); }
      50% { box-shadow: 0 0 80px rgba(59, 130, 246, 0.5); }
    }

    .logo-inner {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), transparent);
    }

    h1 {
      font-size: 96px;
      font-weight: 700;
      margin-bottom: 24px;
      background: linear-gradient(135deg, #fff, #a5b4fc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .tagline {
      font-size: 36px;
      color: #a1a1aa;
      font-weight: 300;
    }

    /* Slide 2-4: Content slides */
    .slide-content h2 {
      font-size: 64px;
      font-weight: 600;
      margin-bottom: 60px;
      color: #fff;
    }

    .slide-content h2 span {
      color: #3b82f6;
    }

    .features {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 40px;
    }

    .feature {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 40px;
      transition: all 0.3s ease;
    }

    .feature:hover {
      border-color: rgba(59, 130, 246, 0.5);
      transform: translateY(-4px);
    }

    .feature-icon {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
      font-size: 32px;
    }

    .feature h3 {
      font-size: 28px;
      font-weight: 600;
      margin-bottom: 12px;
    }

    .feature p {
      font-size: 20px;
      color: #a1a1aa;
      line-height: 1.6;
    }

    /* Slide 4: Use cases */
    .use-cases {
      display: flex;
      gap: 32px;
    }

    .use-case {
      flex: 1;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 48px;
      text-align: center;
    }

    .use-case-icon {
      font-size: 48px;
      margin-bottom: 24px;
    }

    .use-case h3 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 16px;
    }

    .use-case p {
      font-size: 18px;
      color: #a1a1aa;
      line-height: 1.6;
    }

    /* Navigation hint */
    .nav-hint {
      position: absolute;
      bottom: 40px;
      right: 40px;
      padding: 10px 16px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #a1a1aa;
      font-size: 16px;
      backdrop-filter: blur(6px);
    }
  </style>
</head>
<body>
  <div class="slides">
    <!-- Slide 1: Title -->
    <section class="slide slide-1 active">
      <div class="logo">
        <div class="logo-inner"></div>
      </div>
      <h1>Halo</h1>
      <p class="tagline">${tagline}</p>
    </section>

    <!-- Slide 2: What is Halo -->
    <section class="slide slide-content">
      <h2>${whatIsHalo}</h2>
      <div class="features">
        <div class="feature">
          <div class="feature-icon">💬</div>
          <h3>${moreThanChatTitle}</h3>
          <p>${moreThanChatDesc}</p>
        </div>
        <div class="feature">
          <div class="feature-icon">📁</div>
          <h3>${createsFilesTitle}</h3>
          <p>${createsFilesDesc}</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🗣️</div>
          <h3>${naturalLangTitle}</h3>
          <p>${naturalLangDesc}</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🔒</div>
          <h3>${localFirstTitle}</h3>
          <p>${localFirstDesc}</p>
        </div>
      </div>
    </section>

    <!-- Slide 3: Core capabilities -->
    <section class="slide slide-content">
      <h2>${coreCapabilities}</h2>
      <div class="features">
        <div class="feature">
          <div class="feature-icon">💻</div>
          <h3>${writeCodeTitle}</h3>
          <p>${writeCodeDesc}</p>
        </div>
        <div class="feature">
          <div class="feature-icon">📊</div>
          <h3>${dataTitle}</h3>
          <p>${dataDesc}</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🌐</div>
          <h3>${webTitle}</h3>
          <p>${webDesc}</p>
        </div>
        <div class="feature">
          <div class="feature-icon">📝</div>
          <h3>${docsTitle}</h3>
          <p>${docsDesc}</p>
        </div>
      </div>
    </section>

    <!-- Slide 4: Use cases -->
    <section class="slide slide-content">
      <h2>${useCases}</h2>
      <div class="use-cases">
        <div class="use-case">
          <div class="use-case-icon">👩‍💻</div>
          <h3>${devsTitle}</h3>
          <p>${devsDesc}</p>
        </div>
        <div class="use-case">
          <div class="use-case-icon">📈</div>
          <h3>${prosTitle}</h3>
          <p>${prosDesc}</p>
        </div>
        <div class="use-case">
          <div class="use-case-icon">🎨</div>
          <h3>${creatorsTitle}</h3>
          <p>${creatorsDesc}</p>
        </div>
        <div class="use-case">
          <div class="use-case-icon">📚</div>
          <h3>${learnersTitle}</h3>
          <p>${learnersDesc}</p>
        </div>
      </div>
    </section>

    <!-- Slide 5: Call to action -->
    <section class="slide slide-1">
      <p class="tagline">${readyText}</p>
      <h1>${startText}</h1>
    </section>
  </div>

  <div class="nav-hint">${navHint}</div>

  <script>
    const slides = document.querySelectorAll('.slide')
    let currentSlide = 0

    function showSlide(index) {
      slides.forEach(slide => slide.classList.remove('active'))
      slides[index].classList.add('active')
    }

    function nextSlide() {
      currentSlide = (currentSlide + 1) % slides.length
      showSlide(currentSlide)
    }

    function prevSlide() {
      currentSlide = (currentSlide - 1 + slides.length) % slides.length
      showSlide(currentSlide)
    }

    window.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') {
        nextSlide()
      } else if (event.key === 'ArrowLeft') {
        prevSlide()
      }
    })

    // Auto play every 8 seconds
    setInterval(nextSlide, 8000)
  </script>
</body>
</html>`
}
