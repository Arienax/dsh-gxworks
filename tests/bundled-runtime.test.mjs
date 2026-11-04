import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { backend, bundledArchive, bundledRuntimeRoot, packageRoot, prepareBundledRuntime, runtimeReady } from '../launch/bundled-runtime.mjs'

test('the launcher starts through a linked Desktop installation', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const installed = join(root, 'plugin')
  symlinkSync(packageRoot, installed, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(root, 'GXWorks-Agent-MCP.exe'), '')
  const output = execFileSync(process.execPath,
    [join(installed, 'launch', 'mcp-launch.mjs'), '--print-plan', '--agent-root', root], { encoding: 'utf8' })
  assert.equal(JSON.parse(output).printPlan, true)
})

test('the npm file list ships the backend archive and its deployment module', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert(manifest.files.includes(`runtime/${backend.archive}`))
  assert(manifest.files.includes('launch/bundled-runtime.mjs'))
  assert(manifest.files.includes('runtime/backend.json'))
  assert(readFileSync(bundledArchive).subarray(0, 2).equals(Buffer.from('PK')), 'actual ZIP, not an LFS pointer')
})

test('the bundled runtime rejects unsupported platforms with an actionable message', () => {
  assert.throws(() => prepareBundledRuntime({ platform: 'linux', arch: 'x64' }), /Windows x64/)
  assert.throws(() => prepareBundledRuntime({ platform: 'win32', arch: 'arm64' }), /Windows x64/)
})

test('a missing archive reports an incomplete plugin, without asking for a Python install', () => {
  assert.throws(() => prepareBundledRuntime({ platform: 'win32', arch: 'x64',
    env: { LOCALAPPDATA: join(tmpdir(), 'dsh-missing-runtime') }, archive: join(tmpdir(), 'no-gxworks-backend.zip'),
  }), /插件安装包缺少后端/)
})

test('an executable alone is not a complete cached backend, and mismatched releases are rejected', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-test-'))
  try {
    const root = bundledRuntimeRoot({ LOCALAPPDATA: scratch })
    mkdirSync(dirname(root), { recursive: true })
    mkdirSync(root)
    writeFileSync(join(root, backend.executable), '')
    writeFileSync(join(root, 'release.json'), JSON.stringify({ version: '0.1.0', component: 'mcp' }))
    assert.equal(runtimeReady(root), false)
    writeFileSync(join(root, 'release.json'), JSON.stringify({ version: backend.version, source_commit: backend.sourceCommit, component: 'mcp' }))
    assert.equal(runtimeReady(root), false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
