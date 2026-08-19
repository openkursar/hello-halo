/**
 * usePresetModels — race-safe model list fetcher for preset-API gateways.
 *
 * Used by the shared provider config form (`ProviderSelector`) in both the
 * first-run setup flow and the settings editor so the two stay in sync on:
 *   - AbortController-based cancellation when the apiKey changes mid-flight.
 *   - In-flight key validation at every state checkpoint (defense in depth).
 *   - Graceful fallback to a static model list on 401 / network / bad shape.
 *   - Auto-select of the first model when the previously selected one is no
 *     longer in the freshly fetched list.
 *
 * The hook does not own the selected model (`model` / `setModel`) — the
 * parent does — because the selected model participates in form validation,
 * save payloads, and capability lookups outside this hook's responsibility.
 *
 * When `enabled` is false the hook is inert (no fetches, no state churn);
 * this lets generic (non-preset) editor flows mount the hook unconditionally
 * without paying any cost.
 */

import { useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../types'
import { useTranslation } from '../i18n'

interface UsePresetModelsParams {
  /** Gateway base URL. Required when `enabled` is true. */
  baseUrl: string | undefined
  /** Path appended to baseUrl for the GET-models call. Default '/v1/models'. */
  modelsPath?: string
  /**
   * Static list shown when the live fetch fails (offline, 401, empty result,
   * unexpected shape). Also seeded as the initial visible list before the
   * user clicks Fetch.
   */
  fallbackModels?: ModelOption[]
  /** Current trimmed apiKey from the parent form. */
  apiKey: string
  /** Lifted state: currently selected model id. */
  model: string
  /** Lifted setter: hook calls this to auto-select when current model is dropped. */
  setModel: (id: string) => void
  /** When false, the hook is a complete no-op. Use for non-preset code paths. */
  enabled: boolean
}

interface UsePresetModelsResult {
  /** Visible model list — live results or fallback. */
  models: ModelOption[]
  /** True while a fetch is in flight. */
  isFetching: boolean
  /** Soft warning shown next to the model list when falling back. Null on clean state. */
  warning: string | null
  /** Triggers a fetch. No-op when key is empty or hook is disabled. */
  fetchModels: () => Promise<void>
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
  const trimmedPath = path.startsWith('/') ? path : `/${path}`
  return `${trimmedBase}${trimmedPath}`
}

export function usePresetModels(params: UsePresetModelsParams): UsePresetModelsResult {
  const { t } = useTranslation()
  const {
    baseUrl,
    modelsPath,
    fallbackModels,
    apiKey,
    model,
    setModel,
    enabled
  } = params

  // Initial visible list = fallback. Lazy-init so subsequent renders don't
  // reset the fetched list back to fallback.
  const [models, setModels] = useState<ModelOption[]>(() => fallbackModels ?? [])
  const [isFetching, setIsFetching] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)

  // Owner ref: which trimmed apiKey the in-flight (or last-completed) fetch
  // belongs to. Used as the second of the two race guards.
  const inFlightKey = useRef<string | null>(null)
  // Cancellation handle for the in-flight request.
  const abortRef = useRef<AbortController | null>(null)

  // Mirror reactive inputs into refs so the fetch closure always sees the
  // latest values without re-binding on every render.
  const modelRef = useRef(model)
  modelRef.current = model
  const setModelRef = useRef(setModel)
  setModelRef.current = setModel
  const fallbackRef = useRef(fallbackModels ?? [])
  fallbackRef.current = fallbackModels ?? []

  // When the user edits the apiKey AFTER a fetch was attempted, cancel any
  // in-flight request and reset the visible list to fallback so the user
  // knows they need to re-pull. (If no fetch has been attempted yet, leave
  // the initial/persisted list alone — this matters in EDIT mode where the
  // visible list is the user's saved availableModels.)
  useEffect(() => {
    if (!enabled) return
    const trimmed = apiKey.trim()
    if (inFlightKey.current === null || inFlightKey.current === trimmed) return

    abortRef.current?.abort()
    abortRef.current = null
    inFlightKey.current = null

    const fb = fallbackRef.current
    setModels(fb)
    setWarning(null)
    setIsFetching(false)
    if (fb.length > 0 && !fb.some(m => m.id === modelRef.current)) {
      setModelRef.current(fb[0].id)
    }
  }, [apiKey, enabled])

  // Abort on unmount so resolved fetches never call setState afterwards.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
      inFlightKey.current = null
    }
  }, [])

  const fetchModels = async (): Promise<void> => {
    if (!enabled || !baseUrl) return
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) return

    // Replace any previous controller before starting. abort() on a settled
    // controller is a documented no-op.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    inFlightKey.current = trimmedKey

    // Race predicate: each setState path checks this before mutating. A stale
    // fetch (key changed or unmount) becomes a silent no-op.
    const isCurrent = (): boolean =>
      !controller.signal.aborted && inFlightKey.current === trimmedKey

    setIsFetching(true)
    setWarning(null)

    const fb = fallbackRef.current
    const useFallback = (message: string): void => {
      if (!isCurrent()) return
      if (fb.length > 0) {
        setModels(fb)
        if (!fb.some(m => m.id === modelRef.current)) setModelRef.current(fb[0].id)
      } else {
        setModels([])
        setModelRef.current('')
      }
      setWarning(message)
    }

    try {
      const url = joinUrl(baseUrl, modelsPath ?? '/v1/models')
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${trimmedKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      })

      if (!isCurrent()) return

      if (response.status === 401 || response.status === 403) {
        useFallback(t('API Key is invalid or unauthorized. Showing offline model list.'))
        return
      }
      if (!response.ok) {
        useFallback(t('Failed to load model list from gateway. Showing offline model list.'))
        return
      }

      const data = await response.json()
      if (!isCurrent()) return

      if (!data || !Array.isArray(data.data)) {
        useFallback(t('Unrecognized model list response. Showing offline model list.'))
        return
      }

      const fetched: ModelOption[] = data.data
        .map((m: unknown): ModelOption | null => {
          if (!m || typeof m !== 'object') return null
          const obj = m as { id?: unknown, name?: unknown }
          if (typeof obj.id !== 'string') return null
          return { id: obj.id, name: typeof obj.name === 'string' ? obj.name : obj.id }
        })
        .filter((m: ModelOption | null): m is ModelOption => m !== null)

      if (fetched.length === 0) {
        useFallback(t('This API Key is not authorized for any models. Showing offline model list.'))
        return
      }

      if (!isCurrent()) return
      setModels(fetched)
      if (!fetched.some(m => m.id === modelRef.current)) {
        setModelRef.current(fetched[0].id)
      }
    } catch (err) {
      // AbortError is the expected outcome when the key changed mid-flight or
      // the component unmounted. Treat as a silent no-op rather than showing
      // the offline-list warning.
      if ((err as { name?: string } | null)?.name === 'AbortError') return
      useFallback(t('Unable to reach the gateway. Showing offline model list.'))
    } finally {
      if (isCurrent()) setIsFetching(false)
    }
  }

  return { models, isFetching, warning, fetchModels }
}
