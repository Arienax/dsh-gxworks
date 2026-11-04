/** Exercise the installed package's bundled backend with no external GXWorks Agent or Python. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const installed = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-gxworks-install-'))
const user = join(scratch, 'user')
await mkdir(user)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(GXWORKS_|GX_|PLC_|PYTHON|OPENAI_|ANTHROPIC_)/i.test(key)))
Object.assign(env, {
  USERPROFILE: user, HOME: user, LOCALAPPDATA: join(user, 'AppData', 'Local'),
  APPDATA: join(user, 'AppData', 'Roaming'), PATH: dirname(process.execPath),
  PLC_AI_CONFIG_PATH: join(scratch, 'config.json'), PLC_AI_DATA_DIR: join(scratch, 'data'),
})
// Windows treats environment names case-insensitively; retain only the scrubbed PATH.
for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key]
const child = spawn(process.execPath, [join(installed, 'launch', 'mcp-launch.mjs'),
  '--workspace', join(scratch, 'workspace'), '--state-dir', join(scratch, 'state')],
{ cwd: scratch, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const closed = once(child, 'close')
let diagnostics = ''
child.stderr.on('data', chunk => { diagnostics += chunk })
const pending = new Map()
let nextId = 0
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  try {
    const message = JSON.parse(line)
    const slot = pending.get(message.id)
    if (!slot) return
    pending.delete(message.id)
    clearTimeout(slot.timer)
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
    else slot.resolve(message.result)
  } catch (error) {
    for (const slot of pending.values()) slot.reject(new Error(`MCP stdout 不是 JSON: ${line}: ${error.message}`))
  }
})
child.on('exit', code => {
  for (const slot of pending.values()) {
    clearTimeout(slot.timer)
    slot.reject(new Error(`MCP 退出 (${code}): ${diagnostics}`))
  }
  pending.clear()
})
function request(method, params = {}) {
  const id = ++nextId
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} 超时: ${diagnostics}`))
    }, 90_000)
    pending.set(id, { resolve: resolveRequest, reject, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
async function call(name, arguments_) {
  const result = await request('tools/call', { name, arguments: arguments_ })
  assert.notEqual(result.isError, true, JSON.stringify(result))
  const value = result.structuredContent || JSON.parse(result.content[0].text)
  assert.notEqual(value.ok, false, JSON.stringify(value))
  assert.notEqual(value.status, 'error', JSON.stringify(value))
  return value
}
try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-gxworks-package-check', version: '0.2.0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  assert(initialized.serverInfo.name)
  const tools = (await request('tools/list')).tools
  for (const name of ['list_projects', 'create_project', 'search_plc_manual', 'get_generation_context']) {
    assert(tools.some(tool => tool.name === name), `缺少工具 ${name}`)
  }
  await call('list_projects', {})
  const created = await call('create_project', { name: 'Bundled backend install check', plc_model: 'FX3U', target_mode: 'ladder' })
  const facts = await call('search_plc_manual', { query: 'PLSY 操作数', plc_model: 'FX3U', top_k: 2 })
  const dereference = value => value?.$ref ? facts.data.objects[value.$ref.slice('#/objects/'.length)] : value
  assert.equal(facts.data.delivery.complete, true, 'small retrieval should fit in one delivered page')
  const rows = dereference(dereference(facts.data.document).results)
  assert(rows?.length > 0, JSON.stringify(facts))
  await call('get_generation_context', { user_requirement: 'X0 controls Y0', workflow: 'direct_generation' })
  assert(diagnostics.includes('安装根来源：bundled'), diagnostics)
  assert(diagnostics.includes('首次准备内置 GXWorks Agent'), diagnostics)
  process.stdout.write(`${JSON.stringify({ package: installed, server: initialized.serverInfo.name,
    tools: tools.length, backend: 'bundled', firstLaunchExtraction: 'passed',
    projectCreated: created.ok, factResults: rows.length, generationContext: 'passed',
    pythonOnPath: false, externalAgentConfigured: false }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error.stack}\n${diagnostics}\n`)
  process.exitCode = 1
} finally {
  child.stdin.end()
  await closed
  lines.close()
  for (const slot of pending.values()) clearTimeout(slot.timer)
  await rm(scratch, { recursive: true, force: true })
}
