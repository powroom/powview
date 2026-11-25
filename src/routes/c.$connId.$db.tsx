import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, useMatchRoute, useNavigate, useParams, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import {
  BotIcon,
  EllipsisVerticalIcon,
  KeyboardIcon,
  PlugZapIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { touchConnectionFn } from '@/api/connections.functions'
import { ConnectionAvatar } from '@/components/app/brand'
import { CommandPalette } from '@/components/app/command-palette'
import { ExportDatabaseDialog } from '@/components/app/export-database-dialog'
import { RestoreDatabaseDialog } from '@/components/app/restore-database-dialog'
import { ConnectionDialog } from '@/components/app/connection-dialog'
import { ProductionGuardDialog } from '@/components/app/production-guard-dialog'
import { SettingsDialog } from '@/components/app/settings-dialog'
import { ShortcutsDialog } from '@/components/app/shortcuts-dialog'
import { UpdateNotice } from '@/components/app/update-dialog'
import { WorkspaceSidebar } from '@/components/app/workspace-sidebar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { modKey, useHotkey } from '@/hooks/use-hotkey'
import { connectionQuery, connectionsQuery, databasesQuery, schemasQuery, serverInfoQuery } from '@/lib/queries'
import { useAiAccessDialog } from '@/lib/ai-access-dialog'
import { useAppStore } from '@/lib/store'
import type { ConnectionInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/c/$connId/$db')({
  loader: async ({ params, context }) => {
    // the sidebar needs these on every load, so start them without waiting
    void context.queryClient.prefetchQuery(databasesQuery(params.connId))
    void context.queryClient.prefetchQuery(schemasQuery(params.connId, params.db))
    void context.queryClient.prefetchQuery(connectionsQuery())
    const [connection] = await Promise.all([
      context.queryClient.ensureQueryData(connectionQuery(params.connId)),
      // fail fast with a helpful error when the server is unreachable
      context.queryClient.ensureQueryData(serverInfoQuery(params.connId, params.db)),
    ])
    return { connection }
  },
  head: ({ params }) => ({ meta: [{ title: `${params.db} · pow/view` }] }),
  component: Workspace,
  pendingComponent: WorkspacePending,
  errorComponent: WorkspaceError,
  pendingMs: 150,
})

function readSidebarCookie(): boolean {
  if (typeof document === 'undefined') return true
  const m = /(?:^|; )sidebar_state=(true|false)/.exec(document.cookie)
  return m ? m[1] === 'true' : true
}

function Workspace() {
  const { connId, db } = Route.useParams()
  const { data: connection } = useQuery({
    ...connectionQuery(connId),
    initialData: Route.useLoaderData().connection,
  })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useHotkey('mod+k', () => setPaletteOpen((o) => !o), { allowInInputs: true })
  useHotkey('?', () => setShortcutsOpen((o) => !o))

  useEffect(() => {
    void touchConnectionFn({ data: { id: connId } }).catch(() => {})
  }, [connId])

  return (
    <SidebarProvider
      className="h-svh min-h-0"
      defaultOpen={readSidebarCookie()}
      style={{ '--sidebar-width': '17rem' } as React.CSSProperties}
    >
      <WorkspaceSidebar connection={connection} database={db} onEditConnection={() => setEditOpen(true)} />
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <WorkspaceHeader
          connection={connection}
          database={db}
          onOpenPalette={() => setPaletteOpen(true)}
          onShowSettings={() => setSettingsOpen(true)}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </SidebarInset>
      <CommandPalette
        connectionId={connId}
        database={db}
        onEditConnection={() => setEditOpen(true)}
        onOpenChange={setPaletteOpen}
        onShowSettings={() => setSettingsOpen(true)}
        onShowShortcuts={() => setShortcutsOpen(true)}
        open={paletteOpen}
      />
      <ExportDatabaseDialog connectionId={connId} database={db} />
      <RestoreDatabaseDialog
        connectionId={connId}
        connectionName={connection.name}
        database={db}
        production={connection.production === true}
        readOnly={connection.readOnly}
      />
      <ProductionGuardDialog />
      <ShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />
      <SettingsDialog onOpenChange={setSettingsOpen} open={settingsOpen} />
      <ConnectionDialog connection={connection} onOpenChange={setEditOpen} open={editOpen} />
    </SidebarProvider>
  )
}

