import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { DatabaseSheet } from '@/components/app/database-sheet'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Frame, FramePanel } from '@/components/ui/frame'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { createDatabaseBlock } from '@/lib/databases'
import { formatBytes } from '@/lib/format'
import { allDatabasesQuery, connectionQuery, serverInfoQuery } from '@/lib/queries'

// the dialog's code loads with this page; the sidebar's copy stays in its own chunk
const LazyCreateDatabaseDialog = lazy(() =>
  import('@/components/app/create-database-dialog').then((m) => ({ default: m.CreateDatabaseDialog })),
)

export const Route = createFileRoute('/c/$connId/$db/databases')({
  head: () => ({ meta: [{ title: 'Databases · pow/view' }] }),
  component: DatabasesPage,
})

// name bar widths for the loading rows; the rows keep the real height
const SKELETON_NAME_WIDTHS = ['w-32', 'w-44', 'w-24', 'w-40', 'w-36']

function DatabasesPage() {
  const { connId, db } = Route.useParams()
  const { data: connection } = useQuery(connectionQuery(connId))
  const { data: server } = useQuery(serverInfoQuery(connId, db))
  const { data: databases, error, isPending } = useQuery(allDatabasesQuery(connId))
  const [editingName, setEditingName] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const createBlocked = createDatabaseBlock(connection, server)
  const editing = databases?.find((d) => d.name === editingName) ?? null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-heading font-semibold text-2xl tracking-tight">Databases</h1>
            <p className="mt-1 text-muted-foreground text-sm">Every database on this server</p>
          </div>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button disabled={Boolean(createBlocked)} onClick={() => setCreateOpen(true)}>
                <PlusIcon aria-hidden="true" />
                New database
              </Button>
            </TooltipTrigger>
            {createBlocked && <TooltipPopup>{createBlocked}</TooltipPopup>}
          </Tooltip>
        </div>

        {error && (
          <Alert variant="error">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        <Frame>
          <FramePanel aria-busy={isPending || undefined} className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Owner</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="hidden md:table-cell">Comment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending
                  ? SKELETON_NAME_WIDTHS.map((width, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <span className="flex h-5 items-center">
                            <Skeleton className={`h-3.5 ${width}`} />
                          </span>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="flex h-5 items-center">
                            <Skeleton className="h-3 w-20" />
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="flex h-5 items-center justify-end">
                            <Skeleton className="h-3 w-14" />
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="flex h-5 items-center justify-end">
                            <Skeleton className="h-3 w-6" />
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="flex h-5 items-center">
                            <Skeleton className="h-3 w-40" />
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  : databases?.map((d) => (
                      <TableRow
                        className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        key={d.name}
                        onClick={() => setEditingName(d.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setEditingName(d.name)
                          }
                        }}
                        tabIndex={0}
                        title={`Edit ${d.name}`}
                      >
                        <TableCell className="max-w-40 sm:max-w-none">
                          <span className="flex h-5 min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate font-medium">{d.name}</span>
                            {d.isCurrent && (
                              <Badge size="sm" variant="secondary">
                                Open
                              </Badge>
                            )}
                            {d.isTemplate && (
                              <Badge size="sm" variant="outline">
                                Template
                              </Badge>
                            )}
                            {!d.allowConnections && (
                              <Badge size="sm" variant="warning">
                                No connections
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">
                          <span className="block max-w-32 truncate">{d.owner}</span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {formatBytes(d.size)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{d.sessions}</TableCell>
                        <TableCell className="hidden max-w-0 w-full text-muted-foreground md:table-cell">
                          <span className="block truncate">{d.comment ?? ''}</span>
                        </TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </FramePanel>
        </Frame>
      </div>

      <DatabaseSheet
        connectionId={connId}
        currentDatabase={db}
        database={editing}
        defaultDatabase={connection?.database ?? db}
        names={(databases ?? []).map((d) => d.name)}
        onClose={() => setEditingName(null)}
        readOnly={connection?.readOnly ?? false}
      />
      <Suspense fallback={null}>
        <LazyCreateDatabaseDialog connectionId={connId} database={db} onOpenChange={setCreateOpen} open={createOpen} />
      </Suspense>
    </div>
  )
}
