import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkIcon,
  BotIcon,
  CornerDownLeftIcon,
  DatabaseIcon,
  HomeIcon,
  KeyboardIcon,
  ListIcon,
  SettingsIcon,
  LayoutGridIcon,
  MonitorIcon,
  MoonIcon,
  NetworkIcon,
  DownloadIcon,
  PencilIcon,
  RefreshCwIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  SunIcon,
  UploadIcon,
  UsersIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { toastManager } from '@/components/ui/toast'
import { countLabel, relationKindLabel } from '@/lib/format'
import { allRelationsQuery, connectionsQuery, databasesQuery, keys } from '@/lib/queries'
import { firstLine, savedQueriesQuery } from '@/lib/saved-queries'
import { databaseSavedViewsQuery, savedViewSearch } from '@/lib/saved-views'
import { useAiAccessDialog } from '@/lib/ai-access-dialog'
import { useExportDatabaseDialog } from '@/lib/export-database-dialog'
import { useRestoreDatabaseDialog } from '@/lib/restore-database-dialog'
import { useAppStore } from '@/lib/store'
import type { RecentItem } from '@/lib/store'
import { setTheme } from '@/lib/theme'
import { ConnectionAvatar } from './brand'
import { relationIcons } from './relation-icons'

interface PaletteItem {
  id: string
  label: string
  detail?: string
  hint?: string
  keywords?: string
  icon?: LucideIcon
  avatar?: React.ReactNode
  /** identifiers (tables) also match loosely, e.g. "ordit" → "order_items" */
  fuzzy?: boolean
  run: () => void
}

const EMPTY_RECENT: RecentItem[] = []

interface PaletteGroup {
  value: string
  items: PaletteItem[]
}

function score(item: PaletteItem, q: string): number {
  if (!q) return 1
  const label = item.label.toLowerCase()
  if (label === q) return 100
  if (label.startsWith(q)) return 80
  const name = label.split('.').pop() ?? label
  if (name.startsWith(q)) return 70
  // a word inside the label starts with the query ("theme: dark" ← "dark")
  if (label.split(/[\s_.:]+/).some((w) => w.startsWith(q))) return 60
  if (label.includes(q)) return 50
  if (
    q.length >= 3 &&
    item.keywords
      ?.toLowerCase()
      .split(/\s+/)
      .some((w) => w.startsWith(q))
  )
    return 30
  if (item.fuzzy && q.length >= 3) {
    let i = 0
    for (const ch of name) if (ch === q[i]) i++
    if (i === q.length && name[0] === q[0]) return 10
  }
  return 0
}

