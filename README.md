# pow/view

pow/view is a web app for browsing and managing PostgreSQL databases. Open it in your browser to see your tables, change data, run SQL queries, view how tables connect, and make backups. It is made for developers, analysts, and anyone who works with PostgreSQL data and wants a simple, fast tool.

![pow/view in light and dark mode](docs/screenshot.png)

## Quick start

**With npx** (needs [Node.js](https://nodejs.org) 18 or newer):

```bash
npx powview
```

pow/view opens at http://127.0.0.1:3333. It runs on Bun. If Bun is missing, `powview` asks before it installs Bun, and that copy goes only into `~/.powview/runtime`. Flags, data folders, and updates are in [Install and update](docs/install.md).

**With Docker** (needs [Docker](https://docs.docker.com/get-docker/)):

```bash
docker run -d --name powview --restart unless-stopped -p 127.0.0.1:3333:3333 -v powview-data:/data \
  --add-host host.docker.internal:host-gateway ghcr.io/powroom/powview:latest
```

**With Docker Compose:**

```bash
curl -o compose.yml https://raw.githubusercontent.com/powroom/powview/main/compose.example.yml
docker compose up -d
```

With either Docker command, open http://localhost:3333 in your browser.

## First login

The first time you open pow/view, create an admin account. Enter a username and a password of at least 8 characters. You sign in with it after that.

## Connect a database

Click **Add connection**, then paste a connection URL, such as `postgresql://user:password@host:5432/database_name`. The other fields fill in by themselves. Click **Test connection**, then **Save & connect**.

- **Databases on your computer**: inside Docker, `localhost` means the container. Use `host.docker.internal` instead. See [Databases on your machine](docs/configuration.md#databases-on-your-machine-and-other-containers).
- **Supported PostgreSQL versions**: 14 to 18.
- **Read-only** connections can only read. **Production** connections ask you to confirm every change. See [Production mode](docs/configuration.md#production-mode).

## What you can do

**Data**

- A fast grid for big tables, with resizable columns. Sort, filter, and search the text in all columns. Save the filters, sort, search, and hidden columns of a table as a saved view under a name, and open it again in one click.
- Edit cells, add, duplicate, or delete rows, then review the SQL and save it all in one transaction. Undo and redo.
- A details panel for one row. Right-click a cell to copy it, filter by its value, or open the row it points to.

**Structure**

- See columns, types, constraints, indexes, triggers, and links between tables, with a diagram of how they connect.
- Create databases, schemas, and tables, and change columns, indexes, constraints, and tables with forms. Each form shows the SQL it will run.

**SQL editor**

- Highlighting and autocomplete for tables, columns, and aliases. Many tabs, query history, and saved queries.
- Run a selection, the whole script, or the statement under the cursor. See results, NOTICE messages, and error positions. A Cancel button stops a slow query.
- Explain a query to see its plan as a tree, with the slowest step marked, tips such as stale statistics, and a suggested index when a step reads a whole table to keep only a few rows. Explain Analyze measures real times and rolls back any changes.

**Import, export, and backup**

- Import a CSV file. Export a page or a whole table to CSV, JSON, or SQL INSERT. Back up a database, and restore it from a backup file. See [Backup and restore](docs/backup-restore.md).

**Other**

- Command palette (Ctrl/⌘+K) to jump to any table or view. The database overview shows size, biggest tables, active sessions, and extensions. Cancel or stop queries that are running on the server. The Health section of the overview lists slow queries, unused indexes, tables that need VACUUM, and big tables read in full, with the SQL to fix each one.
- Connect AI agents such as Claude Code or Cursor. You choose what each one can do. See [AI and API](docs/ai-and-api.md).
- Dark mode, and a layout that works on a phone.

## Key shortcuts

| Shortcut                 | What it does                                            |
| ------------------------ | ------------------------------------------------------- |
| `Ctrl/⌘ + K`             | Open the command palette                                |
| `?`                      | Show all shortcuts                                      |
| `Ctrl/⌘ + Enter`         | Run the selection or the whole script (SQL editor)      |
| `Shift + Ctrl/⌘ + Enter` | Run the statement under the cursor                      |
| `Ctrl/⌘ + S`             | Save table changes, or save the query in the SQL editor |
| `Space`                  | Open or close the row details                           |

The full list is in [docs/shortcut.md](docs/shortcut.md).

## Security

- **Local only**: by default pow/view accepts connections only from this computer. For other machines, put it behind a reverse proxy with HTTPS. See [Network security](docs/configuration.md#network-security-and-proxy).
- **Login**: the app asks for an admin account. Forgot the password? See [Login and admin account](docs/configuration.md#login-and-admin-account).
- **Safety**: read-only connections and production mode stop changes you did not mean to make. Production mode is a check in the app, not a security boundary, so also use a database account with limited rights.
- **Secrets**: saved database passwords are encrypted and never sent back to the browser. API tokens and the data folder give full access. Keep them private, and do not commit them to git.
- **Report a vulnerability** privately, as described in [SECURITY.md](SECURITY.md).

## Documentation

- [Install and update](docs/install.md): npx and Docker, the data folder, and updates.
- [Configuration](docs/configuration.md): environment variables, `powview.yaml`, SSH tunnels, login, production mode, and file size limits.
- [Backup and restore](docs/backup-restore.md): backup formats, restore, and CSV import.
- [AI and API](docs/ai-and-api.md): AI agents (MCP), API tokens, the REST API, the `powview` CLI, and the audit log.
- [Shortcuts](docs/shortcut.md): every keyboard shortcut.
- [Development](docs/development.md): running from source, the demo database, checks, and releases.

## License

pow/view is open source under the [Apache License 2.0](LICENSE). You can use, change, and share it, also in commercial products, as long as you keep the copyright and license notices (see [NOTICE](NOTICE)). The license does not give permission to use the pow/view name or logo for your own product.
