import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useMatchRoute, useNavigate, useParams } from '@tanstack/react-router'
import {
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  DatabaseIcon,
  DownloadIcon,
  EllipsisIcon,
  EraserIcon,
  FileCodeIcon,
  HomeIcon,
  LayoutGridIcon,
  LockIcon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareFunctionIcon,
  SquareTerminalIcon,
  UsersIcon,
  TableIcon,
  TablePropertiesIcon,
  Trash2Icon,
  TypeIcon,
  UnplugIcon,
  UploadIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Fragment, lazy, Suspense, useRef, useState } from 'react'
import { disconnectConnectionFn } from '@/api/connections.functions'
import { executeSqlFn } from '@/api/explorer.functions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from '@/components/ui/combobox'
import { Group as ButtonGroup } from '@/components/ui/group'
import { SelectButton } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { CreateObjectDialog, TableSettingsDialog } from '@/components/table/schema-editor'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { useHotkey } from '@/hooks/use-hotkey'
import { useRetained } from '@/hooks/use-retained'
import { useSelectedSchema } from '@/hooks/use-selected-schema'
import { copyWithToast } from '@/components/app/copy-feedback'
import { createDatabaseBlock } from '@/lib/databases'
import { formatBytes, formatCount, relationKindLabel } from '@/lib/format'
import { useExportDatabaseDialog } from '@/lib/export-database-dialog'
import { useRestoreDatabaseDialog } from '@/lib/restore-database-dialog'
import {
  connectionsQuery,
  databasesQuery,
  definitionQuery,
  keys,
  schemaObjectsQuery,
  schemasQuery,
  serverInfoQuery,
} from '@/lib/queries'
import { useProductionGuard } from '@/lib/production-guard'
import { displayQualified, qualifiedName } from '@/lib/sql'
import { classifySql } from '@/lib/sql-safety'
import { useAppStore } from '@/lib/store'
import type { ConnectionInfo, FunctionInfo, RelationInfo, RelationKind, TypeInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ConnectionAvatar } from './brand'
import { relationIcons } from './relation-icons'
import { ConfirmDialog } from './confirm-dialog'
import { DefinitionDialog } from './definition-dialog'
import type { DefinitionTarget } from './definition-dialog'

// The dialog is only needed once "New database" is opened, so its code is split out of the sidebar.
const LazyCreateDatabaseDialog = lazy(() =>
  import('./create-database-dialog').then((m) => ({ default: m.CreateDatabaseDialog })),
)

