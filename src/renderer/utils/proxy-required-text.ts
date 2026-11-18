import { parseProxyRequired, parseProxyRequiredDetail } from '../../shared/constants/proxy-required'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * The interface-language reading of a proxy-required refusal found anywhere in
 * `error`, or null when it holds none.
 */
export function proxyRequiredText(error: string, t: Translate): string | null {
  switch (parseProxyRequired(error)) {
    case 'none':
      return t('Claude and ChatGPT are set to connect only through a proxy, but no proxy is available. Set a proxy in Settings > System, or turn that option off.')
    case 'bypassed':
      return t('Claude and ChatGPT are set to connect only through a proxy, but this address is on the list that skips the proxy. Remove it from that list in Settings > System, or turn the option off.')
    case 'unreachable': {
      const address = parseProxyRequiredDetail(error)
      return address
        ? t('Claude and ChatGPT are set to connect only through a proxy, but the proxy {{address}} cannot be reached. Check that your proxy app is running.', { address })
        : t('Claude and ChatGPT are set to connect only through a proxy, but the proxy cannot be reached. Check that your proxy app is running.')
    }
    default:
      return null
  }
}
