import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ClockIcon,
  GaugeIcon,
  HardDriveIcon,
  LayersIcon,
  PuzzleIcon,
  SquareFunctionIcon,
  TableIcon,
  EyeIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DatabaseHealth } from '@/components/app/database-health'
import { RunningQueries } from '@/components/app/running-queries'
import { relationIcons } from '@/components/app/relation-icons'
import { Badge } from '@/components/ui/badge'
import { Kbd } from '@/components/ui/kbd'
import { Frame, FrameHeader, FramePanel, FrameTitle } from '@/components/ui/frame'
import { Meter, MeterIndicator, MeterTrack } from '@/components/ui/meter'
import { Skeleton } from '@/components/ui/skeleton'
import { modKey } from '@/hooks/use-hotkey'
import { countLabel, formatBytes, formatCount, timeAgo } from '@/lib/format'
import { overviewQuery, serverInfoQuery, allRelationsQuery } from '@/lib/queries'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/c/$connId/$db/')({
  component: Overview,
})

function Overview() {
  const { connId, db } = Route.useParams()
  const remembered = useAppStore((s) => s.recent[`${connId}:${db}`]) ?? []
  // tables dropped or renamed since are left out
  const { data: relations } = useQuery(allRelationsQuery(connId, db))
  const existing = relations ? new Set(relations.map((r) => `${r.schema}\u0000${r.name}`)) : null
  const recent = existing ? remembered.filter((r) => existing.has(`${r.schema}\u0000${r.name}`)) : remembered
  const { data: server } = useQuery(serverInfoQuery(connId, db))
  const { data: overview, isPending } = useQuery(overviewQuery(connId, db))

  const maxBytes = Math.max(1, ...(overview?.largest.map((t) => t.bytes) ?? []))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate font-heading font-semibold text-2xl tracking-tight">{db}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
              {server ? (
                <>
                  <span>PostgreSQL {server.versionShort}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    signed in as <span className="font-medium text-foreground">{server.user}</span>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{server.encoding}</span>
                  <span aria-hidden="true">·</span>
                  <span>{server.timezone}</span>
                  {server.isSuperuser && <Badge variant="info">superuser</Badge>}
                  {server.readOnly && <Badge variant="warning">read-only</Badge>}
                </>
              ) : (
                <Skeleton className="h-5 w-80" />
              )}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat icon={TableIcon} label="Tables" loading={isPending} value={formatCount(overview?.counts.tables)} />
          <Stat icon={EyeIcon} label="Views" loading={isPending} value={formatCount(overview?.counts.views)} />
          <Stat
            icon={LayersIcon}
            label="Materialized"
            loading={isPending}
            value={formatCount(overview?.counts.matviews)}
          />
          <Stat
            icon={SquareFunctionIcon}
            label="Functions"
            loading={isPending}
            value={formatCount(overview?.counts.functions)}
          />
          <Stat icon={HardDriveIcon} label="Size" loading={!server} value={formatBytes(server?.databaseSize)} />
          <Stat
            icon={GaugeIcon}
            label="Cache hit"
            loading={isPending}
            value={overview?.cacheHitRatio != null ? `${overview.cacheHitRatio}%` : 'Unknown'}
          />
        </div>

        <RunningQueries connectionId={connId} database={db} />

        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-start">
          <Frame>
            <FrameHeader className="flex-row items-center justify-between py-3">
              <FrameTitle>Largest tables</FrameTitle>
              <span className="text-muted-foreground text-xs">by total size, incl. indexes</span>
            </FrameHeader>
            <FramePanel className="p-2">
              {isPending ? (
                // the query returns up to 8 tables; each row is the real link's grid with the same heights
                <div aria-busy="true" className="flex flex-col">
                  <span className="sr-only">Loading tables</span>
                  {LARGEST_NAME_WIDTHS.map((width, i) => (
                    <div
                      className="grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 rounded-lg px-3 py-2 text-sm"
                      key={i}
                    >
                      <span className="flex min-w-0 flex-col gap-1.5">
                        <span className="flex h-5 min-w-0 items-center gap-2">
                          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
                          <Skeleton className={cn('h-3', width)} />
                        </span>
                        <Skeleton className="h-1 rounded-full" />
                      </span>
                      <span className="flex h-4 items-center justify-end">
                        <Skeleton className="h-3 w-12" />
                      </span>
                      <span className="flex h-4 items-center justify-end">
                        <Skeleton className="h-3 w-12" />
                      </span>
                    </div>
                  ))}
                </div>
              ) : overview?.largest.length ? (
                <ul className="flex flex-col">
                  {overview.largest.map((t) => {
                    const Icon = relationIcons[t.kind]
                    return (
                      <li key={`${t.schema}.${t.name}`}>
                        <Link
                          className="grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                          params={{ connId, db, schema: t.schema, table: t.name }}
                          search={{}}
                          to="/c/$connId/$db/t/$schema/$table"
                        >
                          <span className="flex min-w-0 flex-col gap-1.5">
                            <span className="flex min-w-0 items-center gap-2">
                              <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
                              <span className="truncate font-medium">
                                {t.schema !== 'public' && <span className="text-muted-foreground">{t.schema}.</span>}
                                {t.name}
                              </span>
                            </span>
                            <Meter aria-label={`${t.name} size`} max={maxBytes} value={t.bytes}>
                              <MeterTrack className="h-1 rounded-full">
                                <MeterIndicator className="rounded-full bg-primary/70" />
                              </MeterTrack>
                            </Meter>
                          </span>
                          <span className="text-right text-muted-foreground text-xs tabular-nums">
                            {t.rows != null ? countLabel(t.rows, 'row', { compact: true }) : 'Rows unknown'}
                          </span>
                          <span className="text-right text-xs tabular-nums">{formatBytes(t.bytes)}</span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="p-6 text-center text-muted-foreground text-sm">No tables yet.</p>
              )}
            </FramePanel>
          </Frame>

          <div className="flex flex-col gap-6">
            <Frame>
              <FrameHeader className="flex-row items-center gap-2 py-3">
                <ClockIcon aria-hidden="true" className="size-4 opacity-60" />
                <FrameTitle>Recently opened</FrameTitle>
              </FrameHeader>
              <FramePanel className="p-2">
                {recent.length ? (
                  <ul className="flex flex-col">
                    {recent.map((r) => {
                      const Icon = relationIcons[r.kind]
                      return (
                        <li key={`${r.schema}.${r.name}`}>
                          <Link
                            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                            params={{ connId, db, schema: r.schema, table: r.name }}
                            search={{}}
                            to="/c/$connId/$db/t/$schema/$table"
                          >
                            <Icon aria-hidden="true" className="size-3.5 opacity-60" />
                            <span className="min-w-0 flex-1 truncate">
                              {r.schema !== 'public' && <span className="text-muted-foreground">{r.schema}.</span>}
                              {r.name}
                            </span>
                            <span className="text-muted-foreground text-xs">{timeAgo(r.at)}</span>
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="px-3 py-6 text-center text-muted-foreground text-sm">
                    Tables you open show up here. Press <Kbd>{modKey} K</Kbd> to jump to any table.
                  </p>
                )}
              </FramePanel>
            </Frame>

            <Frame>
              <FrameHeader className="flex-row items-center gap-2 py-3">
                <PuzzleIcon aria-hidden="true" className="size-4 opacity-60" />
                <FrameTitle>Extensions</FrameTitle>
              </FrameHeader>
              <FramePanel className="flex flex-wrap gap-2 p-4">
                {isPending ? (
                  <BadgeSkeleton />
                ) : (
                  overview?.extensions.map((e) => (
                    <Badge key={e.name} size="lg" variant="outline">
                      {e.name} <span className="font-normal text-muted-foreground">{e.version}</span>
                    </Badge>
                  ))
                )}
              </FramePanel>
            </Frame>
          </div>
        </div>

        <DatabaseHealth connectionId={connId} database={db} />
      </div>
    </div>
  )
}

const LARGEST_NAME_WIDTHS = ['w-44', 'w-36', 'w-52', 'w-40', 'w-32', 'w-48', 'w-40', 'w-28']

// two pills at the height of a Badge size="lg" (h-6.5, h-5.5 from sm)
function BadgeSkeleton() {
  return (
    <>
      <Skeleton className="h-6.5 w-24 sm:h-5.5" />
      <Skeleton className="h-6.5 w-20 sm:h-5.5" />
    </>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: LucideIcon
  label: string
  value: string
  loading?: boolean
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs/5">
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Icon aria-hidden="true" className="size-3.5" />
        {label}
      </span>
      {loading ? (
        <Skeleton className="h-8 w-16" />
      ) : (
        <span className="font-semibold text-2xl tabular-nums tracking-tight">{value}</span>
      )}
    </div>
  )
}
