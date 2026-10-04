/**
 * Diff controls of the changes view: previous / next change (Shift+F7 / F7),
 * side by side or inline, folding unchanged lines, folding every file. On a
 * narrow canvas the less used ones move into a "More options" menu.
 */

import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ChevronsDownUp, ChevronsUpDown, Columns2, FoldVertical, MoreHorizontal } from 'lucide-react'
import { useTranslation } from '../../../../../i18n'
import { Menu, MenuItem } from '../shared/Menu'
import { IconButton } from '../shared/parts'

interface DiffToolsProps {
  onPrevious: () => void
  onNext: () => void
  sideBySide: boolean
  /** Side by side is possible at this width (the toggle is disabled otherwise). */
  sideBySideFits: boolean
  onSideBySide: (on: boolean) => void
  collapseUnchanged: boolean
  onCollapseUnchanged: (on: boolean) => void
  /** Every visible file is folded. */
  allFolded: boolean
  onFoldAll: (fold: boolean) => void
  /** Folding toggles go into the menu. */
  compact: boolean
  /** Change navigation goes into the menu too. */
  minimal: boolean
}

export function DiffTools(props: DiffToolsProps) {
  const { t } = useTranslation()
  const { onPrevious, onNext, sideBySide, sideBySideFits, onSideBySide, collapseUnchanged, onCollapseUnchanged, allFolded, onFoldAll, compact, minimal } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const foldLabel = allFolded ? t('Expand all files') : t('Collapse all files')
  const sideBySideLabel = sideBySideFits ? t('Side by side') : t('Side by side needs a wider canvas')

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {!minimal && (
        <>
          <IconButton label={`${t('Previous change')} (⇧F7)`} onClick={onPrevious}>
            <ChevronUp size={15} />
          </IconButton>
          <IconButton label={`${t('Next change')} (F7)`} onClick={onNext}>
            <ChevronDown size={15} />
          </IconButton>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        </>
      )}
      {sideBySideFits && (
        <IconButton label={sideBySideLabel} pressed={sideBySide} onClick={() => onSideBySide(!sideBySide)}>
          <Columns2 size={15} />
        </IconButton>
      )}
      {!sideBySideFits && !minimal && (
        <IconButton label={sideBySideLabel} pressed={false} disabled>
          <Columns2 size={15} />
        </IconButton>
      )}
      {!compact && (
        <>
          <IconButton label={t('Collapse unchanged regions')} pressed={collapseUnchanged} onClick={() => onCollapseUnchanged(!collapseUnchanged)}>
            <FoldVertical size={15} />
          </IconButton>
          <IconButton label={foldLabel} onClick={() => onFoldAll(!allFolded)}>
            {allFolded ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />}
          </IconButton>
        </>
      )}
      {compact && (
        <>
          <IconButton
            ref={moreRef}
            label={t('More options')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal size={15} />
          </IconButton>
          <Menu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={moreRef} label={t('More options')} align="end">
            {minimal && (
              <>
                <MenuItem icon={<ChevronUp size={14} />} onSelect={() => { setMenuOpen(false); onPrevious() }}>{t('Previous change')}</MenuItem>
                <MenuItem icon={<ChevronDown size={14} />} onSelect={() => { setMenuOpen(false); onNext() }}>{t('Next change')}</MenuItem>
              </>
            )}
            <MenuItem checked={collapseUnchanged} onSelect={() => { setMenuOpen(false); onCollapseUnchanged(!collapseUnchanged) }}>
              {t('Collapse unchanged regions')}
            </MenuItem>
            <MenuItem
              icon={allFolded ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
              onSelect={() => { setMenuOpen(false); onFoldAll(!allFolded) }}
            >
              {foldLabel}
            </MenuItem>
          </Menu>
        </>
      )}
    </div>
  )
}
