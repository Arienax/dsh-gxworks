#!/usr/bin/env node
/**
 * dsh-gxworks — stdio launcher for the GXWorks Agent MCP server.
 *
 * The DeepSeek Harness MCP client spawns this file with a scrubbed environment,
 * a working directory that is the Harness installation, and no knowledge of
 * Windows install layouts. This launcher therefore resolves the local GXWorks
 * Agent installation from, in order: `--agent-root`, `GXWORKS_AGENT_ROOT`,
 * `GXWORKS_AGENT_HOME`, a remembered root (see `--set-root`), the working
 * directory and its parents, then `PATH`. It prefers the frozen
 * `GXWorks-Agent-MCP.exe`, then `.venv-mcp`, `.venv`, `py -3`, and `python`,
 * and adds `--local` when the caller selected no runtime mode.
 *
 * stdout belongs to the MCP protocol stream: every diagnostic goes to stderr.
 * Only the explicit commands `--print-plan` and `--set-root` write to stdout.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Frozen product launcher shipped by the GXWorks Agent MCP release package. */
export const FROZEN_LAUNCHER = 'GXWorks-Agent-MCP.exe'
/** Source-checkout entry point used by the documented `.cmd` launcher. */
export const ENTRY_SCRIPT = join('scripts', 'mcp_entry.py')
/** Python interpreters inside the installation, in preference order. */
export const PYTHON_CANDIDATES = [
  ['.venv-mcp', 'Scripts', 'python.exe'],
  ['.venv', 'Scripts', 'python.exe'],
  ['.venv-mcp', 'bin', 'python'],
  ['.venv', 'bin', 'python'],
]

const MODE_FLAGS = ['--local', '--service', '--standalone', '--check', '--install-codex']
const SERVICE_HINTS = ['--service-url', '--service-token-env']

export class LaunchPlanError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'LaunchPlanError'
    this.detail = detail
  }
}

function defaultIsFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function defaultIsDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function defaultFindOnPath(name, env) {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  const searchPath = env.PATH ?? env.Path ?? ''
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      if (defaultIsFile(candidate)) return candidate
    }
  }
  return undefined
}

/** Where a resolved installation root came from, for `--print-plan`. */
export const ROOT_SOURCES = ['flag', 'env', 'settings', 'cwd', 'path']

/** Per-user settings file, outside every workspace and outside this package. */
export function settingsPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir()
  return join(home, '.dsh', 'dsh-gxworks', 'settings.json')
}

