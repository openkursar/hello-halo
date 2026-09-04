/**
 * Store Discover
 *
 * Generic renderer for the config-driven discover page. The main process
 * resolves the layout and every section's entries against the full index and
 * sends them in one payload; this file only maps each node to a primitive.
 * Empty and hidden nodes are already dropped upstream, so a section that
 * renders here always has something to show.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { api } from '../../api'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useDiscoverPage } from '../../hooks/useDiscoverPage'
import { useCategoryLabel } from '../../hooks/useStoreCategories'
import type { RegistryEntry, ResolvedCollection, ResolvedDiscoverNode } from '../../../shared/store/store-types'
import { StoreCard } from './StoreCard'
import { StoreGrid } from './StoreGrid'
import { RankBoard, rankBoardEntries, MIN_RANK_ENTRIES } from './RankBoard'
import { AppTypeIcon } from './AppTypeIcon'
import { AppTypeTag } from './AppTypeTag'
import { resolveLocaleText } from './discover/resolve'
import { resolveEntryI18n } from '../../utils/spec-i18n'
import { getCurrentLanguage, useTranslation } from '../../i18n'

function SectionLabel({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-[15px] font-bold text-foreground">{children}</h2>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  )
}

function CardGrid({ entries }: { entries: RegistryEntry[] }) {
  const selectStoreApp = useAppsPageStore(state => state.selectStoreApp)
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {entries.map(entry => (
        <StoreCard key={entry.slug} entry={entry} source="discover" onClick={() => selectStoreApp(entry.slug)} />
      ))}
    </div>
  )
}

/** Compact "official picks" card (mockup .featured-card): icon + name + type tag
 * and a two-line description, no install button. */
function FeaturedGrid({ entries }: { entries: RegistryEntry[] }) {
  const selectStoreApp = useAppsPageStore(state => state.selectStoreApp)
  // Funnel: the featured section becoming visible is a discovery impression.
  useEffect(() => {
    if (entries.length > 0) void api.trackEvent('store.featured.view', { count: entries.length })
  }, [entries.length])
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {entries.map(entry => (
        <FeaturedCard
          key={entry.slug}
          entry={entry}
          onSelect={() => {
            void api.trackEvent('store.card.click', { appId: entry.slug, appType: entry.type, source: 'featured' })
            selectStoreApp(entry.slug)
          }}
        />
      ))}
    </div>
  )
}

function FeaturedCard({ entry, onSelect }: { entry: RegistryEntry; onSelect: () => void }) {
  const { t } = useTranslation()
  const { name, description } = resolveEntryI18n(entry, getCurrentLanguage())
  const categoryLabel = useCategoryLabel(entry.type, entry.category)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      className="flex flex-col gap-2.5 w-full p-4 rounded-[10px] border border-border/60 bg-background text-left cursor-pointer transition-all hover:border-border hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <AppTypeIcon type={entry.type} icon={entry.icon} name={name} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-semibold text-foreground truncate min-w-0">{name}</span>
            <AppTypeTag type={entry.type} />
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {entry.category && entry.category !== 'other' ? categoryLabel : t('Other')}
          </p>
        </div>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{description}</p>
      )}
    </div>
  )
}