export function WorkspaceSidebar({
  connection,
  database,
  onEditConnection,
}: {
  connection: ConnectionInfo
  database: string
  onEditConnection: () => void
}) {
  const navigate = useNavigate()
  const connectionId = connection.id
  const canWrite = !connection.readOnly
  const [selectedSchema, setSchema] = useSelectedSchema(connectionId, database)
  const [filter, setFilter] = useState('')
  const [definition, setDefinition] = useState<DefinitionTarget | null>(null)
  const [relationAction, setRelationAction] = useState<RelationAction | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createDbMounted, setCreateDbMounted] = useState(false)
  const [createDbOpen, setCreateDbOpen] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  // The popups are anchored to their own trigger; the combobox default anchor is not set here.
  const databaseTriggerRef = useRef<HTMLButtonElement>(null)
  const schemaTriggerRef = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()
  const { isMobile, setOpenMobile } = useSidebar()
  // On phones the sidebar is a sheet; close it before a dialog opens so the two do not stack.
  const closeSheet = () => {
    if (isMobile) setOpenMobile(false)
  }
  const openRelationAction = (action: RelationAction) => {
    closeSheet()
    setRelationAction(action)
  }

  // Home first, so the open pages stop querying before the connection closes.
  const disconnect = async () => {
    try {
      await navigate({ to: '/' })
      await disconnectConnectionFn({ data: { id: connectionId } })
      void queryClient.invalidateQueries({ queryKey: keys.connected() })
      toastManager.add({
        type: 'success',
        title: 'Disconnected',
        description: `${connection.name} connects again when you open it.`,
      })
    } catch (err) {
      toastManager.add({ type: 'error', title: 'Disconnect failed', description: (err as Error).message })
    }
  }
  const setExportOpen = useExportDatabaseDialog((s) => s.setOpen)
  const setRestoreOpen = useRestoreDatabaseDialog((s) => s.setOpen)

  // The definition dialog opens once its SQL is loaded, so it appears at its final size
  // instead of growing out of a skeleton. Hovering an item starts the fetch early.
  const requestedDefinition = useRef<DefinitionTarget | null>(null)
  const prefetchDefinition = (t: Pick<DefinitionTarget, 'kind' | 'oid'>) =>
    queryClient.prefetchQuery(definitionQuery(connectionId, database, t.kind, t.oid))
  const openDefinition = (t: DefinitionTarget) => {
    closeSheet()
    requestedDefinition.current = t
    void queryClient
      .ensureQueryData(definitionQuery(connectionId, database, t.kind, t.oid))
      .catch(() => undefined) // the dialog shows the error
      .then(() => {
        if (requestedDefinition.current === t) setDefinition(t)
      })
  }

  const { data: databases } = useQuery(databasesQuery(connectionId))
  const { data: connections } = useQuery(connectionsQuery())
  const { data: schemas } = useQuery(schemasQuery(connectionId, database))
  const { data: server } = useQuery(serverInfoQuery(connectionId, database))
  // databases without a "public" schema: fall back to the first user schema
  const schema =
    schemas && !schemas.some((s) => s.name === selectedSchema)
      ? (schemas.find((s) => !s.isSystem)?.name ?? selectedSchema)
      : selectedSchema
  const objects = useQuery({
    ...schemaObjectsQuery(connectionId, database, schema),
    enabled: Boolean(schemas),
  })

  useHotkey('/', () => filterRef.current?.focus())

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.db(connectionId, database) })
    void queryClient.invalidateQueries({ queryKey: keys.databases(connectionId) })
    toastManager.add({ type: 'info', title: 'Metadata refreshed', timeout: 1500 })
  }

  const visibleSchemas = schemas ?? []
  const userSchemas = visibleSchemas.filter((s) => !s.isSystem)
  const systemSchemas = visibleSchemas.filter((s) => s.isSystem)
  // Grouped items for the schema combobox. A value outside these lists (the fallback above) still
  // shows in the trigger, because the combobox displays an unlisted string value as its text.
  const schemaGroups = [
    { value: 'Schemas', items: userSchemas.map((s) => s.name) },
    ...(systemSchemas.length > 0 ? [{ value: 'System', items: systemSchemas.map((s) => s.name) }] : []),
  ]
  const databaseList = databases ?? [{ name: database, size: null }]
  const databaseNames = databaseList.map((d) => d.name)
  // why "New database" cannot be used now, or null
  const createDbBlocked = createDatabaseBlock(connection, server)
  const openCreateDatabase = () => {
    closeSheet()
    setCreateDbMounted(true)
    setCreateDbOpen(true)
  }

  const needle = filter.trim().toLowerCase()

  const match = (name: string) => !needle || name.toLowerCase().includes(needle)
  const rel = objects.data?.relations ?? []
  const byKind = (kinds: RelationKind[]) => rel.filter((r) => kinds.includes(r.kind) && match(r.name))
  // partitions are listed under their table, not next to it
  const parents = new Set(rel.filter((r) => r.kind === 'p').map((r) => r.name))
  const isChild = (r: RelationInfo) => r.isPartition && Boolean(r.partitionOf && parents.has(r.partitionOf))
  const partitionsOf = new Map<string, RelationInfo[]>()
  for (const r of rel) {
    if (!isChild(r)) continue
    const list = partitionsOf.get(r.partitionOf!) ?? []
    list.push(r)
    partitionsOf.set(r.partitionOf!, list)
  }
  const tables = rel.filter(
    (r) =>
      (r.kind === 'r' || r.kind === 'p') &&
      !isChild(r) &&
      (match(r.name) || (partitionsOf.get(r.name) ?? []).some((p) => match(p.name))),
  )
  // while filtering, a table shows the partitions that match (all of them when the table itself does)
  const shownPartitions = new Map(
    [...partitionsOf].map(([name, list]) => [name, match(name) ? list : list.filter((p) => match(p.name))]),
  )
  const groups = {
    partitionsOf: shownPartitions,
    tables,
    views: byKind(['v']),
    matviews: byKind(['m']),
    foreign: byKind(['f']),
    functions: (objects.data?.functions ?? []).filter((f) => match(f.name)),
    types: (objects.data?.types ?? []).filter((t) => match(t.name)),
  }

  const total =
    groups.tables.length +
    groups.views.length +
    groups.matviews.length +
    groups.foreign.length +
    groups.functions.length +
    groups.types.length

  return (
    <>
      <Sidebar>
        <SidebarHeader className="gap-1.5 pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <Menu>
                <MenuTrigger render={<SidebarMenuButton className="data-popup-open:bg-sidebar-accent" size="lg" />}>
                  <ConnectionAvatar color={connection.color} name={connection.name} />
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium text-sidebar-accent-foreground">{connection.name}</span>
                      {connection.production && (
                        <Badge className="shrink-0" size="sm" variant="destructive">
                          Production
                        </Badge>
                      )}
                    </span>
                    <span className="truncate text-xs">
                      {connection.user}@{connection.host}
                    </span>
                  </span>
                  <ChevronsUpDownIcon aria-hidden="true" className="ms-auto size-4 opacity-60" />
                </MenuTrigger>
                <MenuPopup align="start" className="w-(--anchor-width) min-w-64">
                  <MenuGroup>
                    <MenuGroupLabel>Connections</MenuGroupLabel>
                    {(connections ?? []).map((c) => (
                      <MenuItem
                        key={c.id}
                        onClick={() => {
                          if (c.id !== connectionId) {
                            void navigate({ to: '/c/$connId', params: { connId: c.id } })
                          }
                        }}
                      >
                        <ConnectionAvatar className="size-5 rounded-md text-[0.6rem]" color={c.color} name={c.name} />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        {c.production && (
                          <Badge className="shrink-0" size="sm" variant="destructive">
                            Production
                          </Badge>
                        )}
                        {c.id === connectionId && (
                          <span className="flex shrink-0 items-center">
                            <CheckIcon aria-hidden="true" className="size-4 opacity-80" />
                          </span>
                        )}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => {
                      closeSheet()
                      onEditConnection()
                    }}
                  >
                    <PencilIcon aria-hidden="true" />
                    Edit connection
                  </MenuItem>
                  <MenuItem onClick={() => void navigate({ to: '/' })}>
                    <HomeIcon aria-hidden="true" />
                    All connections
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeSheet()
                      void disconnect()
                    }}
                  >
                    <UnplugIcon aria-hidden="true" />
                    Disconnect
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarGroup className="pb-0">
          <SidebarGroupLabel className={GROUP_LABEL}>Server</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <NavItem
                icon={DatabaseIcon}
                label="Databases"
                to="/c/$connId/$db/databases"
                params={{ connId: connectionId, db: database }}
              />
              <NavItem
                icon={UsersIcon}
                label="Roles"
                to="/c/$connId/$db/roles"
                params={{ connId: connectionId, db: database }}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="pb-0">
          <SidebarGroupLabel className={GROUP_LABEL}>Database</SidebarGroupLabel>
          <SidebarGroupContent>
            {/* the database picker belongs to this group: everything below it is about that database */}
            <div className="pb-1.5">
              <Combobox
                autoHighlight
                items={databaseNames}
                onValueChange={(v) => {
                  if (v && v !== database) {
                    void navigate({ to: '/c/$connId/$db', params: { connId: connectionId, db: v } })
                  }
                }}
                value={database}
              >
                {/* the same shape as the schema picker below: the list, then its + button */}
                <ButtonGroup className="w-full">
                  <ComboboxTrigger
                    ref={databaseTriggerRef}
                    render={<SelectButton aria-label="Database" className="min-w-0 flex-1 bg-background" size="sm" />}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <DatabaseIcon aria-hidden="true" className="size-3.5 opacity-60" />
                      <span className="truncate">
                        <ComboboxValue />
                      </span>
                    </span>
                  </ComboboxTrigger>
                  {!createDbBlocked && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label="New database"
                            onClick={openCreateDatabase}
                            size="icon-sm"
                            variant="outline"
                          />
                        }
                      >
                        <PlusIcon aria-hidden="true" className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup>New database</TooltipPopup>
                    </Tooltip>
                  )}
                </ButtonGroup>
                <ComboboxPopup anchor={databaseTriggerRef} aria-label="Databases">
                  <div className="border-b p-2">
                    <ComboboxInput
                      className="rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
                      placeholder="Search databases…"
                      showTrigger={false}
                      startAddon={<SearchIcon />}
                    />
                  </div>
                  <ComboboxEmpty>No databases found.</ComboboxEmpty>
                  <ComboboxList>
                    {(name: string) => {
                      const size = databaseList.find((d) => d.name === name)?.size
                      return (
                        <ComboboxItem key={name} value={name}>
                          <span className="flex w-full items-center justify-between gap-4">
                            <span className="truncate">{name}</span>
                            {size != null && (
                              <span className="text-muted-foreground text-xs tabular-nums">{formatBytes(size)}</span>
                            )}
                          </span>
                        </ComboboxItem>
                      )
                    }}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </div>
            <SidebarMenu className="gap-0.5">
              <NavItem
                icon={LayoutGridIcon}
                label="Overview"
                to="/c/$connId/$db"
                params={{ connId: connectionId, db: database }}
              />
              <NavItem
                icon={NetworkIcon}
                label="Diagram"
                to="/c/$connId/$db/diagram"
                params={{ connId: connectionId, db: database }}
              />
              <NavItem
                icon={SquareTerminalIcon}
                label="SQL editor"
                to="/c/$connId/$db/sql"
                params={{ connId: connectionId, db: database }}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <div className="flex flex-col gap-2 px-2 pt-3 pb-1">
          <Combobox autoHighlight items={schemaGroups} onValueChange={(v) => v && setSchema(v)} value={schema}>
            <ButtonGroup className="w-full">
              <ComboboxTrigger
                ref={schemaTriggerRef}
                render={<SelectButton aria-label="Schema" className="min-w-0 flex-1 bg-background" size="sm" />}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <BracesIcon aria-hidden="true" className="size-3.5 opacity-60" />
                  <span className="truncate">
                    <ComboboxValue />
                  </span>
                </span>
              </ComboboxTrigger>
              {canWrite && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="New table or schema"
                        onClick={() => {
                          closeSheet()
                          setCreateOpen(true)
                        }}
                        size="icon-sm"
                        variant="outline"
                      />
                    }
                  >
                    <PlusIcon aria-hidden="true" className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup>New table or schema</TooltipPopup>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={<Button aria-label="Refresh metadata" onClick={refresh} size="icon-sm" variant="outline" />}
                >
                  <RefreshCwIcon aria-hidden="true" className={cn('size-3.5', objects.isFetching && 'animate-spin')} />
                </TooltipTrigger>
                <TooltipPopup>Refresh metadata</TooltipPopup>
              </Tooltip>
            </ButtonGroup>
            <ComboboxPopup anchor={schemaTriggerRef} aria-label="Schemas">
              <div className="border-b p-2">
                <ComboboxInput
                  className="rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
                  placeholder="Search schemas…"
                  showTrigger={false}
                  startAddon={<SearchIcon />}
                />
              </div>
              <ComboboxEmpty>No schemas found.</ComboboxEmpty>
              <ComboboxList>
                {(group: { value: string; items: string[] }, index: number) => (
                  <Fragment key={group.value}>
                    <ComboboxGroup items={group.items}>
                      <ComboboxGroupLabel>{group.value}</ComboboxGroupLabel>
                      <ComboboxCollection>
                        {(name: string) => (
                          <ComboboxItem key={name} value={name}>
                            <span className="flex w-full items-center justify-between gap-4">
                              <span className="truncate">{name}</span>
                              <span className="text-muted-foreground text-xs tabular-nums">
                                {visibleSchemas.find((s) => s.name === name)?.relationCount}
                              </span>
                            </span>
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxGroup>
                    {index < schemaGroups.length - 1 && <ComboboxSeparator />}
                  </Fragment>
                )}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
          <InputGroup>
            <InputGroupInput
              aria-label="Filter objects"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setFilter('')
                  e.currentTarget.blur()
                }
              }}
              placeholder="Filter objects…"
              ref={filterRef}
              size="sm"
              spellCheck={false}
              value={filter}
            />
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            {!filter && (
              <InputGroupAddon align="inline-end">
                <Kbd>/</Kbd>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>

        <SidebarContent className="gap-0 pb-2">
          {objects.isPending ? (
            // the first group of the real list, with its label and item classes (RelationGroup, RelationItem)
            <SidebarGroup aria-busy="true" className="py-1">
              <span className="sr-only">Loading objects</span>
              <SidebarGroupLabel className="h-7 w-full gap-1 text-[0.7rem] tracking-wider">
                <Skeleton className="size-3.5 rounded-sm" />
                <Skeleton className="h-2.5 w-14" />
                <Skeleton className="ms-auto me-5 h-2.5 w-3" />
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-px">
                  {SKELETON_ITEM_WIDTHS.map((width, i) => (
                    <SidebarMenuItem key={i}>
                      <div className="flex h-7 w-full items-center gap-2 overflow-hidden rounded-lg p-2 pe-7 text-sm">
                        <Skeleton className="size-3.5 shrink-0 rounded-sm" />
                        <Skeleton className={cn('h-3', width)} />
                      </div>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : objects.error ? (
            <p className="px-4 py-3 text-destructive-foreground text-xs">{objects.error.message}</p>
          ) : total === 0 ? (
            <p className="px-4 py-6 text-center text-muted-foreground text-xs">
              {needle ? `Nothing matches “${filter}”` : 'This schema is empty.'}
            </p>
          ) : (
            <>
              <RelationGroup
                connectionId={connectionId}
                onAction={openRelationAction}
                database={database}
                forceOpen={Boolean(needle)}
                id="tables"
                items={groups.tables}
                label="Tables"
                partitionsOf={groups.partitionsOf}
                writable={canWrite}
              />
              <RelationGroup
                connectionId={connectionId}
                onAction={openRelationAction}
                database={database}
                forceOpen={Boolean(needle)}
                id="views"
                writable={canWrite}
                items={groups.views}
                label="Views"
              />
              <RelationGroup
                connectionId={connectionId}
                onAction={openRelationAction}
                database={database}
                forceOpen={Boolean(needle)}
                id="matviews"
                writable={canWrite}
                items={groups.matviews}
                label="Materialized views"
              />
              <RelationGroup
                connectionId={connectionId}
                onAction={openRelationAction}
                database={database}
                forceOpen={Boolean(needle)}
                id="foreign"
                writable={canWrite}
                items={groups.foreign}
                label="Foreign tables"
              />
              <ObjectGroup
                forceOpen={Boolean(needle)}
                icon={SquareFunctionIcon}
                id="functions"
                items={groups.functions.map((f: FunctionInfo) => ({
                  key: String(f.oid),
                  name: f.name,
                  hint: f.kind === 'p' ? 'proc' : f.kind === 'a' ? 'agg' : undefined,
                  title: `${f.name}(${f.args})${f.result ? ` → ${f.result}` : ''}`,
                  onPrefetch: () => void prefetchDefinition({ kind: 'function', oid: f.oid }),
                  onOpen: () =>
                    openDefinition({
                      kind: 'function',
                      oid: f.oid,
                      title: `${f.schema}.${f.name}(${f.args})`,
                      subtitle: [
                        f.kind === 'p' ? 'Procedure' : f.kind === 'a' ? 'Aggregate' : 'Function',
                        f.language,
                        f.result ? `returns ${f.result}` : null,
                        f.comment,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    }),
                }))}
                label="Functions"
              />
              <ObjectGroup
                forceOpen={Boolean(needle)}
                icon={TypeIcon}
                id="types"
                items={groups.types.map((ty: TypeInfo) => ({
                  key: String(ty.oid),
                  name: ty.name,
                  hint: ty.kind === 'e' ? 'enum' : ty.kind === 'd' ? 'domain' : ty.kind === 'r' ? 'range' : 'type',
                  title: ty.labels ? ty.labels.join(', ') : ty.name,
                  onPrefetch: () => void prefetchDefinition({ kind: 'type', oid: ty.oid }),
                  onOpen: () =>
                    openDefinition({
                      kind: 'type',
                      oid: ty.oid,
                      title: `${ty.schema}.${ty.name}`,
                      subtitle: ty.labels ? `Enum with ${ty.labels.length} values` : (ty.comment ?? undefined),
                    }),
                }))}
                label="Types"
              />
            </>
          )}
        </SidebarContent>

        <SidebarFooter className="border-sidebar-border border-t py-2">
          <div className="grid grid-cols-2 gap-1.5 px-2 pb-2">
            {/* both act on the database picked above, so the tooltips name it */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    onClick={() => {
                      closeSheet()
                      setExportOpen(true)
                    }}
                    size="sm"
                    variant="outline"
                  />
                }
              >
                <DownloadIcon aria-hidden="true" />
                Backup
              </TooltipTrigger>
              <TooltipPopup>Back up {database}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  // a disabled button gets no pointer events: the wrapper shows why
                  <span className="flex" />
                }
              >
                <Button
                  className="w-full"
                  disabled={connection.readOnly}
                  onClick={() => {
                    closeSheet()
                    setRestoreOpen(true)
                  }}
                  size="sm"
                  variant="outline"
                >
                  <UploadIcon aria-hidden="true" />
                  Restore
                </Button>
              </TooltipTrigger>
              <TooltipPopup>
                {connection.readOnly ? 'This connection is read-only.' : `Restore a backup into ${database}`}
              </TooltipPopup>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2 px-2 text-xs">
            <span
              aria-hidden="true"
              className={cn('size-1.5 rounded-full', server ? 'bg-success' : 'bg-muted-foreground/40')}
            />
            <span className="truncate">{server ? `PostgreSQL ${server.versionShort}` : 'Connecting…'}</span>
            {connection.readOnly && (
              <Badge className="ms-auto" variant="warning">
                <LockIcon aria-hidden="true" />
                Read-only
              </Badge>
            )}
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <DefinitionDialog
        connectionId={connectionId}
        database={database}
        onClose={() => {
          requestedDefinition.current = null
          setDefinition(null)
        }}
        target={definition}
      />
      <RelationActionDialog
        action={relationAction?.kind === 'rename' ? null : relationAction}
        connectionId={connectionId}
        database={database}
        onClose={() => setRelationAction(null)}
      />
      <RenameRelationDialog
        connectionId={connectionId}
        database={database}
        onClose={() => setRelationAction(null)}
        relation={relationAction?.kind === 'rename' ? relationAction.relation : null}
        siblings={(objects.data?.relations ?? []).map((r) => r.name)}
      />
      <CreateObjectDialog
        onOpenChange={setCreateOpen}
        onSchemaCreated={(name) => setSchema(name)}
        onTableCreated={(name) =>
          void navigate({
            to: '/c/$connId/$db/t/$schema/$table',
            params: { connId: connectionId, db: database, schema, table: name },
            search: { tab: 'structure' },
          })
        }
        open={createOpen}
        schemaNames={visibleSchemas.map((s) => s.name)}
        tableNames={(objects.data?.relations ?? []).map((r) => r.name)}
        target={{ connectionId, database, schema }}
      />
      {createDbMounted && (
        <Suspense fallback={null}>
          <LazyCreateDatabaseDialog
            connectionId={connectionId}
            database={database}
            onOpenChange={setCreateDbOpen}
            open={createDbOpen}
          />
        </Suspense>
      )}
    </>
  )
}

function NavItem({
  icon: Icon,
  label,
  to,
  params,
}: {
  icon: LucideIcon
  label: string
  to:
    | '/c/$connId/$db'
    | '/c/$connId/$db/diagram'
    | '/c/$connId/$db/sql'
    | '/c/$connId/$db/databases'
    | '/c/$connId/$db/roles'
  params: { connId: string; db: string }
}) {
  const matchRoute = useMatchRoute()
  const isActive = Boolean(matchRoute({ to, params }))
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={isActive} render={<Link params={params} to={to} />} size="sm">
        <Icon aria-hidden="true" />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

// name bar widths for the loading list; the rows themselves keep the real height
const SKELETON_ITEM_WIDTHS = ['w-3/5', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/4', 'w-1/2', 'w-1/3', 'w-3/5']

/** The small uppercase label over a group of sidebar rows. */
const GROUP_LABEL =
  'h-7 w-full gap-1 font-medium text-[0.7rem] text-sidebar-foreground/80 uppercase tracking-wider [&>svg]:size-3.5'

function GroupHeader({ id, label, count, open }: { id: string; label: string; count: number; open: boolean }) {
  const setCollapsed = useAppStore((s) => s.setGroupCollapsed)
  return (
    <SidebarGroupLabel
      aria-expanded={open}
      className={`${GROUP_LABEL} cursor-pointer hover:text-sidebar-accent-foreground`}
      onClick={() => setCollapsed(id, open)}
      render={<button type="button" />}
    >
      {open ? (
        <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-60" />
      ) : (
        <ChevronRightIcon aria-hidden="true" className="size-3.5 opacity-60" />
      )}
      {label}
      {/* lines up with the item counts, which leave room for their "⋯" button */}
      <span className="ms-auto me-5 font-normal tabular-nums tracking-normal opacity-70">{count}</span>
    </SidebarGroupLabel>
  )
}

type RelationAction = { kind: 'truncate' | 'drop' | 'rename'; relation: RelationInfo }

function RelationGroup({
  id,
  label,
  items,
  connectionId,
  database,
  forceOpen,
  onAction,
  partitionsOf,
  writable,
}: {
  id: string
  label: string
  items: RelationInfo[]
  connectionId: string
  database: string
  forceOpen: boolean
  onAction: (action: RelationAction) => void
  partitionsOf?: ReadonlyMap<string, RelationInfo[]>
  writable: boolean
}) {
  const collapsed = useAppStore((s) => s.collapsedGroups[id])
  const open = forceOpen || !collapsed
  if (items.length === 0) return null
  return (
    <SidebarGroup className="py-1">
      <GroupHeader count={items.length} id={id} label={label} open={open} />
      {open && (
        <SidebarGroupContent>
          <SidebarMenu className="gap-px">
            {items.map((rel) => (
              <RelationItem
                connectionId={connectionId}
                database={database}
                forceOpen={forceOpen}
                key={rel.oid}
                onAction={onAction}
                partitions={partitionsOf?.get(rel.name)}
                relation={rel}
                writable={writable}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  )
}

function RelationItem({
  relation: rel,
  connectionId,
  database,
  onAction,
  partitions,
  forceOpen,
  writable,
}: {
  relation: RelationInfo
  connectionId: string
  database: string
  onAction: (action: RelationAction) => void
  partitions?: RelationInfo[]
  forceOpen: boolean
  writable: boolean
}) {
  const partitionKey = `partitions:${rel.schema}.${rel.name}`
  const partitionsOpen = useAppStore((s) => forceOpen || s.collapsedGroups[partitionKey] === false)
  const setCollapsed = useAppStore((s) => s.setGroupCollapsed)
  const navigate = useNavigate()
  const openSqlTab = useAppStore((s) => s.openSqlTab)
  const params = useParams({ strict: false }) as { schema?: string; table?: string }
  const Icon = relationIcons[rel.kind]
  const active = params.schema === rel.schema && params.table === rel.name
  const isTable = rel.kind === 'r' || rel.kind === 'p'
  const fq = displayQualified(rel.schema, rel.name)
  const to = '/c/$connId/$db/t/$schema/$table' as const
  const linkParams = { connId: connectionId, db: database, schema: rel.schema, table: rel.name }

  // the same actions in the right-click menu and in the "⋯" menu that appears on hover
  const actions: (RelationMenuAction | null)[] = [
    { label: 'Open data', icon: TableIcon, onClick: () => void navigate({ to, params: linkParams, search: {} }) },
    {
      label: 'View structure',
      icon: TablePropertiesIcon,
      onClick: () => void navigate({ to, params: linkParams, search: { tab: 'structure' } }),
    },
    {
      label: 'Show DDL',
      icon: FileCodeIcon,
      onClick: () => void navigate({ to, params: linkParams, search: { tab: 'ddl' } }),
    },
    {
      label: 'Query in SQL editor',
      icon: SquareTerminalIcon,
      onClick: () => {
        openSqlTab(connectionId, `SELECT *\nFROM ${fq}\nLIMIT 100;\n`, rel.name)
        void navigate({ to: '/c/$connId/$db/sql', params: { connId: connectionId, db: database } })
      },
    },
    null,
    {
      label: 'Copy name',
      icon: CopyIcon,
      onClick: () => void copyWithToast(rel.name, 'Name copied', rel.name),
    },
    {
      label: 'Copy qualified name',
      icon: CopyIcon,
      onClick: () =>
        void copyWithToast(
          qualifiedName(rel.schema, rel.name),
          'Qualified name copied',
          qualifiedName(rel.schema, rel.name),
        ),
    },
    ...(writable
      ? [
          null,
          { label: 'Rename…', icon: PencilIcon, onClick: () => onAction({ kind: 'rename', relation: rel }) },
          ...(isTable
            ? [
                {
                  label: 'Truncate…',
                  icon: EraserIcon,
                  destructive: true,
                  onClick: () => onAction({ kind: 'truncate', relation: rel }),
                },
              ]
            : []),
          {
            label: `Drop ${relationKindLabel(rel.kind).toLowerCase()}…`,
            icon: Trash2Icon,
            destructive: true,
            onClick: () => onAction({ kind: 'drop', relation: rel }),
          },
        ]
      : []),
  ]

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuButton
              // pe-7 keeps a slot for the "⋯" button, so the count never has to make way for it
              className="h-7 gap-2 pe-7"
              isActive={active}
              render={<Link params={linkParams} search={{}} to={to} />}
              title={rel.comment ?? fq}
            />
          }
        >
          <Icon aria-hidden="true" className="size-3.5! opacity-60" />
          <span className="min-w-0 flex-1 truncate">{rel.name}</span>
          {rel.estimatedRows != null && rel.kind !== 'v' && (
            <span className="shrink-0 text-[0.7rem] text-sidebar-foreground/60 tabular-nums">
              {formatCount(rel.estimatedRows, { compact: true })}
            </span>
          )}
        </ContextMenuTrigger>
        <ContextMenuPopup>
          {actions.map((a, i) =>
            a ? (
              <ContextMenuItem key={a.label} onClick={a.onClick} variant={a.destructive ? 'destructive' : undefined}>
                <a.icon aria-hidden="true" />
                {a.label}
              </ContextMenuItem>
            ) : (
              <ContextMenuSeparator key={`separator-${i}`} />
            ),
          )}
        </ContextMenuPopup>
      </ContextMenu>
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuAction
              aria-label={`Actions for ${rel.name}`}
              className="peer-data-[size=default]/menu-button:top-1 data-popup-open:opacity-100"
              showOnHover
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="start" side="right">
          {actions.map((a, i) =>
            a ? (
              <MenuItem key={a.label} onClick={a.onClick} variant={a.destructive ? 'destructive' : undefined}>
                <a.icon aria-hidden="true" />
                {a.label}
              </MenuItem>
            ) : (
              <MenuSeparator key={`separator-${i}`} />
            ),
          )}
        </MenuPopup>
      </Menu>
      {partitions && partitions.length > 0 && (
        <SidebarMenuSub className="me-0 gap-px pe-0">
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              aria-expanded={partitionsOpen}
              className="h-6 gap-1 text-sidebar-foreground/70 sm:h-6"
              onClick={() => setCollapsed(partitionKey, partitionsOpen)}
              render={<button type="button" />}
              size="sm"
            >
              {partitionsOpen ? (
                <ChevronDownIcon aria-hidden="true" className="size-3! opacity-70" />
              ) : (
                <ChevronRightIcon aria-hidden="true" className="size-3! opacity-70" />
              )}
              <span>{partitions.length === 1 ? '1 partition' : `${partitions.length} partitions`}</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          {partitionsOpen &&
            partitions.map((p) => (
              <SidebarMenuSubItem key={p.oid}>
                <SidebarMenuSubButton
                  className="h-6 gap-2 sm:h-6"
                  isActive={params.schema === p.schema && params.table === p.name}
                  render={
                    <Link
                      params={{ connId: connectionId, db: database, schema: p.schema, table: p.name }}
                      search={{}}
                      to={to}
                    />
                  }
                  size="sm"
                  title={displayQualified(p.schema, p.name)}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.estimatedRows != null && (
                    <span className="shrink-0 text-[0.7rem] text-sidebar-foreground/60 tabular-nums">
                      {formatCount(p.estimatedRows, { compact: true })}
                    </span>
                  )}
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

function RenameRelationDialog({
  connectionId,
  database,
  relation,
  siblings,
  onClose,
}: {
  connectionId: string
  database: string
  relation: RelationInfo | null
  siblings: string[]
  onClose: () => void
}) {
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { schema?: string; table?: string }
  const shown = useRetained(relation)
  if (!shown) return null
  return (
    <TableSettingsDialog
      details={{ name: shown.name, kind: shown.kind, comment: shown.comment }}
      onOpenChange={(o) => !o && onClose()}
      onRenamed={(name) => {
        if (params.schema === shown.schema && params.table === shown.name) {
          void navigate({
            to: '/c/$connId/$db/t/$schema/$table',
            params: { connId: connectionId, db: database, schema: shown.schema, table: name },
            search: {},
          })
        }
      }}
      open={relation !== null}
      takenNames={siblings}
      target={{ connectionId, database, schema: shown.schema }}
    />
  )
}

interface RelationMenuAction {
  label: string
  icon: LucideIcon
  onClick: () => void
  destructive?: boolean
}

function relationActionSql(a: RelationAction): string {
  const rel = a.relation
  const target = qualifiedName(rel.schema, rel.name)
  const keyword =
    rel.kind === 'v' ? 'VIEW' : rel.kind === 'm' ? 'MATERIALIZED VIEW' : rel.kind === 'f' ? 'FOREIGN TABLE' : 'TABLE'
  return a.kind === 'drop' ? `DROP ${keyword} ${target}` : `TRUNCATE TABLE ${target}`
}

/**
 * Truncate / drop confirmation. Lives at sidebar level (not inside the item)
 * so it can finish its exit animation after a dropped table leaves the list.
 */
function RelationActionDialog({
  connectionId,
  database,
  action,
  onClose,
}: {
  connectionId: string
  database: string
  action: RelationAction | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const params = useParams({ strict: false }) as { schema?: string; table?: string }
  const shown = useRetained(action)

  const guard = useProductionGuard(connectionId, database)

  const mutation = useMutation({
    mutationFn: async (a: RelationAction) => {
      const sql = relationActionSql(a)
      const res = await executeSqlFn({
        data: { connectionId, database, sql, maxRows: 1, executionId: crypto.randomUUID() },
      })
      if (res.error) throw new Error(res.error.message)
      return a
    },
    onSuccess: (a) => {
      const rel = a.relation
      toastManager.add({
        type: 'success',
        title: a.kind === 'drop' ? `${relationKindLabel(rel.kind)} dropped` : 'Table truncated',
        description: displayQualified(rel.schema, rel.name),
      })
      onClose()
      void queryClient.invalidateQueries({ queryKey: keys.db(connectionId, database) })
      if (a.kind === 'drop' && params.schema === rel.schema && params.table === rel.name) {
        void navigate({ to: '/c/$connId/$db', params: { connId: connectionId, db: database } })
      }
    },
    onError: (err) => toastManager.add({ type: 'error', title: 'Operation failed', description: err.message }),
  })

  const rel = shown?.relation
  const isTable = rel ? rel.kind === 'r' || rel.kind === 'p' : false
  const fq = rel ? displayQualified(rel.schema, rel.name) : ''
  const kindLabel = rel ? relationKindLabel(rel.kind).toLowerCase() : ''

  return (
    <ConfirmDialog
      confirmLabel={shown?.kind === 'drop' ? `Drop ${kindLabel}` : 'Truncate table'}
      description={
        shown?.kind === 'drop' ? (
          <>
            This permanently deletes <span className="font-medium font-mono text-foreground">{fq}</span>
            {isTable ? ' and all of its data' : ''}. This cannot be undone.
          </>
        ) : (
          <>
            This removes <span className="font-medium text-foreground">all rows</span> from{' '}
            <span className="font-medium font-mono text-foreground">{fq}</span>. This cannot be undone.
          </>
        )
      }
      destructive
      loading={mutation.isPending}
      onConfirm={() => {
        if (!action) return
        const sql = relationActionSql(action)
        const rel = action.relation
        const name = displayQualified(rel.schema, rel.name)
        const what =
          action.kind === 'drop' ? `Drop ${relationKindLabel(rel.kind).toLowerCase()} ${name}` : `Truncate ${name}`
        // this dialog closes first; on a production connection the check asks in its own dialog
        onClose()
        void guard({ action: what, sql, destructive: classifySql(sql).destructive }).then((ok) => {
          if (ok) mutation.mutate(action)
        })
      }}
      onOpenChange={(o) => !o && onClose()}
      open={action !== null}
      requireText={shown?.kind === 'drop' ? rel?.name : undefined}
      title={shown?.kind === 'drop' ? `Drop ${rel?.name}?` : `Truncate ${rel?.name}?`}
    />
  )
}

function ObjectGroup({
  id,
  label,
  icon: Icon,
  items,
  forceOpen,
}: {
  id: string
  label: string
  icon: LucideIcon
  items: { key: string; name: string; hint?: string; title: string; onOpen: () => void; onPrefetch?: () => void }[]
  forceOpen: boolean
}) {
  const collapsed = useAppStore((s) => s.collapsedGroups[id] ?? true)
  const open = forceOpen || !collapsed
  if (items.length === 0) return null
  return (
    <SidebarGroup className="py-1">
      <GroupHeader count={items.length} id={id} label={label} open={open} />
      {open && (
        <SidebarGroupContent>
          <SidebarMenu className="gap-px">
            {items.map((item) => (
              <SidebarMenuItem key={item.key}>
                <SidebarMenuButton
                  className="h-7 gap-2 pe-7"
                  onClick={item.onOpen}
                  onFocus={item.onPrefetch}
                  onPointerEnter={item.onPrefetch}
                  title={item.title}
                >
                  <Icon aria-hidden="true" className="size-3.5! opacity-60" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.hint && <span className="shrink-0 text-[0.7rem] text-sidebar-foreground/60">{item.hint}</span>}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  )
}
