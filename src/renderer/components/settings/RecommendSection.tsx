/**
 * Recommend Section Component
 * Social sharing and recommendation features for Halo
 */

import { useState, useCallback } from 'react'
import { Star, Copy, Check, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

/** GitHub repository URL */
const GITHUB_URL = 'https://github.com/openkursar/hello-halo'

/** Share text templates */
const SHARE_TEXT_EN = 'Halo - An open-source AI assistant with browser automation. Create AI digital humans to automate tasks.'
const SHARE_TEXT_ZH = 'Halo - 开源 AI 助手，内置浏览器自动化，可创建 AI 数字人自动完成任务。'

/** Platform types for share modal */
type SharePlatform = 'wechat' | 'xiaohongshu' | 'bilibili' | null

/** Platform display info */
const PLATFORM_INFO: Record<Exclude<SharePlatform, null>, { nameKey: string; color: string }> = {
  wechat: { nameKey: 'WeChat', color: '#07c160' },
  xiaohongshu: { nameKey: 'Xiaohongshu', color: '#fe2c55' },
  bilibili: { nameKey: 'Bilibili', color: '#00a1d6' }
}

export function RecommendSection() {
  const { t, i18n } = useTranslation()

  // Copy state for main button
  const [copied, setCopied] = useState(false)

  // Share modal state
  const [sharePlatform, setSharePlatform] = useState<SharePlatform>(null)
  const [modalCopied, setModalCopied] = useState(false)

  // Get localized share text
  const getShareText = useCallback(() => {
    const isZh = i18n.language?.startsWith('zh')
    return isZh ? SHARE_TEXT_ZH : SHARE_TEXT_EN
  }, [i18n.language])

  // Get full share content (text + link)
  const getShareContent = useCallback(() => {
    return `${getShareText()}\n${GITHUB_URL}`
  }, [getShareText])

  // Handle Star on GitHub
  const handleStarGitHub = async () => {
    try {
      await api.openExternal(GITHUB_URL)
    } catch {
      window.open(GITHUB_URL, '_blank')
    }
  }

  // Handle copy link
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(GITHUB_URL)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('[RecommendSection] Failed to copy:', error)
    }
  }

  // Handle platform share (open modal)
  const handlePlatformShare = (platform: SharePlatform) => {
    setSharePlatform(platform)
    setModalCopied(false)
  }

  // Handle Weibo share (direct link)
  const handleWeiboShare = async () => {
    const text = encodeURIComponent(getShareText())
    const url = encodeURIComponent(GITHUB_URL)
    const weiboUrl = `https://service.weibo.com/share/share.php?url=${url}&title=${text}`
    try {
      await api.openExternal(weiboUrl)
    } catch {
      window.open(weiboUrl, '_blank')
    }
  }

  // Handle Twitter/X share (direct link)
  const handleTwitterShare = async () => {
    const text = encodeURIComponent(getShareText())
    const url = encodeURIComponent(GITHUB_URL)
    const twitterUrl = `https://twitter.com/intent/tweet?text=${text}&url=${url}`
    try {
      await api.openExternal(twitterUrl)
    } catch {
      window.open(twitterUrl, '_blank')
    }
  }

  // Handle copy in modal
  const handleModalCopy = async () => {
    try {
      await navigator.clipboard.writeText(getShareContent())
      setModalCopied(true)
      setTimeout(() => setModalCopied(false), 2000)
    } catch (error) {
      console.error('[RecommendSection] Failed to copy:', error)
    }
  }

  // Close modal
  const handleCloseModal = () => {
    setSharePlatform(null)
    setModalCopied(false)
  }

  return (
    <>
      <section id="recommend" className="bg-card rounded-xl border border-border-faint p-6">
        <h2 className="text-lg font-medium mb-2">{t('Recommend Halo')}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {t('Like it? Help spread the word')}
        </p>

        {/* Primary Actions */}
        <div className="flex flex-wrap gap-3 mb-4">
          {/* Star on GitHub */}
          <button
            onClick={handleStarGitHub}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#24292f] hover:bg-[#32383f] text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Star className="w-4 h-4" />
            {t('Star on GitHub')}
          </button>

          {/* Copy Link */}
          <button
            onClick={handleCopyLink}
            className="inline-flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/80 rounded-lg text-sm font-medium transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 text-green-500" />
                <span className="text-green-500">{t('Copied!')}</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                {t('Copy Link')}
              </>
            )}
          </button>
        </div>

        {/* Social Share */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('Share to')}:</span>

          {/* WeChat */}
          <button
            onClick={() => handlePlatformShare('wechat')}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[#07c160] hover:bg-[#06ad56] transition-colors"
            title={t('WeChat')}
          >
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.02-.407-.032zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/>
            </svg>
          </button>

          {/* Xiaohongshu */}
          <button
            onClick={() => handlePlatformShare('xiaohongshu')}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[#fe2c55] hover:bg-[#e5284d] transition-colors"
            title={t('Xiaohongshu')}
          >
            <span className="text-white text-sm font-bold">小</span>
          </button>

          {/* Bilibili */}
          <button
            onClick={() => handlePlatformShare('bilibili')}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[#00a1d6] hover:bg-[#0091c2] transition-colors"
            title={t('Bilibili')}
          >
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z"/>
            </svg>
          </button>

          {/* Weibo */}
          <button
            onClick={handleWeiboShare}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[#e6162d] hover:bg-[#cc1428] transition-colors"
            title={t('Weibo')}
          >
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10.098 20.323c-3.977.391-7.414-1.406-7.672-4.02-.259-2.609 2.759-5.047 6.74-5.441 3.979-.394 7.413 1.404 7.671 4.018.259 2.6-2.759 5.049-6.739 5.443zM9.05 17.219c-.384.616-1.208.884-1.829.602-.612-.279-.793-.991-.406-1.593.379-.595 1.176-.861 1.793-.601.622.263.82.972.442 1.592zm1.27-1.627c-.141.237-.449.353-.689.253-.236-.09-.313-.361-.177-.586.138-.227.436-.346.672-.24.239.09.315.36.18.573h.014zm.176-2.719c-1.893-.493-4.033.45-4.857 2.118-.836 1.704-.026 3.591 1.886 4.21 1.983.64 4.318-.341 5.132-2.179.8-1.793-.201-3.642-2.161-4.149zm7.563-1.224c-.346-.105-.577-.18-.4-.646.384-.998.424-1.86.003-2.474-.789-1.151-2.951-1.09-5.418-.032 0 0-.776.338-.578-.271.383-1.217.324-2.238-.271-2.826-1.353-1.339-4.953.045-8.042 3.091-2.318 2.283-3.663 4.709-3.663 6.821 0 4.04 5.236 6.499 10.361 6.499 6.714 0 11.187-3.878 11.187-6.955.001-1.858-1.578-2.91-3.179-3.207zm2.517-4.407c-.903-1.012-2.234-1.487-3.645-1.376l.034-.002c-.292.033-.507.29-.481.578a.531.531 0 0 0 .579.482l.009-.001c1.063-.088 2.065.28 2.748 1.033.683.747.96 1.762.76 2.779l-.007.025c-.063.294.124.582.418.646.294.064.584-.121.646-.418.262-1.353-.104-2.705-1.006-3.716l-.055-.03z"/>
            </svg>
          </button>

          {/* Twitter/X */}
          <button
            onClick={handleTwitterShare}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-black hover:bg-neutral-800 transition-colors"
            title="X (Twitter)"
          >
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
          </button>
        </div>
      </section>

      {/* Share Modal */}
      {sharePlatform && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={handleCloseModal}
        >
          <div
            className="bg-card rounded-2xl border border-border p-6 shadow-xl max-w-md w-full mx-4 animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center"
                  style={{ backgroundColor: PLATFORM_INFO[sharePlatform].color }}
                >
                  {sharePlatform === 'wechat' && (
                    <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18z"/>
                    </svg>
                  )}
                  {sharePlatform === 'xiaohongshu' && (
                    <span className="text-white text-xs font-bold">小</span>
                  )}
                  {sharePlatform === 'bilibili' && (
                    <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906z"/>
                    </svg>
                  )}
                </div>
                <h3 className="text-lg font-medium">
                  {t('Share to {{platform}}', { platform: t(PLATFORM_INFO[sharePlatform].nameKey) })}
                </h3>
              </div>
              <button
                onClick={handleCloseModal}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>

            {/* Share Content */}
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t('Copy the text below and paste it when sharing')}:
              </p>

              {/* Text Area */}
              <div className="bg-muted/50 rounded-lg p-4 text-sm leading-relaxed select-all">
                <p>{getShareText()}</p>
                <p className="mt-2 text-primary break-all">{GITHUB_URL}</p>
              </div>

              {/* Copy Button */}
              <button
                onClick={handleModalCopy}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg text-sm font-medium transition-colors"
              >
                {modalCopied ? (
                  <>
                    <Check className="w-4 h-4" />
                    {t('Copied!')}
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    {t('Copy to Clipboard')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
