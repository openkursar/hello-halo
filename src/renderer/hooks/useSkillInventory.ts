import { useCallback, useEffect, useState } from 'react'
import type { SkillInventory, SkillListQuery } from '../../shared/types/skills'
import { api } from '../api'
import { useTranslation } from '../i18n'

interface InventoryState {
  key: string
  data: SkillInventory | null
  loading: boolean
  error: string | null
}

export function useSkillInventory({ spaceId, q = '', source = 'all', offset = 0, limit = 50 }: SkillListQuery) {
  const { t } = useTranslation()
  const key = JSON.stringify([spaceId, q, source, offset, limit])
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<InventoryState>({ key, data: null, loading: true, error: null })
  const refresh = useCallback(() => setRevision(value => value + 1), [])

  useEffect(() => {
    let cancelled = false
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: null }))
    async function load() {
      try {
        const response = await api.skillsList({ spaceId, q, source, offset, limit })
        if (cancelled) return
        if (!response.success || !response.data) throw new Error(response.error || t('Unable to load skills'))
        setState({ key, data: response.data, loading: false, error: null })
      } catch (error) {
        if (cancelled) return
        console.warn('[SkillInventory] Failed to load selected skill page', { spaceId, source, offset, limit })
        setState(previous => ({
          key,
          data: previous.key === key ? previous.data : null,
          loading: false,
          error: error instanceof Error ? error.message : t('Unable to load skills'),
        }))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [key, spaceId, q, source, offset, limit, revision, t])

  return {
    data: state.key === key ? state.data : null,
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : null,
    refresh,
  }
}
