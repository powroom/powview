import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { RoleSheet } from '@/components/app/role-sheet'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Frame, FramePanel } from '@/components/ui/frame'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { connectionQuery, roleDetailsQuery } from '@/lib/queries'

// the dialog's code loads with this page
const LazyCreateRoleDialog = lazy(() =>
  import('@/components/app/create-role-dialog').then((m) => ({ default: m.CreateRoleDialog })),
)

export const Route = createFileRoute('/c/$connId/$db/roles')({
  head: () => ({ meta: [{ title: 'Roles · pow/view' }] }),
  component: RolesPage,
})

// name bar widths for the loading rows; the rows keep the real height
const SKELETON_NAME_WIDTHS = ['w-32', 'w-44', 'w-24', 'w-40', 'w-36']

function RolesPage() {
  const { connId, db } = Route.useParams()
  const { data: connection } = useQuery(connectionQuery(connId))
  const { data: roles, error, isPending } = useQuery(roleDetailsQuery(connId))
  const [editingName, setEditingName] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const readOnly = connection?.readOnly ?? false
  const editing = roles?.find((r) => r.name === editingName) ?? null
  const currentUser = roles?.find((r) => r.isCurrentUser)?.name ?? ''

  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-heading font-semibold text-2xl tracking-tight">Roles</h1>
            <p className="mt-1 text-muted-foreground text-sm">Users and groups on this server</p>
          </div>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button disabled={readOnly} onClick={() => setCreateOpen(true)}>
                <PlusIcon aria-hidden="true" />
                New role
              </Button>
            </TooltipTrigger>
            {readOnly && <TooltipPopup>This connection is read-only</TooltipPopup>}
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
                  <TableHead>Type</TableHead>
                  <TableHead className="hidden md:table-cell">Member of</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
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
                        <TableCell>
                          <span className="flex h-5 items-center">
                            <Skeleton className="h-3 w-12" />
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="flex h-5 items-center">
                            <Skeleton className="h-3 w-40" />
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="flex h-5 items-center justify-end">
                            <Skeleton className="h-3 w-6" />
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  : roles?.map((r) => (
                      <TableRow
                        className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        key={r.name}
                        onClick={() => setEditingName(r.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setEditingName(r.name)
                          }
                        }}
                        tabIndex={0}
                        title={`Edit ${r.name}`}
                      >
                        <TableCell className="max-w-40 sm:max-w-none">
                          <span className="flex h-5 min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate font-medium">{r.name}</span>
                            {r.isCurrentUser && (
                              <Badge size="sm" variant="secondary">
                                You
                              </Badge>
                            )}
                            {r.superuser && (
                              <Badge size="sm" variant="warning">
                                Superuser
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{r.canLogin ? 'User' : 'Group'}</TableCell>
                        <TableCell className="hidden max-w-0 w-full text-muted-foreground md:table-cell">
                          <span className="block truncate">{r.memberOf.join(', ')}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.sessions}</TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </FramePanel>
        </Frame>
      </div>

      <RoleSheet
        connectionId={connId}
        currentUser={currentUser}
        database={db}
        names={(roles ?? []).map((r) => r.name)}
        onClose={() => setEditingName(null)}
        readOnly={readOnly}
        role={editing}
      />
      <Suspense fallback={null}>
        <LazyCreateRoleDialog
          connectionId={connId}
          database={db}
          names={roles?.map((r) => r.name)}
          onOpenChange={setCreateOpen}
          open={createOpen}
        />
      </Suspense>
    </div>
  )
}
