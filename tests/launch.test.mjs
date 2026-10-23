import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  ENTRY_SCRIPT,
  FROZEN_LAUNCHER,
  LaunchPlanError,
  hasModeFlag,
  planLaunch,
  settingsPath,
  splitArgs,
} from '../launch/mcp-launch.mjs'

const root = resolve('C:', 'gxworks-agent')
const python = join(root, '.venv', 'Scripts', 'python.exe')

/** Injected probes: an explicit file/directory set plus no remembered root. */
function probes(files = [], directories = [root], remembered) {
  const fileSet = new Set(files.map(value => resolve(value)))
  const directorySet = new Set(directories.map(value => resolve(value)))
  return {
    isFile: value => fileSet.has(resolve(value)),
    isDir: value => directorySet.has(resolve(value)),
    findOnPath: () => undefined,
    readRememberedRoot: () => remembered,
  }
}

function plan(argv, { files = [], directories = [root], env = {}, cwd = root, remembered, findOnPath } = {}) {
  return planLaunch({
    argv,
    env,
    cwd,
    ...probes(files, directories, remembered),
    findOnPath: findOnPath ?? (() => undefined),
  })
}

test('the frozen release launcher wins over virtual environments', () => {
  const result = plan([], {
    files: [join(root, FROZEN_LAUNCHER), join(root, ENTRY_SCRIPT), python],
  })
  assert.equal(result.flavor, 'frozen')
  assert.equal(result.command, join(root, FROZEN_LAUNCHER))
  assert.deepEqual(result.args, ['--local'])
})

test('the MCP virtual environment runs the source entry point', () => {
  const mcpPython = join(root, '.venv-mcp', 'Scripts', 'python.exe')
  const result = plan([], { files: [join(root, ENTRY_SCRIPT), mcpPython] })
  assert.equal(result.flavor, 'venv-mcp')
  assert.equal(result.command, mcpPython)
  assert.deepEqual(result.args, [join(root, ENTRY_SCRIPT), '--local'])
})

test('a plain .venv is used when the dedicated MCP environment is absent', () => {
  const result = plan([], { files: [join(root, ENTRY_SCRIPT), python] })
  assert.equal(result.flavor, 'venv')
  assert.equal(result.command, python)
  assert.equal(result.agentRootSource, 'cwd')
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
    ...probes([exe], [], undefined),
  })
  assert.equal(result.flavor, 'frozen')
  assert.deepEqual(result.args, ['--check'])
})

test('GXWORKS_AGENT_ROOT overrides discovery', () => {
  const other = resolve('C:', 'other-install')
  const otherPython = join(other, '.venv', 'Scripts', 'python.exe')
  const result = planLaunch({
    argv: [],
    env: { GXWORKS_AGENT_ROOT: other },
    cwd: resolve('C:', 'elsewhere'),
    ...probes([join(other, ENTRY_SCRIPT), otherPython], [other], undefined),
  })
  assert.equal(result.agentRoot, other)
  assert.equal(result.agentRootSource, 'env')
  assert.equal(result.command, otherPython)
})

test('a remembered installation root survives a working directory elsewhere', () => {
  const result = planLaunch({
    argv: [],
    env: { USERPROFILE: resolve('C:', 'user') },
    cwd: resolve('D:', 'unrelated-project'),
    ...probes([join(root, ENTRY_SCRIPT), python], [root], root),
  })
  assert.equal(result.agentRoot, root)
  assert.equal(result.agentRootSource, 'settings')
  assert.equal(result.command, python)
})

test('a flag root outranks environment and remembered roots', () => {
  const flagged = resolve('C:', 'flagged')
  const flaggedPython = join(flagged, '.venv', 'Scripts', 'python.exe')
  const result = planLaunch({
    argv: ['--agent-root', flagged],
    env: { GXWORKS_AGENT_ROOT: resolve('C:', 'ignored') },
    cwd: root,
    ...probes([join(flagged, ENTRY_SCRIPT), flaggedPython], [flagged], root),
  })
  assert.equal(result.agentRoot, flagged)
  assert.equal(result.agentRootSource, 'flag')
})

test('a stale remembered root falls through to discovery', () => {
  const stale = resolve('C:', 'removed-install')
  const result = planLaunch({
    argv: [],
    env: {},
    cwd: root,
    ...probes([join(root, ENTRY_SCRIPT), python], [root], stale),
  })
  assert.equal(result.agentRoot, root)
  assert.equal(result.agentRootSource, 'cwd')
})

test('the working directory is searched upwards for the installation', () => {
  const nested = join(root, 'src', 'gxw')
  const result = planLaunch({
    argv: [],
    env: {},
    cwd: nested,
    ...probes([join(root, ENTRY_SCRIPT), python], [root, join(root, 'src'), nested], undefined),
  })
  assert.equal(result.agentRoot, root)
})

test('the release launcher on PATH is accepted without any root', () => {
  const exe = join('C:', 'bin', FROZEN_LAUNCHER)
  const result = planLaunch({
    argv: [],
    env: {},
    cwd: resolve('C:', 'empty'),
    ...probes([exe], [], undefined),
    findOnPath: name => (name === FROZEN_LAUNCHER ? exe : undefined),
  })
  assert.equal(result.agentRootSource, 'path')
  assert.equal(result.command, exe)
})

test('--set-root remembers the installation and resolves immediately', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-gxworks-'))
  try {
    const result = planLaunch({
      argv: ['--set-root', root, '--print-plan'],
      env: { USERPROFILE: profile },
      cwd: resolve('C:', 'elsewhere'),
      ...probes([join(root, ENTRY_SCRIPT), python], [root], undefined),
    })
    const stored = join(profile, '.dsh', 'dsh-gxworks', 'settings.json')
    assert.equal(result.setRoot, root)
    assert.equal(result.agentRoot, root)
    assert.equal(result.command, python)
    assert.equal(settingsPath({ USERPROFILE: profile }), stored)
    assert.equal(existsSync(stored), true)
    assert.deepEqual(JSON.parse(readFileSync(stored, 'utf8')), { agentRoot: root })
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('--set-root rejects a directory that is not an installation', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-gxworks-'))
  try {
    assert.throws(
      () =>
        planLaunch({
          argv: ['--set-root', resolve('C:', 'not-an-install')],
          env: { USERPROFILE: profile },
          cwd: root,
          ...probes([], [resolve('C:', 'not-an-install')], undefined),
        }),
      error => error instanceof LaunchPlanError && /GXWorks Agent/.test(error.message),
    )
    assert.equal(existsSync(join(profile, '.dsh')), false)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('--agent-root is our own flag and never reaches the MCP server', () => {
  const result = plan(['--agent-root', root, '--print-plan'], {
    files: [join(root, ENTRY_SCRIPT), python],
    env: { GXWORKS_AGENT_ROOT: resolve('C:', 'ignored') },
  })
  assert.equal(result.printPlan, true)
  assert.deepEqual(result.args, [join(root, ENTRY_SCRIPT), '--local'])
})

test('splitArgs rejects a missing flag value', () => {
  assert.throws(() => splitArgs(['--agent-root']), LaunchPlanError)
  assert.throws(() => splitArgs(['--agent-root', '--local']), LaunchPlanError)
  assert.throws(() => splitArgs(['--set-root']), LaunchPlanError)
})

test('a missing installation reports how to fix it', () => {
  assert.throws(
    () =>
      planLaunch({
        argv: [],
        env: {},
        cwd: resolve('C:', 'empty'),
        ...probes([], [resolve('C:', 'empty')], undefined),
      }),
    error => error instanceof LaunchPlanError && /--set-root/.test(error.message),
  )
})
