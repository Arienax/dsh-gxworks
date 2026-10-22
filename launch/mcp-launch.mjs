#!/usr/bin/env node
/**
 * dsh-gxworks — stdio launcher for the GXWorks Agent MCP server.
 *
 * The DeepSeek Harness MCP client spawns this file with a scrubbed environment
 * and no knowledge of Windows install layouts. This launcher resolves the local
 * GXWorks Agent installation, picks the frozen launcher or the virtual
 * environment interpreter, defaults the runtime to `--local`, and then hands
 * stdin/stdout/stderr straight to the real MCP server.
 *
 * stdout belongs to the MCP protocol stream: every diagnostic goes to stderr.
 * Nothing is written to stdout except an explicit `--print-plan` payload.
 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
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
  const extensions =
    process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
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

/** Split our own flags from the arguments forwarded to `mcp_entry.py`. */
export function splitArgs(argv) {
  const ours = {}
  const passthrough = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--print-plan') {
      ours.printPlan = true
    } else if (value === '--agent-root') {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new LaunchPlanError('--agent-root 需要一个目录参数。')
      }
      ours.agentRoot = next
      index += 1
    } else if (value.startsWith('--agent-root=')) {
      ours.agentRoot = value.slice('--agent-root='.length)
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

/** Walk the working directory upwards looking for a GXWorks Agent checkout. */
export function discoverAgentRoot({ cwd, isFile, maxDepth = 8 }) {
  let directory = resolve(cwd)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (
      isFile(join(directory, FROZEN_LAUNCHER)) ||
      isFile(join(directory, ENTRY_SCRIPT))
    ) {
      return directory
    }
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
  } = options

  const { ours, passthrough } = splitArgs(argv)
  const explicitExe = (env.GXWORKS_MCP_EXE ?? '').trim()
  const declaredRoot =
    ours.agentRoot ??
    ((env.GXWORKS_AGENT_ROOT ?? '').trim() || (env.GXWORKS_AGENT_HOME ?? '').trim())

  const finish = plan => ({
    ...plan,
    args: [...plan.args, ...(hasModeFlag(passthrough) ? [] : ['--local']), ...passthrough],
    printPlan: Boolean(ours.printPlan),
  })

  if (explicitExe) {
    const exe = resolve(explicitExe)
    if (!isFile(exe)) {
      throw new LaunchPlanError(`GXWORKS_MCP_EXE 指向的文件不存在：${exe}`)
    }
    return finish({ command: exe, args: [], flavor: 'frozen', agentRoot: dirname(exe) })
  }

  let agentRoot
  if (declaredRoot) {
    agentRoot = resolve(declaredRoot)
    if (!isDir(agentRoot)) {
      throw new LaunchPlanError(`GXWorks Agent 安装目录不存在：${agentRoot}`)
    }
  } else {
    agentRoot = discoverAgentRoot({ cwd, isFile })
  }

  if (!agentRoot) {
    throw new LaunchPlanError(
      [
        '未找到本机 GXWorks Agent 安装目录。',
        `请设置 GXWORKS_AGENT_ROOT 指向包含 ${FROZEN_LAUNCHER} 或 ${ENTRY_SCRIPT} 的目录，`,
        '或者把 Harness 的工作目录放在该安装目录之内。',
        `已检查的工作目录：${resolve(cwd)}`,
      ].join('\n'),
    )
  }

  const frozen = join(agentRoot, FROZEN_LAUNCHER)
  if (isFile(frozen)) {
    return finish({ command: frozen, args: [], flavor: 'frozen', agentRoot })
  }

  const entry = join(agentRoot, ENTRY_SCRIPT)
  if (!isFile(entry)) {
    throw new LaunchPlanError(
      [
        `GXWorks Agent 安装目录里既没有 ${FROZEN_LAUNCHER}，也没有 ${ENTRY_SCRIPT}：`,
        agentRoot,
      ].join('\n'),
    )
  }

  for (const segments of PYTHON_CANDIDATES) {
    const python = join(agentRoot, ...segments)
    if (isFile(python)) {
      return finish({
        command: python,
        args: [entry],
        flavor: segments[0] === '.venv-mcp' ? 'venv-mcp' : 'venv',
        agentRoot,
      })
    }
  }

  const pyLauncher = findOnPath('py', env)
  if (pyLauncher) {
    return finish({
      command: pyLauncher,
      args: ['-3', entry],
      flavor: 'py-launcher',
      agentRoot,
    })
  }

  for (const name of ['python', 'python3']) {
    const python = findOnPath(name, env)
    if (python) {
      return finish({ command: python, args: [entry], flavor: 'python', agentRoot })
    }
  }

  throw new LaunchPlanError(
    [
      'GXWorks Agent 的 Python 运行时不可用。',
      `请创建 ${agentRoot} 下的 .venv（pip install -r requirements/mcp.txt），`,
      '使用 MCP 独立发布包中的 GXWorks-Agent-MCP.exe，或把 py/python 放进 PATH。',
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

  log(`启动 GXWorks Agent MCP（${plan.flavor}）：${plan.command} ${plan.args.join(' ')}`)
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
    process.exit(code ?? 0)
  })
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) run()
