// SPDX-License-Identifier: AGPL-3.0

/** Deploy the complete, bundled MCP release locally. No downloads or Python setup. */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const backend = JSON.parse(readFileSync(join(packageRoot, 'runtime', 'backend.json'), 'utf8'))
export const bundledArchive = join(packageRoot, 'runtime', backend.archive)
const require = createRequire(import.meta.url)
export const bundledArchiveParts = (backend.archiveParts || [backend.archive]).map((name, index) => {
  const dependency = backend.archivePackages?.[index]
  if (dependency) {
    try { return require.resolve(`${dependency}/${name}`) }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  }
  // Source checkouts retain the release parts; npm installs resolve pinned dependencies.
  return join(packageRoot, 'runtime', name)
})

/** Join ordered archive parts with bounded memory, preserving the original ZIP bytes. */
export function joinArchiveParts(parts, destination) {
  const output = openSync(destination, 'wx')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    for (const part of parts) {
      const input = openSync(part, 'r')
      try {
        let count
        while ((count = readSync(input, buffer, 0, buffer.length, null)) > 0) {
          let offset = 0
          while (offset < count) offset += writeSync(output, buffer, offset, count - offset)
        }
      } finally {
        closeSync(input)
      }
    }
  } finally {
    closeSync(output)
  }
}

/** User data lives outside the package and outside the engineering workspace. */
export function bundledRuntimeRoot(env = process.env) {
  const local = env.LOCALAPPDATA || join(env.USERPROFILE || env.HOME || homedir(), 'AppData', 'Local')
  return resolve(local, 'dsh-gxworks', 'runtime', backend.release, backend.directory)
}

const requiredFiles = [
  backend.executable, 'python313.dll', 'base_library.zip',
  'gxw/templates/fx3u.gxw',
  'gxw/templates/blank-ladder-projects.zip.xz',
  'gxw/templates/blank-fbd-projects.zip.xz',
  'workspace-adapter/PlcAi.WorkspaceSourceSave.exe',
  'native-active/PlcAi.ActiveDocument.exe',
  'hardware-reader/PlcAi.HardwareReader.exe',
  'simulator-gateway/PlcAi.GxSimulator2Gateway.exe',
  'web/dist/simulator.html',
  'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES/README.md',
]

export function runtimeReady(root) {
  try {
    const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'))
    return release.version === backend.version && release.source_commit === backend.sourceCommit &&
      release.component === 'mcp' && requiredFiles.every(relative => existsSync(join(root, relative)))
  } catch {
    return false
  }
}

/** Expand into a temporary sibling; publish only a complete MCP distribution. */
export function prepareBundledRuntime({ env = process.env, platform = process.platform, arch = process.arch,
  archive = bundledArchive, log = message => process.stderr.write(`[dsh-gxworks] ${message}\n`),
  archiveParts = archive === bundledArchive ? bundledArchiveParts : [archive],
} = {}) {
  if (platform !== backend.platform || arch !== backend.arch) {
    throw new Error('内置 GXWorks Agent 后端需要 Windows x64。其他平台请显式指定兼容后端（--agent-root / GXWORKS_MCP_EXE）。')
  }
  const root = bundledRuntimeRoot(env)
  if (runtimeReady(root)) return root
  if (!archiveParts.length || archiveParts.some(part => !existsSync(part))) {
    throw new Error(`插件安装包缺少后端 ${backend.archive}；请重新安装完整的 dsh-gxworks 包。`)
  }
  const parent = dirname(root)
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.extract-'))
  try {
    log(`首次准备内置 GXWorks Agent ${backend.version}（本地解压，无需下载）`)
    const extractionArchive = archiveParts.length === 1 ? archiveParts[0] : join(staging, backend.archive)
    if (archiveParts.length > 1) joinArchiveParts(archiveParts, extractionArchive)
    const powershell = join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DSH_GXWORKS_ARCHIVE -DestinationPath $env:DSH_GXWORKS_EXTRACT"],
    { env: { ...env, DSH_GXWORKS_ARCHIVE: extractionArchive, DSH_GXWORKS_EXTRACT: staging }, windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 })
    const extracted = join(staging, backend.directory)
    if (!runtimeReady(extracted)) throw new Error('包内后端缺少运行资源，或版本与 runtime/backend.json 不符。请重新安装完整插件。')
    // root is the private, version-specific deployment directory owned by this module.
    if (!runtimeReady(root)) {
      rmSync(root, { recursive: true, force: true })
      renameSync(extracted, root)
    }
    return root
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

// Desktop may start the file through a profile junction while ESM resolved the package target.
export function isLaunchEntry(moduleUrl, script = process.argv[1]) {
  return Boolean(script && (pathToFileURL(resolve(script)).href === moduleUrl ||
    (existsSync(script) && pathToFileURL(realpathSync(script)).href === moduleUrl)))
}

if (isLaunchEntry(import.meta.url)) {
  try {
    process.stdout.write(`${prepareBundledRuntime()}\n`)
  } catch (error) {
    process.stderr.write(`[dsh-gxworks] ${error.message}\n`)
    process.exitCode = 2
  }
}
