import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../../api'
import type { CcInstallation, CcInstallRequest, CcRuntimeIssue, CcRuntimeStatus } from '../../../../shared/types/cc-runtime'
import { ccIssue, ccResult } from './response'

export const isInstalling = (status: CcRuntimeStatus | null) =>
  Boolean(status && ['manifest', 'downloading', 'verifying', 'checking'].includes(status.install.phase))

type Operation = { kind: 'select' | 'check' | 'scan'; path?: string }
type Failure = { issue?: CcRuntimeIssue }
const terminalKey = (status: CcRuntimeStatus | null) => status?.install.issue
  ? `${status.install.phase}:${status.install.version}:${status.install.issue}` : ''

export function useCcRuntime(onUse: () => Promise<boolean>) {
  const [status, setStatus] = useState<CcRuntimeStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<'selected' | 'ready' | 'preserved' | null>(null)
  const [installPending, setInstallPending] = useState(false)
  const [ignoredTerminal, setIgnoredTerminal] = useState('')
  const mounted = useRef(true)
  const pendingAction = useRef(false)
  const pendingInstall = useRef(false)
  const latestRead = useRef(0)
  const onUseRef = useRef(onUse)
  onUseRef.current = onUse

  const refresh = useCallback(async () => {
    const read = ++latestRead.current
    const next = ccResult(await api.ccRuntimeStatus())
    if (mounted.current && read === latestRead.current) {
      setStatus(next)
      setLoadFailed(false)
    }
    return next
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try { await refresh() } catch {
      if (mounted.current) setLoadFailed(true)
    } finally { if (mounted.current) setLoading(false) }
  }, [refresh])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false }
  }, [reload])

  const installing = installPending || isInstalling(status)
  useEffect(() => {
    if (!installing) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh() }
      catch { if (!cancelled) setLoadFailed(true) }
      if (!cancelled) timer = setTimeout(poll, 750)
    }
    timer = setTimeout(poll, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [installing, refresh])

  const run = async <T,>(next: Operation, task: () => Promise<T>): Promise<T | undefined> => {
    if (pendingAction.current) return
    pendingAction.current = true
    setOperation(next)
    setFailure(null)
    setNotice(null)
    setIgnoredTerminal(terminalKey(status))
    try { return await task() }
    catch (error) { if (mounted.current) setFailure({ issue: ccIssue(error) }) }
    finally {
      try { await refresh() } catch { if (mounted.current) setLoadFailed(true) }
      pendingAction.current = false
      if (mounted.current) setOperation(null)
    }
  }

  const select = (item: CcInstallation) => run({ kind: 'select', path: item.path }, async () => {
    ccResult(await api.ccRuntimeSelect(item.path))
    const activated = await onUseRef.current()
    if (mounted.current) setNotice(activated ? 'selected' : 'preserved')
  })

  const probe = (path: string) => run({ kind: 'check', path }, async () => {
    const result = ccResult(await api.ccRuntimeProbe(path))
    if (result.path === status?.selectedPath) await onUseRef.current()
    return result
  })
  const scan = () => run({ kind: 'scan' }, async () => {
    const result = ccResult(await api.ccRuntimeScan())
    if (result.installations.some(item => item.path === status?.selectedPath)) await onUseRef.current()
    return result
  })

  const install = async (request: CcInstallRequest) => {
    if (pendingInstall.current || isInstalling(status)) return
    pendingInstall.current = true
    setInstallPending(true)
    setFailure(null)
    setNotice(null)
    setIgnoredTerminal('')
    try {
      ccResult(await api.ccRuntimeInstall(request))
      const activated = await onUseRef.current()
      if (mounted.current) setNotice(activated ? 'ready' : 'preserved')
    } catch (error) {
      if (mounted.current) setFailure({ issue: ccIssue(error) })
    } finally {
      pendingInstall.current = false
      if (mounted.current) setInstallPending(false)
      try { await refresh() } catch { if (mounted.current) setLoadFailed(true) }
    }
  }

  const cancel = async () => {
    try { ccResult(await api.ccRuntimeCancel()); await refresh() }
    catch (error) { if (mounted.current) setFailure({ issue: ccIssue(error) }) }
  }

  const terminal = terminalKey(status)
  return {
    status, loading, loadFailed, reload, refresh, operation, installing, select, probe, scan, install, cancel, notice,
    failure: failure ?? (terminal && terminal !== ignoredTerminal ? { issue: status!.install.issue } : null),
  }
}