function CollectionCard({ collection }: { collection: ResolvedCollection }) {
  const { t } = useTranslation()
  const selectStoreApp = useAppsPageStore(state => state.selectStoreApp)
  const [open, setOpen] = useState(false)
  const previewMembers = collection.entries.slice(0, 3)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex flex-col gap-2.5 p-4 rounded-[10px] border border-border/60 bg-background text-left transition-all hover:border-border hover:shadow-sm"
      >
        <div>
          {collection.label && (
            <span className="inline-block mb-1.5 px-1.5 py-px rounded text-[10.5px] leading-4 bg-primary/10 text-primary">
              {collection.label}
            </span>
          )}
          <div className="text-sm font-semibold text-foreground truncate">{collection.name}</div>
        </div>
        {collection.description && (
          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{collection.description}</p>
        )}
        <div className="flex items-center gap-2 mt-auto">
          <div className="flex items-center gap-1.5">
            {previewMembers.map(entry => (
              <AppTypeIcon key={entry.slug} type={entry.type} icon={entry.icon} name={entry.name} size="xs" />
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {t('{{count}} apps', { count: collection.entries.length })}
          </span>
        </div>
      </button>
      {open && (
        <CollectionDialog
          collection={collection}
          onClose={() => setOpen(false)}
          onSelect={slug => { setOpen(false); selectStoreApp(slug) }}
        />
      )}
    </>
  )
}

function CollectionDialog({
  collection,
  onClose,
  onSelect,
}: {
  collection: ResolvedCollection
  onClose: () => void
  onSelect: (slug: string) => void
}) {
  const { t } = useTranslation()
  const members = collection.entries

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onMouseDown={onClose}
    >
      <div
        className="relative w-full max-w-lg bg-background border border-border/60 rounded-xl shadow-xl flex flex-col max-h-[80vh] overflow-hidden"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-border/60 flex-shrink-0">
          <div className="min-w-0">
            {collection.label && (
              <span className="inline-block mb-1.5 px-1.5 py-px rounded text-[10.5px] leading-4 bg-primary/10 text-primary">
                {collection.label}
              </span>
            )}
            <h2 className="text-base font-semibold text-foreground">{collection.name}</h2>
            {collection.description && (
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{collection.description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground hover:text-foreground hover:border-border transition-colors"
            aria-label={t('Close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 bg-background">
          <div className="grid grid-cols-1 gap-3">
            {members.map(entry => (
              <StoreCard key={entry.slug} entry={entry} source="collection" onClick={() => onSelect(entry.slug)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A leaf node's content (label + primitive). `padded` wraps it in the page
 * section band for top-level use; row children pass it unwrapped. Returns null
 * (no wrapper, no stray heading) when the node has nothing to show.
 */
function SectionBody({ node, padded }: { node: ResolvedDiscoverNode; padded?: boolean }) {
  const { t } = useTranslation()
  const locale = getCurrentLanguage()
  const seedStoreApps = useAppsPageStore(state => state.seedStoreApps)
  const collections = node.collections ?? []
  const title = resolveLocaleText(node.title, locale)
  const subtitle = resolveLocaleText(node.subtitle, locale)
  const entries = node.entries ?? []

  // Keep the browse list in step with the catalog page that travelled with the
  // payload, so the grid and the curated sections describe the same snapshot.
  const isCatalog = node.type === 'catalog'
  useEffect(() => {
    if (isCatalog && node.entries) seedStoreApps(node.entries, node.hasMore ?? false)
  }, [isCatalog, node.entries, node.hasMore, seedStoreApps])

  const wrap = (content: ReactNode) =>
    padded ? <section className="px-4 pt-4">{content}</section> : <>{content}</>

  if (node.type === 'catalog') {
    return wrap(
      <>
        <SectionLabel>{title ?? t('All Apps')}</SectionLabel>
        <StoreGrid embedded />
      </>,
    )
  }

  if (node.layout === 'collections') {
    if (collections.length === 0) return null
    return wrap(
      <>
        <SectionLabel sub={subtitle}>{title ?? t('Scene Collections')}</SectionLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {collections.map(c => <CollectionCard key={c.id} collection={c} />)}
        </div>
      </>,
    )
  }

  if (entries.length === 0) return null

  if (node.layout === 'rank_board') {
    if (rankBoardEntries(entries).length < MIN_RANK_ENTRIES) return null
    // The board card carries its own title header, so no SectionLabel here.
    return wrap(<RankBoard title={title} entries={entries} />)
  }

  return wrap(
    <>
      <SectionLabel sub={subtitle}>{title}</SectionLabel>
      {node.layout === 'featured' ? <FeaturedGrid entries={entries} /> : <CardGrid entries={entries} />}
    </>,
  )
}

const ROW_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
}

function DiscoverRow({ node }: { node: ResolvedDiscoverNode }) {
  const locale = getCurrentLanguage()
  const title = resolveLocaleText(node.title, locale)
  const subtitle = resolveLocaleText(node.subtitle, locale)
  const cols = ROW_COLS[node.columns ?? 2] ?? ROW_COLS[2]
  const children = node.children ?? []
  if (children.length === 0) return null
  return (
    <section className="px-4 pt-4">
      {title && <SectionLabel sub={subtitle}>{title}</SectionLabel>}
      <div className={`grid ${cols} gap-4`}>
        {children.map((child, i) => <SectionBody key={i} node={child} />)}
      </div>
    </section>
  )
}

export function StoreDiscover() {
  const { t } = useTranslation()
  const page = useDiscoverPage()
  // Until the curated layout resolves — or if it never does — the catalog still
  // carries the store, so entering it never lands on a blank page.
  if (!page) {
    return (
      <div className="flex flex-col pb-8">
        <section className="px-4 pt-4">
          <SectionLabel>{t('All Apps')}</SectionLabel>
          <StoreGrid embedded />
        </section>
      </div>
    )
  }
  return (
    <div className="flex flex-col pb-8">
      {page.nodes.map((node, i) =>
        node.type === 'row'
          ? <DiscoverRow key={i} node={node} />
          : <SectionBody key={i} node={node} padded />,
      )}
    </div>
  )
}
