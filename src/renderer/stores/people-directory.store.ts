import { create } from 'zustand'
import type { PeopleDirectoryPage, PeopleDirectoryQuery } from '../../shared/apps/people-directory'
import { api } from '../api'

interface DirectoryState {
  data: PeopleDirectoryPage | null
  query: PeopleDirectoryQuery | null
  loading: boolean
  error: boolean
  load: (query: PeopleDirectoryQuery) => Promise<void>
  refresh: () => Promise<void>
}
let generation = 0
export const usePeopleDirectoryStore = create<DirectoryState>((set, get) => ({
  data: null, query: null, loading: false, error: false,
  load: async query => {
    const request = ++generation
    set({ query, loading: true, error: false })
    try {
      const response = await api.appListPeople(query)
      if (!response.success || !response.data) throw new Error(response.error ?? 'Directory query rejected')
      if (request === generation) set({ data: response.data, loading: false })
    } catch (error) {
      console.warn('[PeopleDirectory] Summary query failed', { offset: query.offset, error })
      if (request === generation) set({ error: true, loading: false })
    }
  },
  refresh: async () => { const query = get().query; if (query) await get().load(query) },
}))
