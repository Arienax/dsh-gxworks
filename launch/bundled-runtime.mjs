/** Deploy the complete, bundled MCP release locally. No downloads or Python setup. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const backend = JSON.parse(readFileSync(join(packageRoot, 'runtime', 'backend.json'), 'utf8'))
export const bundledArchive = join(packageRoot, 'runtime', backend.archive)

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
  'resources/instructions/mitsubishi/pwm_contract.generated.json',
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
} = {}) {
  if (platform !== backend.platform || arch !== backend.arch) {
    throw new Error('内置 GXWorks Agent 后端需要 Windows x64。其他平台请显式指定兼容后端（--agent-root / GXWORKS_MCP_EXE）。')
  }
  const root = bundledRuntimeRoot(env)
  if (runtimeReady(root)) return root
  if (!existsSync(archive)) {
    throw new Error(`插件安装包缺少后端 ${backend.archive}；请重新安装完整的 dsh-gxworks 包。`)
  }
  const parent = dirname(root)
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.extract-'))
  try {
    log(`首次准备内置 GXWorks Agent ${backend.version}（本地解压，无需下载）`)
    const powershell = join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DSH_GXWORKS_ARCHIVE -DestinationPath $env:DSH_GXWORKS_EXTRACT"],
    { env: { ...env, DSH_GXWORKS_ARCHIVE: archive, DSH_GXWORKS_EXTRACT: staging }, windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 })
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${prepareBundledRuntime()}\n`)
  } catch (error) {
    process.stderr.write(`[dsh-gxworks] ${error.message}\n`)
    process.exitCode = 2
  }
}
