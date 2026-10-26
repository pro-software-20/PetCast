import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
assert.equal(process.platform, 'win32', 'This delivery script builds the Windows test installer.')
const config = require('../build/electron-builder.cjs')
assert.equal(require('electron/package.json').version, config.electronVersion)

// Work from a fresh allowlisted application directory: no development files,
// local login files, user saves, .env files, or backend credentials are copied.
const stamp = new Date().toISOString().replace(/[^0-9]/g, '')
const staging = path.join(root, 'release', `staging-${stamp}-${process.pid}`, 'app')
await mkdir(staging, { recursive: true })
const excludedAssetFolders = new Set(['raw', 'frames', 'previews'])
await cp(path.join(root, 'dist'), path.join(staging, 'dist'), {
  recursive: true,
  filter: source => {
    const relative = path.relative(path.join(root, 'dist'), source).split(path.sep)
    if (relative[0] === 'assets' && relative.some(part => excludedAssetFolders.has(part))) return false
    if (relative[0] === 'assets' && /\.(?:md|json)$/i.test(source)) return false
    return !source.endsWith('.map')
  },
})
await cp(path.join(root, 'dist-electron'), path.join(staging, 'dist-electron'), {
  recursive: true, filter: source => !/\.(?:map|tsbuildinfo)$/i.test(source),
})
await cp(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'))

const included = new Map()
async function includeDependency(name, fromDirectory) {
  const from = createRequire(path.join(fromDirectory, 'package.json'))
  const source = await realpath(path.dirname(from.resolve(`${name}/package.json`)))
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
  if (included.has(name)) {
    assert.equal(included.get(name), metadata.version, `Conflicting production dependency: ${name}`)
    return
  }
  included.set(name, metadata.version)
  const destination = path.join(staging, 'node_modules', ...name.split('/'))
  await cp(source, destination, {
    recursive: true, dereference: true,
    filter: entry => !path.relative(source, entry).split(path.sep).includes('node_modules'),
  })
  for (const dependency of Object.keys(metadata.dependencies ?? {})) await includeDependency(dependency, source)
}
for (const [name, version] of Object.entries(pkg.dependencies)) {
  await includeDependency(name, root)
  assert.equal(included.get(name), version, `Installed ${name} must match the pinned project version`)
}
await writeFile(path.join(staging, 'package.json'), JSON.stringify({
  name: pkg.name, productName: 'PetCast', version: pkg.version,
  description: 'PetCast desktop companion - internal Windows test build',
  author: 'pro-software-20', license: 'MIT', type: 'module', main: pkg.main,
  packageManager: 'npm@10.9.2',
  dependencies: pkg.dependencies,
}, null, 2) + '\n')

const files = []
async function inventory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name)
    if (item.isDirectory()) await inventory(absolute)
    else {
      assert(item.isFile(), 'Staging must contain regular files, not links.')
      const relative = path.relative(staging, absolute).split(path.sep).join('/')
      assert(!/(^|\/)(?:\.env(?:\.|$)|\.git|auth\.json|Cookies|Local Storage|petcast-save\.json)/i.test(relative), `Private file in staging: ${relative}`)
      const bytes = await readFile(absolute)
      files.push({ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
}
await inventory(staging)
for (const required of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.cjs', 'dist/assets/app/icon.png',
  'node_modules/jose/package.json', 'dist/assets/pets/rest-breathing-20261025/native/cat-idle.png']) {
  assert(files.some(file => file.path === required), `Missing runtime file: ${required}`)
}
assert(!files.some(file => file.path.startsWith('dist-server/')), 'The key-bearing development backend is deployed separately.')
const output = path.join(root, config.directories.output)
await mkdir(output, { recursive: true })
await writeFile(path.join(output, 'package-manifest.json'), JSON.stringify({ version: pkg.version, architecture: 'x64',
  signed: false, dependencies: Object.fromEntries(included), files }, null, 2))
console.log(`Prepared ${files.length} runtime files and ${included.size} production dependencies.`)

// This internal test build never publishes to GitHub or automatically discovers
// a signing identity inherited from a developer's environment.
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name]
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
const { build, Platform, Arch } = require('electron-builder')
const artifacts = await build({
  projectDir: staging, publish: 'never',
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  config: { ...config, directories: { output, app: staging, buildResources: path.join(root, 'build') },
    win: { ...config.win, icon: path.join(root, config.win.icon) },
    nsis: { ...config.nsis, installerIcon: path.join(root, config.nsis.installerIcon),
      uninstallerIcon: path.join(root, config.nsis.uninstallerIcon), include: path.join(root, config.nsis.include) },
    electronDist: await realpath(path.dirname(require.resolve('electron/package.json')) + '/dist') },
})
const installer = artifacts.find(file => file.endsWith('.exe'))
assert(installer, 'No installer executable was produced.')
const bytes = await readFile(installer)
const digest = createHash('sha256').update(bytes).digest('hex')
await writeFile(path.join(output, 'SHA256SUMS.txt'), `${digest}  ${path.basename(installer)}\n`)
console.log(`Installer ready: ${installer}\nSHA-256: ${digest}`)
