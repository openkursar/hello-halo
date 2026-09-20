import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useCapabilityInventory } from '../../hooks/useCapabilityInventory'
import { useTranslation } from '../../i18n'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { CapabilityDialog } from './CapabilityDialog'

export function CapabilityImpact({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const { data, loading, error, reload } = useCapabilityInventory()
  const resource = data?.entries.find(entry => entry.appId === appId)
  return <section className="rounded-xl border border-border bg-secondary/30 p-4 text-xs">
    <h3 className="font-medium text-foreground">{t('Shared resource')}</h3>
    {loading ? <Loader2 className="mt-2 h-4 w-4 animate-spin" /> : error ? <p className="mt-2 text-destructive">{t('Could not load affected digital humans.')} <button onClick={reload} className="text-primary">{t('Retry')}</button></p> : <>
      <p className="mt-2 text-muted-foreground">{resource?.type === 'skill' ? t('Edits, disabling and deletion affect everyone who inherits this skill. This list shows workspace availability, not evidence that a task has used it.') : t('Editing, disabling or deleting this connection affects the digital humans listed below. This list includes current workspace access and retained work that may still use this connection. Personal enable switches do not change this shared connection.')}</p>
      <ul className="mt-3 flex flex-wrap gap-2">{resource?.consumers.map(person => <li key={person.appId} className="rounded-full border border-border bg-background px-2 py-1"><button onClick={() => { const navigation = useAppsPageStore.getState(); navigation.setCurrentTab('my-digital-humans'); navigation.selectApp(person.appId, 'automation', person.spaceId ?? undefined) }} className="hover:text-primary">{person.name}</button>{person.retainedWork && <> · {t('Retained work may use')}</>}{person.currentScope === false ? null : person.chatAccess === true && !person.automationAccess ? <>{' · '}{t('Chat inherited')}</> : person.access === 'disabled' && <> · {t('Disabled for this person')}</>}</li>)}</ul>
      {!resource?.consumers.length && <p className="mt-2 text-muted-foreground">{t('No digital humans currently reference this resource. Workspace chats may still use it.')}</p>}
    </>}
  </section>
}

export function CapabilityChangeDialog({ appId, title, onConfirm, onClose }: {
  appId: string; title: string; onConfirm: () => Promise<void>; onClose: () => void
}) {
  const { t } = useTranslation()
  const inventory = useCapabilityInventory()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const resource = inventory.data?.entries.find(entry => entry.appId === appId)
  return <CapabilityDialog title={title} onClose={() => { if (!busy) onClose() }}>
    <div className="space-y-4 p-4">
      <p className="text-sm">{t('This changes a shared resource, not only the digital human you opened it from.')}</p>
      {inventory.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : inventory.error ? <p role="alert" className="text-sm text-destructive">{t('Could not verify the affected digital humans.')} <button onClick={inventory.reload}>{t('Retry')}</button></p> : <>
        <p className="text-sm text-muted-foreground">{t('{{count}} digital humans may be affected.', { count: resource?.consumers.length ?? 0 })}</p>
        <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">{resource?.consumers.map(person => <li key={person.appId}>{person.name}</li>)}</ul>
        <p className="text-xs text-muted-foreground">{t('Existing work is retained. If a required capability is removed, continuing work may need the connection or skill to be restored. Workspace chats may also be affected.')}</p>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{t('Could not apply this change. Your draft is retained. Please retry.')}</p>}
      <div className="flex justify-end gap-2">
        <button disabled={busy} onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-sm">{t('Cancel')}</button>
        <button disabled={busy || inventory.loading || !!inventory.error || !resource} onClick={async () => {
          setBusy(true); setError(false)
          try { await onConfirm(); onClose() } catch { console.warn('[CapabilityChangeDialog] Shared resource mutation failed', { appId }); setError(true) } finally { setBusy(false) }
        }} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? t('Saving...') : t('Confirm change')}</button>
      </div>
    </div>
  </CapabilityDialog>
}
