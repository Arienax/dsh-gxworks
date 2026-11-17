// SPDX-License-Identifier: AGPL-3.0

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { backend, bundledArchiveParts, bundledRuntimeRoot, joinArchiveParts, packageRoot, prepareBundledRuntime, runtimeReady } from '../launch/bundled-runtime.mjs'

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
  if (backend.archiveParts) assert(manifest.files.includes(`runtime/${backend.archive}.part*`))
  assert(manifest.files.includes('launch/bundled-runtime.mjs'))
  assert(manifest.files.includes('runtime/backend.json'))
  assert(bundledArchiveParts.length > 0 && bundledArchiveParts.every(part => existsSync(part)))
  const first = openSync(bundledArchiveParts[0], 'r')
  try {
    const signature = Buffer.alloc(2)
    readSync(first, signature, 0, 2, 0)
    assert(signature.equals(Buffer.from('PK')), 'actual ZIP, not an LFS pointer')
  } finally {
    closeSync(first)
  }
})

test('archive parts preserve their byte order across copy-buffer boundaries', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-archive-parts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contents = [Buffer.alloc(4 * 1024 * 1024 + 17, 0x23), Buffer.from([0, 255, 80, 75]), Buffer.alloc(31, 0x7a)]
  const parts = contents.map((content, index) => {
    const path = join(root, `part${index}`)
    writeFileSync(path, content)
    return path
  })
  const destination = join(root, 'joined.zip')
  joinArchiveParts(parts, destination)
  assert.deepEqual(readFileSync(destination), Buffer.concat(contents))
})

test('an absent archive part is rejected before creating the runtime cache', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-missing-part-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const first = join(scratch, 'part001')
  writeFileSync(first, 'PK')
  const env = { LOCALAPPDATA: join(scratch, 'user') }
  assert.throws(() => prepareBundledRuntime({ platform: 'win32', arch: 'x64', env,
    archiveParts: [first, join(scratch, 'missing-part002')],
  }), /插件安装包缺少后端/)
  assert.equal(existsSync(env.LOCALAPPDATA), false)
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