export function CommandPalette({
  open,
  onOpenChange,
  connectionId,
  database,
  onEditConnection,
  onShowShortcuts,
  onShowSettings,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  database: string
  onEditConnection: () => void
  onShowShortcuts: () => void
  onShowSettings: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const openSqlTab = useAppStore((s) => s.openSqlTab)
  const openSavedQuery = useAppStore((s) => s.openSavedQuery)
  const setHiddenColumns = useAppStore((s) => s.setHiddenColumns)
  const setAiAccessOpen = useAiAccessDialog((s) => s.setOpen)
  const setExportOpen = useExportDatabaseDialog((s) => s.setOpen)
  const setRestoreOpen = useRestoreDatabaseDialog((s) => s.setOpen)
  const recent = useAppStore((s) => s.recent[`${connectionId}:${database}`]) ?? EMPTY_RECENT
  const [query, setQuery] = useState('')
  // loaded in the background (not on open) so the list does not jump when the palette appears
  const { data: relations } = useQuery(allRelationsQuery(connectionId, database))
  const { data: databases } = useQuery(databasesQuery(connectionId))
  const { data: connections } = useQuery(connectionsQuery())
  const { data: savedQueries } = useQuery(savedQueriesQuery(connectionId))
  // only fetched while the palette is open
  const { data: savedViews } = useQuery({ ...databaseSavedViewsQuery(connectionId, database), enabled: open })

  // the query is cleared once the dialog has finished closing (see onOpenChangeComplete)
  const close = () => onOpenChange(false)

  const groups = useMemo<PaletteGroup[]>(() => {
    const q = query.trim().toLowerCase()
    const rank = (items: PaletteItem[], limit: number) =>
      q
        ? items
            .map((item) => ({ item, s: score(item, q) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s || a.item.label.length - b.item.label.length)
            .slice(0, limit)
            .map((x) => x.item)
        : items.slice(0, limit)

    const recentIndex = new Map(recent.map((r, i) => [`${r.schema}.${r.name}`, i]))
    const sortedRelations = [...(relations ?? [])].sort((a, b) => {
      const ra = recentIndex.get(`${a.schema}.${a.name}`) ?? Number.POSITIVE_INFINITY
      const rb = recentIndex.get(`${b.schema}.${b.name}`) ?? Number.POSITIVE_INFINITY
      if (ra !== rb) return ra - rb
      if ((a.schema === 'public') !== (b.schema === 'public')) return a.schema === 'public' ? -1 : 1
      return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`)
    })

    const tables: PaletteItem[] = sortedRelations.map((r) => ({
      id: `rel:${r.schema}.${r.name}`,
      label: r.schema === 'public' ? r.name : `${r.schema}.${r.name}`,
      detail: relationKindLabel(r.kind),
      hint:
        r.estimatedRows != null && r.kind !== 'v' ? countLabel(r.estimatedRows, 'row', { compact: true }) : undefined,
      keywords: `${r.schema} ${r.comment ?? ''}`,
      icon: relationIcons[r.kind],
      fuzzy: true,
      run: () =>
        void navigate({
          to: '/c/$connId/$db/t/$schema/$table',
          params: { connId: connectionId, db: database, schema: r.schema, table: r.name },
          search: {},
        }),
    }))

    const saved: PaletteItem[] = (savedQueries ?? []).map((query) => ({
      id: `saved:${query.id}`,
      label: query.name,
      detail: firstLine(query.sql),
      keywords: 'saved query',
      icon: BookmarkIcon,
      run: () => {
        openSavedQuery(connectionId, query)
        void navigate({ to: '/c/$connId/$db/sql', params: { connId: connectionId, db: database } })
      },
    }))

    const views: PaletteItem[] = (savedViews ?? []).map((view) => ({
      id: `view:${view.id}`,
      label: view.name,
      detail: view.schema === 'public' ? view.table : `${view.schema}.${view.table}`,
      keywords: view.table,
      icon: BookmarkIcon,
      run: () => {
        // the same key the table page uses for its hidden columns
        setHiddenColumns(`${connectionId}:${database}:${view.schema}.${view.table}`, view.state.hiddenColumns)
        void navigate({
          to: '/c/$connId/$db/t/$schema/$table',
          params: { connId: connectionId, db: database, schema: view.schema, table: view.table },
          search: savedViewSearch(view.state),
        })
      },
    }))

    const actions: PaletteItem[] = [
      {
        id: 'new-query',
        label: 'New SQL query',
        icon: SquarePenIcon,
        keywords: 'editor sql console run',
        run: () => {
          openSqlTab(connectionId, '')
          void navigate({ to: '/c/$connId/$db/sql', params: { connId: connectionId, db: database } })
        },
      },
      {
        id: 'sql',
        label: 'Open SQL editor',
        icon: SquareTerminalIcon,
        keywords: 'console query',
        run: () => void navigate({ to: '/c/$connId/$db/sql', params: { connId: connectionId, db: database } }),
      },
      {
        id: 'overview',
        label: 'Database overview',
        icon: LayoutGridIcon,
        keywords: 'dashboard stats size',
        run: () => void navigate({ to: '/c/$connId/$db', params: { connId: connectionId, db: database } }),
      },
      {
        id: 'diagram',
        label: 'Go to diagram',
        icon: NetworkIcon,
        keywords: 'er erd relations schema graph',
        run: () => void navigate({ to: '/c/$connId/$db/diagram', params: { connId: connectionId, db: database } }),
      },
      {
        id: 'databases',
        label: 'Manage databases',
        icon: ListIcon,
        keywords: 'create rename owner limit drop delete database list',
        run: () => void navigate({ to: '/c/$connId/$db/databases', params: { connId: connectionId, db: database } }),
      },
      {
        id: 'roles',
        label: 'Manage roles',
        icon: UsersIcon,
        keywords: 'create user group login password permission grant privilege member role list',
        run: () => void navigate({ to: '/c/$connId/$db/roles', params: { connId: connectionId, db: database } }),
      },
      {
        id: 'refresh',
        label: 'Refresh metadata',
        icon: RefreshCwIcon,
        keywords: 'reload schema',
        run: () => {
          void queryClient.invalidateQueries({ queryKey: keys.db(connectionId, database) })
          toastManager.add({ type: 'info', title: 'Metadata refreshed', timeout: 1500 })
        },
      },
      {
        id: 'edit-conn',
        label: 'Edit connection',
        icon: PencilIcon,
        keywords: 'settings password host',
        run: onEditConnection,
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        icon: KeyboardIcon,
        keywords: 'keys hotkeys help',
        run: onShowShortcuts,
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: SettingsIcon,
        keywords: 'preferences options config time zone theme',
        run: onShowSettings,
      },
      {
        id: 'ai-access',
        label: 'AI access',
        icon: BotIcon,
        keywords: 'mcp token claude cursor agent',
        run: () => setAiAccessOpen(true),
      },
      {
        id: 'export-database',
        label: 'Export database',
        icon: DownloadIcon,
        keywords: 'dump backup pg_dump sql download save restore',
        run: () => setExportOpen(true),
      },
      {
        id: 'restore-database',
        label: 'Restore database',
        icon: UploadIcon,
        keywords: 'import load backup psql pg_restore sql dump',
        run: () => setRestoreOpen(true),
      },
      { id: 'theme-light', label: 'Theme: Light', icon: SunIcon, keywords: 'appearance', run: () => setTheme('light') },
      { id: 'theme-dark', label: 'Theme: Dark', icon: MoonIcon, keywords: 'appearance', run: () => setTheme('dark') },
      {
        id: 'theme-system',
        label: 'Theme: System',
        icon: MonitorIcon,
        keywords: 'appearance',
        run: () => setTheme('system'),
      },
      {
        id: 'home',
        label: 'All connections',
        icon: HomeIcon,
        keywords: 'home disconnect',
        run: () => void navigate({ to: '/' }),
      },
    ]

    const dbs: PaletteItem[] = (databases ?? [])
      .filter((d) => d.name !== database)
      .map((d) => ({
        id: `db:${d.name}`,
        label: `Switch to ${d.name}`,
        keywords: 'database',
        icon: DatabaseIcon,
        run: () => void navigate({ to: '/c/$connId/$db', params: { connId: connectionId, db: d.name } }),
      }))

    const conns: PaletteItem[] = (connections ?? [])
      .filter((c) => c.id !== connectionId)
      .map((c) => ({
        id: `conn:${c.id}`,
        label: c.name,
        detail: `${c.host}/${c.database}`,
        keywords: 'connection switch',
        avatar: <ConnectionAvatar className="size-5 rounded-md text-[0.6rem]" color={c.color} name={c.name} />,
        run: () => void navigate({ to: '/c/$connId', params: { connId: c.id } }),
      }))

    return [
      { value: 'Tables & views', items: rank(tables, q ? 30 : 8) },
      { value: 'Saved queries', items: rank(saved, q ? 20 : 8) },
      { value: 'Saved views', items: rank(views, q ? 20 : 8) },
      { value: 'Actions', items: rank(actions, 20) },
      { value: 'Databases', items: rank(dbs, 10) },
      { value: 'Connections', items: rank(conns, 10) },
    ].filter((g) => g.items.length > 0)
  }, [
    query,
    relations,
    recent,
    databases,
    connections,
    savedQueries,
    savedViews,
    connectionId,
    database,
    navigate,
    openSqlTab,
    openSavedQuery,
    setHiddenColumns,
    queryClient,
    setAiAccessOpen,
    setExportOpen,
    setRestoreOpen,
    onEditConnection,
    onShowShortcuts,
    onShowSettings,
  ])

  return (
    <CommandDialog
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setQuery('')
      }}
      open={open}
    >
      <CommandDialogPopup aria-label="Command palette">
        <Command
          filteredItems={groups}
          items={groups}
          itemToStringValue={(item: unknown) => (item as PaletteItem).label}
          onValueChange={setQuery}
          value={query}
        >
          <CommandInput placeholder="Search tables, views, actions…" />
          <CommandPanel>
            <CommandEmpty>No results for “{query}”.</CommandEmpty>
            <CommandList>
              {(group: PaletteGroup) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: PaletteItem) => (
                        <CommandItem
                          className="gap-2.5"
                          key={item.id}
                          onClick={() => {
                            close()
                            item.run()
                          }}
                          value={item}
                        >
                          {item.avatar ?? (item.icon && <item.icon aria-hidden="true" className="size-4 opacity-70" />)}
                          <span className="truncate">{item.label}</span>
                          {item.detail && <span className="truncate text-muted-foreground text-xs">{item.detail}</span>}
                          {item.hint && <CommandShortcut className="tracking-normal">{item.hint}</CommandShortcut>}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                  <CommandSeparator />
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <KbdGroup>
                  <Kbd>
                    <ArrowUpIcon />
                  </Kbd>
                  <Kbd>
                    <ArrowDownIcon />
                  </Kbd>
                </KbdGroup>
                <span>Navigate</span>
              </div>
              <div className="flex items-center gap-2">
                <Kbd>
                  <CornerDownLeftIcon />
                </Kbd>
                <span>Open</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Kbd>Esc</Kbd>
              <span>Close</span>
            </div>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  )
}
