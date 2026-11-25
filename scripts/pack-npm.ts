/**
 * Assembles npm-package/: the folder that `npm publish` uploads as the `powview` package.
 *
 * Run by `bun run build:npm` after the build and the start.js bundle, or alone with
 * `bun run pack:npm` when those outputs already exist. Only the files listed here are copied, so
 * no source, tests, node_modules, source maps or dev-only files ship. The package has no
 * dependencies and no scripts: nothing runs on install.
 */
import { copyFile, cp, mkdir, readFile, rm, writeFile, chmod, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(root, 'npm-package')

const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }

const required = [
  'start.js',
  'dist/client',
  'dist/server/server.js',
  'dist/cli/powview.js',
  'npm/bin/powview.mjs',
  'npm/lib/launcher.mjs',
]

async function exists(relative: string): Promise<boolean> {
  return stat(path.join(root, relative))
    .then(() => true)
    .catch(() => false)
}

for (const relative of required) {
  if (!(await exists(relative))) {
    throw new Error(`Missing ${relative}. Run bun run build:npm (it runs the build first).`)
  }
}

/** Copies a folder, leaving out source maps. */
async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: (source) => !source.endsWith('.map'),
  })
}

await rm(outDir, { recursive: true, force: true })
await mkdir(path.join(outDir, 'bin'), { recursive: true })
await mkdir(path.join(outDir, 'lib'), { recursive: true })
await mkdir(path.join(outDir, 'dist', 'cli'), { recursive: true })

await copyFile(path.join(root, 'start.js'), path.join(outDir, 'start.js'))
await copyTree(path.join(root, 'dist', 'client'), path.join(outDir, 'dist', 'client'))
await copyTree(path.join(root, 'dist', 'server'), path.join(outDir, 'dist', 'server'))
await copyFile(path.join(root, 'dist', 'cli', 'powview.js'), path.join(outDir, 'dist', 'cli', 'powview.js'))
await copyFile(path.join(root, 'npm', 'bin', 'powview.mjs'), path.join(outDir, 'bin', 'powview.mjs'))
await chmod(path.join(outDir, 'bin', 'powview.mjs'), 0o755)
await copyFile(path.join(root, 'npm', 'lib', 'launcher.mjs'), path.join(outDir, 'lib', 'launcher.mjs'))
// The npm page has no repository files next to the README, so relative links and images point to
// GitHub instead, at this version's tag: images to the raw file, links to the file page.
const repoUrl = 'https://github.com/powroom/powview'
const rawUrl = 'https://raw.githubusercontent.com/powroom/powview'
const tag = `v${rootPackage.version}`
const readme = await readFile(path.join(root, 'README.md'), 'utf8')
await writeFile(
  path.join(outDir, 'README.md'),
  readme.replace(
    /(!?)\[([^\]]*)\]\((?!https?:|#|mailto:)([^)\s]+)\)/g,
    (_match, bang: string, text: string, target: string) =>
      bang ? `![${text}](${rawUrl}/${tag}/${target})` : `[${text}](${repoUrl}/blob/${tag}/${target})`,
  ),
)

// Apache-2.0 asks every copy to carry the license and the NOTICE file.
await copyFile(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'))
await copyFile(path.join(root, 'NOTICE'), path.join(outDir, 'NOTICE'))

const manifest = {
  name: 'powview',
  version: rootPackage.version,
  description: 'A web app for browsing and managing PostgreSQL databases. Start it with npx powview.',
  type: 'module',
  bin: { powview: 'bin/powview.mjs' },
  files: ['bin', 'lib', 'dist', 'start.js', 'README.md', 'LICENSE', 'NOTICE'],
  engines: { node: '>=18' },
  keywords: ['postgresql', 'postgres', 'database', 'sql', 'admin', 'web-ui', 'bun'],
  repository: { type: 'git', url: 'git+https://github.com/powroom/powview.git' },
  homepage: 'https://github.com/powroom/powview#readme',
  bugs: { url: 'https://github.com/powroom/powview/issues' },
  license: 'Apache-2.0',
}
await writeFile(path.join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`Assembled ${path.relative(root, outDir)}/ for powview ${rootPackage.version}`)