/** Remember an installation root so later Harness boots need no discovery. */
export function rememberAgentRoot(root, env = process.env) {
  const path = settingsPath(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ agentRoot: root }, null, 2)}\n`, 'utf8')
  return path
}

/** Read the remembered root; a missing or unreadable file simply means none. */
export function readRememberedRoot(env = process.env, readFile = defaultReadFile) {
  try {
    const parsed = JSON.parse(readFile(settingsPath(env)))
    const value = typeof parsed?.agentRoot === 'string' ? parsed.agentRoot.trim() : ''
    return value ? resolve(value) : undefined
  } catch {
    return undefined
  }
}

function defaultReadFile(path) {
  return readFileSync(path, 'utf8')
}

/** Split our own flags from the arguments forwarded to `mcp_entry.py`. */
export function splitArgs(argv) {
  const ours = {}
  const passthrough = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--print-plan') {
      ours.printPlan = true
    } else if (value === '--agent-root' || value === '--set-root') {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new LaunchPlanError(`${value} 需要一个目录参数。`)
      }
      if (value === '--set-root') ours.setRoot = next
      else ours.agentRoot = next
      index += 1
    } else if (value.startsWith('--agent-root=')) {
      ours.agentRoot = value.slice('--agent-root='.length)
    } else if (value.startsWith('--set-root=')) {
      ours.setRoot = value.slice('--set-root='.length)
    } else {
      passthrough.push(value)
    }
  }
  return { ours, passthrough }
}

/** True when the caller already selected a runtime mode or a service binding. */
export function hasModeFlag(args) {
  return args.some(
    value =>
      MODE_FLAGS.includes(value) ||
      SERVICE_HINTS.some(hint => value === hint || value.startsWith(`${hint}=`)),
  )
}

/** True when the directory contains a launcher this module can start. */
export function looksLikeAgentRoot(directory, isFile = defaultIsFile) {
  return isFile(join(directory, FROZEN_LAUNCHER)) || isFile(join(directory, ENTRY_SCRIPT))
}

/** Walk the working directory upwards looking for a GXWorks Agent checkout. */
export function discoverAgentRoot({ cwd, isFile, maxDepth = 8 }) {
  let directory = resolve(cwd)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (looksLikeAgentRoot(directory, isFile)) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Resolve the command line that runs the GXWorks Agent MCP server.
 *
 * Pure apart from the injected filesystem probes, so the resolution order is
 * testable without a real installation.
 */
export function planLaunch(options = {}) {
  const {
    argv = [],
    env = {},
    cwd = process.cwd(),
    isFile = defaultIsFile,
    isDir = defaultIsDir,
    findOnPath = defaultFindOnPath,
    now = () => new Date().toISOString(),
  } = options

  const { ours, passthrough } = splitArgs(argv)
  const explicitExe = (env.GXWORKS_MCP_EXE ?? '').trim()
  const readRemembered =
    options.readRememberedRoot ?? (environment => readRememberedRoot(environment))

  const finish = (plan, extraArgs = []) => ({
    ...plan,
    args: [...plan.args, ...(hasModeFlag(passthrough) ? [] : ['--local']), ...extraArgs, ...passthrough],
    printPlan: Boolean(ours.printPlan),
    setRoot: ours.setRoot ? resolve(ours.setRoot) : undefined,
    settingsPath: settingsPath(env),
  })

  const resolveCommand = ({ root, source }) => {
    const frozen = join(root, FROZEN_LAUNCHER)
    if (isFile(frozen)) {
      return { command: frozen, args: [], flavor: 'frozen', agentRoot: root, agentRootSource: source }
    }

    const entry = join(root, ENTRY_SCRIPT)
    if (!isFile(entry)) {
      throw new LaunchPlanError(
        [
          `GXWorks Agent 安装目录里既没有 ${FROZEN_LAUNCHER}，也没有 ${ENTRY_SCRIPT}：`,
          root,
        ].join('\n'),
      )
    }

    for (const segments of PYTHON_CANDIDATES) {
      const python = join(root, ...segments)
      if (isFile(python)) {
        return {
          command: python,
          args: [entry],
          flavor: segments[0] === '.venv-mcp' ? 'venv-mcp' : 'venv',
          agentRoot: root,
          agentRootSource: source,
        }
      }
    }

    const pyLauncher = findOnPath('py', env)
    if (pyLauncher) {
      return {
        command: pyLauncher,
        args: ['-3', entry],
        flavor: 'py-launcher',
        agentRoot: root,
        agentRootSource: source,
      }
    }

    for (const name of ['python', 'python3']) {
      const python = findOnPath(name, env)
      if (python) {
        return {
          command: python,
          args: [entry],
          flavor: 'python',
          agentRoot: root,
          agentRootSource: source,
        }
      }
    }

    throw new LaunchPlanError(
      [
        'GXWorks Agent 的 Python 运行时不可用。',
        `请创建 ${root} 下的 .venv（pip install -r requirements/mcp.txt），`,
        '使用 MCP 独立发布包中的 GXWorks-Agent-MCP.exe，或把 py/python 放进 PATH。',
      ].join('\n'),
    )
  }

  // `--set-root` is a one-shot setup command: it records the root and then runs
  // the same resolution, so a successful write is immediately provable.
  if (ours.setRoot) {
    const candidate = resolve(ours.setRoot)
    if (!isDir(candidate) || !looksLikeAgentRoot(candidate, isFile)) {
      throw new LaunchPlanError(
        [
          `${candidate} 不像是 GXWorks Agent 安装目录：`,
          `应包含 ${FROZEN_LAUNCHER} 或 ${ENTRY_SCRIPT}。`,
        ].join('\n'),
      )
    }
    const written = rememberAgentRoot(candidate, env)
    process.stderr.write(`[dsh-gxworks] 已记住安装根 ${candidate}（${written}）\n`)
    const plan = resolveCommand({ root: candidate, source: 'flag' })
    return { ...finish(plan), remembered: written, plannedAt: now() }
  }

  if (explicitExe) {
    const exe = resolve(explicitExe)
    if (!isFile(exe)) {
      throw new LaunchPlanError(`GXWORKS_MCP_EXE 指向的文件不存在：${exe}`)
    }
    return finish({ command: exe, args: [], flavor: 'frozen', agentRoot: dirname(exe), agentRootSource: 'env' })
  }

  const candidates = []
  const flagRoot = ours.agentRoot
  const envRoot = (env.GXWORKS_AGENT_ROOT ?? '').trim() || (env.GXWORKS_AGENT_HOME ?? '').trim()
  if (flagRoot) candidates.push({ root: resolve(flagRoot), source: 'flag' })
  if (envRoot) candidates.push({ root: resolve(envRoot), source: 'env' })
  const remembered = readRemembered(env)
  if (remembered) candidates.push({ root: remembered, source: 'settings' })

  for (const candidate of candidates) {
    if (candidate.source !== 'settings' && !isDir(candidate.root)) {
      throw new LaunchPlanError(
        `${candidate.source === 'flag' ? '--agent-root' : 'GXWORKS_AGENT_ROOT'} 指向的目录不存在：${candidate.root}`,
      )
    }
    if (looksLikeAgentRoot(candidate.root, isFile)) return finish(resolveCommand(candidate))
  }

  const discovered = discoverAgentRoot({ cwd, isFile })
  if (discovered) return finish(resolveCommand({ root: discovered, source: 'cwd' }))

  for (const name of ['GXWorks-Agent-MCP.exe', 'gxworks-agent-mcp.exe']) {
    const onPath = findOnPath(name, env)
    if (onPath) {
      return finish({ command: onPath, args: [], flavor: 'frozen', agentRoot: dirname(onPath), agentRootSource: 'path' })
    }
  }

  throw new LaunchPlanError(
    [
      '未找到本机 GXWorks Agent 安装目录。',
      '任选一种方式指定：',
      `  1. node launch/mcp-launch.mjs --set-root <安装目录>   （记住到 ${settingsPath(env)}）`,
      `  2. 在 Harness 环境里设置 GXWORKS_AGENT_ROOT=<安装目录>`,
      `  3. 把 Harness 的工作目录放在安装目录之内`,
      `安装目录应包含 ${FROZEN_LAUNCHER} 或 ${ENTRY_SCRIPT}。已检查工作目录：${resolve(cwd)}`,
    ].join('\n'),
  )
}

function log(message) {
  process.stderr.write(`[dsh-gxworks] ${message}\n`)
}

function run() {
  let plan
  try {
    plan = planLaunch({ argv: process.argv.slice(2), env: process.env })
  } catch (error) {
    if (error instanceof LaunchPlanError) {
      log(error.message)
      process.exitCode = 2
      return
    }
    throw error
  }

  if (plan.printPlan) {
    // Diagnostics only: this mode never proxies the MCP protocol stream.
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }

  if (plan.setRoot) {
    // Setup command: record the root and stop instead of starting a server.
    process.stdout.write(
      `已记住 GXWorks Agent 安装根：${plan.agentRoot}\n` +
        `写入 ${plan.settingsPath}\n` +
        `下次启动使用：${plan.command} ${plan.args.join(' ')}\n`,
    )
    return
  }

  // Avoid printing local filesystem paths or forwarded arguments in routine logs.
  log(`启动 GXWorks Agent MCP（${plan.flavor}；安装根来源：${plan.agentRootSource}）`)
  const child = spawn(plan.command, plan.args, {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  })

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  }

  child.on('error', error => {
    log(`无法启动 GXWorks Agent MCP：${error.message}`)
    process.exit(2)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      log(`GXWorks Agent MCP 因信号 ${signal} 退出。`)
      process.exit(1)
    }
    if (code !== 0) log(`GXWorks Agent MCP 以状态码 ${code} 退出。`)
    process.exit(code ?? 0)
  })
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) run()
