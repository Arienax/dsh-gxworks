// SPDX-License-Identifier: AGPL-3.0

/** Exercise the installed package's bundled backend with no external GXWorks Agent or Python. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'

const installed = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-gxworks-install-'))
const user = join(scratch, 'user')
await mkdir(user)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(GXWORKS2?_|GX_|PLC_|PYTHON|OPENAI_|ANTHROPIC_)/i.test(key)))
Object.assign(env, {
  USERPROFILE: user, HOME: user, LOCALAPPDATA: join(user, 'AppData', 'Local'),
  APPDATA: join(user, 'AppData', 'Roaming'), PATH: dirname(process.execPath),
  DSH_HOME: join(user, '.dsh'),
  PLC_AI_CONFIG_PATH: join(scratch, 'config.json'), PLC_AI_DATA_DIR: join(scratch, 'data'),
})
// Windows treats environment names case-insensitively; retain only the scrubbed PATH.
for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key]
const child = spawn(process.execPath, [join(installed, 'launch', 'mcp-launch.mjs'),
  '--read-budget-tokens', '128000', '--workspace', join(scratch, 'workspace'), '--state-dir', join(scratch, 'state')],
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
    }, method === 'initialize' ? 360_000 : 90_000)
    pending.set(id, { resolve: resolveRequest, reject, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
async function call(name, arguments_) {
  const result = await request('tools/call', { name, arguments: arguments_ })
  const value = result.structuredContent || JSON.parse(result.content[0].text)
  if (result.isError || value.ok === false) {
    throw Object.assign(Error(name + ': ' + JSON.stringify(value.error || value)), { detail: value.error })
  }
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
  for (const name of ['get_generation_context', 'get_design_context', 'search_plc_manual', 'get_fbd_catalog']) {
    assert(!Object.hasOwn(tools.find(tool => tool.name === name).inputSchema.properties, 'read_budget_tokens'))
  }
  await call('list_projects', {})
  const { data: discovery } = await call('list_gxworks2_sessions', {})
  assert.equal(typeof discovery.gx_works2_installed, 'boolean')
  assert(Array.isArray(discovery.sessions))
  if (discovery.gx_works2_installed) {
    const exe = discovery.gx_works2_executable
    assert(isAbsolute(exe) && basename(exe).toLowerCase() === 'gd2.exe' && (await stat(exe)).isFile())
    const cached = JSON.parse(await readFile(join(env.PLC_AI_DATA_DIR, 'gxworks2-installation.json'), 'utf8'))
    assert.equal(cached.gx_works2_executable, exe)
  } else {
    assert.equal(discovery.gx_works2_executable, null)
  }
  const created = await call('create_project', { name: 'Bundled backend install check', plc_model: 'FX3U', target_mode: 'ladder' })
  async function readContext(tool, args) {
    const { data } = await call(tool, args)
    assert.equal(data.context_schema_version, 4)
    assert.equal(data.delivery.complete, true)
    assert(!data.delivery.next, 'upstream must deliver a complete document')
    return data.document
  }
  const document = await readContext('search_plc_manual', { query: 'PLSY 操作数', plc_model: 'FX3U', top_k: 2 })
  assert.equal(document.language, 'ladder')
  assert.equal(document.language_source, 'project')
  assert(tools.find(tool => tool.name === 'search_plc_manual').inputSchema.properties.language.enum.includes('sfc'))
  const rows = document.results
  assert(rows?.length > 0, JSON.stringify(document))
  assert.equal(created.data.next_actions[0].tool, 'get_design_context')
  const design = await readContext('get_design_context', { user_requirement: 'X0 controls Y0' })
  assert(design.analysis_instructions.includes('Analysis mode: design'))
  const plan = await call('propose_design_plan', { analysis_id: design.analysis_id, analysis: {
    summary: 'X0 controls Y0', execution_intent_claims: [], explicit_constraint_claims: [],
    approaches: [{ approach_id: 'direct_contact', name: 'Direct contact', implementation_semantics: [],
      description: 'Drive Y0 directly from X0.', decision_basis: [],
      output_logic: [{ target: 'Y0', state: 'Follow X0 without memory.', activation: 'X0 is on.',
        update: 'Evaluate X0 each scan.', release: 'X0 is off.',
        interruption: 'Turn off when X0 is off.', selection: 'One input contact and one output coil.' }],
    }],
  } })
  assert(plan.data.draft_id, JSON.stringify(plan.data))
  const saved = await call('confirm_design_plan', { draft_id: plan.data.draft_id, approach_id: 'direct_contact' })
  assert.equal(saved.data.confirmed, true)
  const context = await readContext('get_generation_context', saved.data.next_actions[0].arguments)
  assert.equal(context.generation_input.confirmed_spec.selected_approach.approach_id, 'direct_contact')
  assert.equal(context.output_contract.protocol, 'compact_ladder/1.4')
  assert(context.generation_context_id)
  assert(context.generation_input.output_schema)
  const designCandidate = await call('create_program_candidate', {
    generation_context_id: context.generation_context_id,
    ladder: { r: [{ c: ['NO X0'], b: [{ i: [], o: ['COIL Y0'] }] }], device_comments: [] },
  })
  assert(designCandidate.data.version_id, JSON.stringify(designCandidate))
  await call('create_project', { name: 'Upstream Direct timer check', plc_model: 'FX3U', target_mode: 'ladder', generation_mode: 'direct' })
  const direct = await readContext('get_generation_context', { workflow: 'direct_generation',
    user_requirement: '直接生成：X0 为 ON 时 T0 延时 5 秒，T0 到时驱动 Y0；X0 为 OFF 时定时器和 Y0 均复位。T0 使用 100ms 时基。' })
  assert.equal(direct.output_contract.protocol, 'compact_ladder/1.4')
  assert(direct.generation_input.output_schema.properties.result)
  const directCandidate = await call('create_program_candidate', {
    generation_context_id: direct.generation_context_id,
    ladder: { result: {
      decisions: { candidates: [{ method: 'T0 timer', tradeoff: 'One non-retentive timer.',
        instruction_choices: [{ opcode: 'OUT', role: 'Timer and output coil' }], decision_basis: [] }], selected: 0, rationale: 'Follow the specified timer and reset behavior.' },
      program: { r: [{ c: ['NO X0'], b: [{ i: [], o: [{ timer: 'T0', duration_ms: 5000, tick_ms: 100 }] }] },
        { c: ['NO T0'], b: [{ i: [], o: ['COIL Y0'] }] }], device_comments: [] }, open_items: [],
    } },
  })
  assert(directCandidate.data.version_id, JSON.stringify(directCandidate))
  const languageContracts = {}
  for (const [language, tool] of [['st', 'create_st_candidate'], ['fbd', 'create_fbd_candidate'], ['sfc', 'create_sfc_candidate']]) {
    await call('create_project', { name: 'Upstream ' + language + ' contract check', plc_model: 'FX3U', target_mode: language, generation_mode: 'direct' })
    const document = await readContext('get_generation_context', { user_requirement: 'X0 controls Y0', workflow: 'direct_generation' })
    assert.equal(document.output_contract.tool, tool, JSON.stringify(document.output_contract))
    languageContracts[language] = document.output_contract.tool
  }
  assert(diagnostics.includes('安装根来源：bundled'), diagnostics)
  assert(diagnostics.includes('首次准备内置 GXWorks Agent'), diagnostics)
  process.stdout.write(`${JSON.stringify({ package: installed, server: initialized.serverInfo.name,
    tools: tools.length, backend: 'bundled', firstLaunchExtraction: 'passed',
    projectCreated: created.ok, factResults: rows.length, generationContext: 'passed',
    upstreamDesignCandidate: designCandidate.data.version_id, upstreamDirectTimerCandidate: directCandidate.data.version_id,
    languageContracts,
    gxWorks2Executable: discovery.gx_works2_executable, visibleWindows: discovery.sessions.length,
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
