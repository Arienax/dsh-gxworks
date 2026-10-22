import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  ENTRY_SCRIPT,
  FROZEN_LAUNCHER,
  LaunchPlanError,
  hasModeFlag,
  planLaunch,
  splitArgs,
} from '../launch/mcp-launch.mjs'

const root = resolve('C:', 'gxworks-agent')

/** Build injected filesystem probes from an explicit file/directory set. */
function probes(files = [], directories = []) {
  const fileSet = new Set(files.map(value => resolve(value)))
  const directorySet = new Set(directories.map(value => resolve(value)))
  return {
    isFile: value => fileSet.has(resolve(value)),
    isDir: value => directorySet.has(resolve(value)),
    findOnPath: () => undefined,
  }
}

function plan(argv, { files = [], directories = [root], env = {}, cwd = root, findOnPath } = {}) {
  const injected = { ...probes(files, directories), findOnPath: findOnPath ?? (() => undefined) }
  return planLaunch({ argv, env, cwd, ...injected })
}

test('the frozen release launcher wins over virtual environments', () => {
  const result = plan([], {
    files: [join(root, FROZEN_LAUNCHER), join(root, ENTRY_SCRIPT), join(root, '.venv', 'Scripts', 'python.exe')],
  })
  assert.equal(result.flavor, 'frozen')
  assert.equal(result.command, join(root, FROZEN_LAUNCHER))
  assert.deepEqual(result.args, ['--local'])
})

test('the MCP virtual environment runs the source entry point', () => {
  const python = join(root, '.venv-mcp', 'Scripts', 'python.exe')
  const result = plan([], { files: [join(root, ENTRY_SCRIPT), python] })
  assert.equal(result.flavor, 'venv-mcp')
  assert.equal(result.command, python)
  assert.deepEqual(result.args, [join(root, ENTRY_SCRIPT), '--local'])
})

test('a plain .venv is used when the dedicated MCP environment is absent', () => {
  const python = join(root, '.venv', 'Scripts', 'python.exe')
  const result = plan([], { files: [join(root, ENTRY_SCRIPT), python] })
  assert.equal(result.flavor, 'venv')
  assert.equal(result.command, python)
})

test('the py launcher is used when no virtual environment exists', () => {
  const result = plan([], {
    files: [join(root, ENTRY_SCRIPT)],
    findOnPath: name => (name === 'py' ? 'C:\\Windows\\py.exe' : undefined),
  })
  assert.equal(result.flavor, 'py-launcher')
  assert.deepEqual(result.args, ['-3', join(root, ENTRY_SCRIPT), '--local'])
})

test('passthrough arguments are forwarded and the default mode is not duplicated', () => {
  const python = join(root, '.venv', 'Scripts', 'python.exe')
  const result = plan(['--workspace', 'D:\\plc', '--project', 'project-1'], {
    files: [join(root, ENTRY_SCRIPT), python],
  })
  assert.deepEqual(result.args, [
    join(root, ENTRY_SCRIPT),
    '--local',
    '--workspace',
    'D:\\plc',
    '--project',
    'project-1',
  ])
})

test('service mode is never downgraded to local', () => {
  const python = join(root, '.venv', 'Scripts', 'python.exe')
  const result = plan(['--service'], { files: [join(root, ENTRY_SCRIPT), python] })
  assert.deepEqual(result.args, [join(root, ENTRY_SCRIPT), '--service'])
  assert.equal(hasModeFlag(['--service-url=http://127.0.0.1:8765']), true)
  assert.equal(hasModeFlag(['--workspace', 'D:\\plc']), false)
})

test('the explicit executable override wins without an installation directory', () => {
  const exe = join('C:', 'tools', FROZEN_LAUNCHER)
  const result = planLaunch({
    argv: ['--check'],
    env: { GXWORKS_MCP_EXE: exe },
    cwd: resolve('C:', 'elsewhere'),
    ...probes([exe]),
  })
  assert.equal(result.flavor, 'frozen')
  assert.deepEqual(result.args, ['--check'])
})

test('GXWORKS_AGENT_ROOT overrides discovery', () => {
  const other = resolve('C:', 'other-install')
  const python = join(other, '.venv', 'Scripts', 'python.exe')
  const result = planLaunch({
    argv: [],
    env: { GXWORKS_AGENT_ROOT: other },
    cwd: resolve('C:', 'elsewhere'),
    ...probes([join(other, ENTRY_SCRIPT), python], [other]),
  })
  assert.equal(result.agentRoot, other)
  assert.equal(result.command, python)
})

test('the working directory is searched upwards for the installation', () => {
  const nested = join(root, 'src', 'gxw')
  const python = join(root, '.venv', 'Scripts', 'python.exe')
  const result = planLaunch({
    argv: [],
    env: {},
    cwd: nested,
    ...probes([join(root, ENTRY_SCRIPT), python], [root, join(root, 'src'), nested]),
  })
  assert.equal(result.agentRoot, root)
})

test('--agent-root is our own flag and never reaches the MCP server', () => {
  const python = join(root, '.venv', 'Scripts', 'python.exe')
  const result = plan(['--agent-root', root, '--print-plan'], {
    files: [join(root, ENTRY_SCRIPT), python],
    env: { GXWORKS_AGENT_ROOT: resolve('C:', 'ignored') },
  })
  assert.equal(result.printPlan, true)
  assert.equal(result.agentRoot, root)
  assert.deepEqual(result.args, [join(root, ENTRY_SCRIPT), '--local'])
})

test('splitArgs rejects a missing flag value', () => {
  assert.throws(() => splitArgs(['--agent-root']), LaunchPlanError)
  assert.throws(() => splitArgs(['--agent-root', '--local']), LaunchPlanError)
})

test('a missing installation reports how to fix it', () => {
  assert.throws(
    () =>
      planLaunch({
        argv: [],
        env: {},
        cwd: resolve('C:', 'empty'),
        ...probes([], [resolve('C:', 'empty')]),
      }),
    error => error instanceof LaunchPlanError && /GXWORKS_AGENT_ROOT/.test(error.message),
  )
})