function WorkspaceHeader({
  connection,
  database,
  onOpenPalette,
  onShowShortcuts,
  onShowSettings,
}: {
  connection: ConnectionInfo
  database: string
  onOpenPalette: () => void
  onShowShortcuts: () => void
  onShowSettings: () => void
}) {
  const navigate = useNavigate()
  const production = connection.production === true
  const matchRoute = useMatchRoute()
  const openSqlTab = useAppStore((s) => s.openSqlTab)
  const setAiAccessOpen = useAiAccessDialog((s) => s.setOpen)
  const params = useParams({ strict: false }) as { schema?: string; table?: string }
  const onSql = Boolean(matchRoute({ to: '/c/$connId/$db/sql', fuzzy: true }))
  const onDiagram = Boolean(matchRoute({ to: '/c/$connId/$db/diagram', fuzzy: true }))
  const onDatabases = Boolean(matchRoute({ to: '/c/$connId/$db/databases', fuzzy: true }))
  const onRoles = Boolean(matchRoute({ to: '/c/$connId/$db/roles', fuzzy: true }))
  const onServerPage = onDatabases || onRoles
  const pageLabel = onSql
    ? 'SQL editor'
    : onDiagram
      ? 'Diagram'
      : onDatabases
        ? 'Databases'
        : onRoles
          ? 'Roles'
          : 'Overview'

  const openNewQuery = () => {
    openSqlTab(connection.id, '')
    void navigate({ to: '/c/$connId/$db/sql', params: { connId: connection.id, db: database } })
  }

  return (
    <header
      className={cn(
        // a container: the header's width depends on the sidebar, so its parts size by it, not by the screen
        '@container/header flex h-12 shrink-0 items-center gap-2 border-b px-3',
        production && 'border-t-2 border-t-destructive',
      )}
    >
      <SidebarTrigger className="-ms-1" />
      <div className="mx-1 h-4 w-px bg-border" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Breadcrumb className="min-w-0 shrink">
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem className="min-w-4.5">
              <BreadcrumbLink
                className="flex min-w-4.5 items-center gap-1.5"
                render={
                  <Link
                    params={{ connId: connection.id, db: database }}
                    to={onServerPage ? '/c/$connId/$db/databases' : '/c/$connId/$db'}
                  />
                }
              >
                <ConnectionAvatar
                  className="size-4.5 rounded text-[0.55rem]"
                  color={connection.color}
                  name={connection.name}
                />
                {/* server pages (Databases, Roles) belong to the connection, not to the open database */}
                <span className="truncate">{onServerPage ? connection.name : database}</span>
              </BreadcrumbLink>
            </BreadcrumbItem>
            {params.schema && params.table ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem className="min-w-0 max-sm:hidden">
                  <span className="truncate text-muted-foreground">{params.schema}</span>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="max-sm:hidden" />
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate font-medium">{params.table}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate font-medium">{pageLabel}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <Button
        className="hidden w-56 justify-start font-normal text-muted-foreground @3xl/header:flex @5xl/header:w-72"
        onClick={onOpenPalette}
        size="sm"
        variant="outline"
      >
        <SearchIcon aria-hidden="true" />
        <span className="flex-1 text-start">Search…</span>
        <Kbd className="-me-1">{modKey} K</Kbd>
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Search"
              className="@3xl/header:hidden"
              onClick={onOpenPalette}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <SearchIcon />
        </TooltipTrigger>
        <TooltipPopup>Search ({modKey} K)</TooltipPopup>
      </Tooltip>
      <Button className="max-sm:hidden" onClick={openNewQuery} size="sm" variant="outline">
        <SquarePenIcon aria-hidden="true" />
        <span className="max-sm:hidden">New query</span>
      </Button>
      <UpdateNotice />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Keyboard shortcuts"
              // keyboard shortcuts do not apply on touch screens, and the header needs the room there
              className="max-sm:hidden"
              onClick={onShowShortcuts}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <KeyboardIcon />
        </TooltipTrigger>
        <TooltipPopup>Keyboard shortcuts (?)</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="AI access"
              className="max-sm:hidden"
              onClick={() => setAiAccessOpen(true)}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <BotIcon />
        </TooltipTrigger>
        <TooltipPopup>AI access</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Settings"
              className="max-sm:hidden"
              onClick={onShowSettings}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <SettingsIcon />
        </TooltipTrigger>
        <TooltipPopup>Settings</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger render={<Button aria-label="More" className="sm:hidden" size="icon-sm" variant="ghost" />}>
          <EllipsisVerticalIcon />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-44">
          <MenuItem onClick={openNewQuery}>
            <SquarePenIcon aria-hidden="true" />
            New query
          </MenuItem>
          <MenuItem onClick={() => setAiAccessOpen(true)}>
            <BotIcon aria-hidden="true" />
            AI access
          </MenuItem>
          <MenuItem onClick={onShowSettings}>
            <SettingsIcon aria-hidden="true" />
            Settings
          </MenuItem>
        </MenuPopup>
      </Menu>
    </header>
  )
}

function WorkspacePending() {
  return (
    <div className="flex h-svh items-center justify-center gap-3 text-muted-foreground text-sm">
      <Spinner />
      Connecting…
    </div>
  )
}

function WorkspaceError({ error, reset }: ErrorComponentProps) {
  const { connId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const retry = () => {
    reset()
    void router.invalidate()
  }
  const [editOpen, setEditOpen] = useState(false)
  const { data: connection } = useQuery({ ...connectionQuery(connId), retry: false })
  return (
    <Empty className="h-svh">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PlugZapIcon />
        </EmptyMedia>
        <EmptyTitle>Could not connect</EmptyTitle>
        <EmptyDescription className="whitespace-pre-line break-words">{(error as Error).message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button onClick={() => void navigate({ to: '/' })} variant="ghost">
          All connections
        </Button>
        {connection && (
          <Button onClick={() => setEditOpen(true)} variant="outline">
            Edit connection
          </Button>
        )}
        <Button onClick={retry}>Try again</Button>
      </EmptyContent>
      {connection && (
        <ConnectionDialog connection={connection} onOpenChange={setEditOpen} onSaved={retry} open={editOpen} />
      )}
    </Empty>
  )
}
