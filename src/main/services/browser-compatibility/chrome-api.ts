/** Executed in each website's own world; keep this function self-contained. */
function installChromeApis(): void {
  type ChromeObject = Record<string, unknown>
  const page = window as Window & { chrome?: ChromeObject }
  const chrome = page.chrome ?? {}
  if (!page.chrome) {
    Object.defineProperty(page, 'chrome', { value: chrome, configurable: true, enumerable: true, writable: true })
  }

  if (!('app' in chrome)) {
    const noArguments = (method: string, args: unknown[]) => {
      if (args.length) throw new TypeError(`Error in invocation of app.${method}(): No matching signature.`)
    }
    // Browser pages are not installed Chrome hosted apps.
    chrome.app = {
      isInstalled: false,
      getDetails: function getDetails(...args: unknown[]) {
        noArguments('getDetails', args)
        return null
      },
      getIsInstalled: function getIsInstalled(...args: unknown[]) {
        noArguments('getIsInstalled', args)
        return false
      },
      installState: function installState(...args: unknown[]) {
        const callback = args[0]
        if (args.length > 1 || (callback !== undefined && typeof callback !== 'function')) {
          throw new TypeError('Error in invocation of app.installState(optional function callback): No matching signature.')
        }
        if (typeof callback === 'function') queueMicrotask(() => callback('not_installed'))
      },
      runningState: function runningState(...args: unknown[]) {
        noArguments('runningState', args)
        return 'cannot_run'
      },
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    }
  }

  const navigation = () => performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const transition = (entry: PerformanceNavigationTiming | undefined): [string, number] => {
    if (entry?.type === 'reload') return ['Reload', 16]
    if (entry?.type === 'back_forward') return ['BackForward', 6]
    // Navigation Timing does not distinguish links from form submissions.
    return ['Other', 15]
  }

  if (!('csi' in chrome)) {
    chrome.csi = function () {
      const timing = performance.timing
      return {
        startE: timing.navigationStart,
        onloadT: timing.domContentLoadedEventEnd,
        pageT: performance.now(),
        tran: transition(navigation())[1],
      }
    }
  }

  if (!('loadTimes' in chrome)) {
    chrome.loadTimes = function () {
      const timing = performance.timing
      const entry = navigation()
      const protocol = entry?.nextHopProtocol ?? ''
      const multiplexed = ['h2', 'h3', 'quic'].includes(protocol)
      const paint = performance.getEntriesByName('first-paint')[0]
      return {
        requestTime: timing.navigationStart / 1000,
        startLoadTime: timing.navigationStart / 1000,
        commitLoadTime: timing.responseStart / 1000,
        finishDocumentLoadTime: timing.domContentLoadedEventEnd / 1000,
        finishLoadTime: timing.loadEventEnd / 1000,
        firstPaintTime: paint ? (performance.timeOrigin + paint.startTime) / 1000 : 0,
        firstPaintAfterLoadTime: 0,
        navigationType: transition(entry)[0],
        wasFetchedViaSpdy: multiplexed,
        wasNpnNegotiated: multiplexed,
        npnNegotiatedProtocol: multiplexed ? protocol : '',
        wasAlternateProtocolAvailable: false,
        connectionInfo: protocol,
      }
    }
  }
}

export const CHROME_API_SCRIPT = `(${installChromeApis.toString()})()`
