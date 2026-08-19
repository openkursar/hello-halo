/**
 * Loading placeholder for the store grid — mirrors the StoreCard footprint so
 * the initial load reads as content arriving rather than a blank spinner.
 */

function SkeletonCard() {
  return (
    <div className="rounded-[10px] border border-border/60 bg-card p-4 flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-muted animate-pulse" />
        <div className="flex-1 flex flex-col gap-2">
          <div className="h-3.5 w-2/3 rounded bg-muted animate-pulse" />
          <div className="h-2.5 w-1/3 rounded bg-muted animate-pulse" />
        </div>
      </div>
      <div className="h-2.5 w-full rounded bg-muted animate-pulse" />
      <div className="h-2.5 w-4/5 rounded bg-muted animate-pulse" />
      <div className="mt-1 flex items-center justify-between">
        <div className="h-5 w-16 rounded bg-muted animate-pulse" />
        <div className="h-7 w-20 rounded-md bg-muted animate-pulse" />
      </div>
    </div>
  )
}

export function StoreSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}
