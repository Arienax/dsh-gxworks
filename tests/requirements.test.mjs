// SPDX-License-Identifier: AGPL-3.0

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { apply as applyPlugin } from '../index.mjs'
import { reviewDesign as reviewDesignShared } from '../launch/design-review.mjs'

function apply(ctx) {
  return applyPlugin({ ...ctx, mcpManager: ctx.mcpManager || { register() {} } })
}

test('rc.3 owns the bundled MCP server through its manager', () => {
  const registrations = []
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = 'F:\\dsh-custom-home'
  try {
    apply({ on() {}, mcpManager: { register(...args) { registrations.push(args) } } })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  assert.equal(registrations.length, 1)
  const [name, config] = registrations[0]
  assert.equal(name, 'gxworks')
  assert.equal(config.command, process.execPath)
  assert.deepEqual(config.env, { DSH_HOME: 'F:\\dsh-custom-home' })
  assert.match(config.args[0], /launch[\\/]mcp-launch\.mjs$/u)
  assert.deepEqual(config.args.slice(1), ['--read-budget-tokens', '128000'])
  assert.equal(config.startupTimeoutMs, 600000)
  assert.equal(config.toolCallTimeoutMs, 600000)
  assert.equal(config.closeTimeoutMs, 10000)
  assert.equal(config.reconnect.enabled, true)
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert(!patch.includes("name: '@deepseek-ai/dsh-mcp-client'"), 'do not launch a duplicate static MCP server')
})

function evaluate(tool, args, messages) {
  let hook
  apply({ on: (name, callback) => { if (name === 'tools/pre-execute') hook = callback } })
  return hook({ name: 'mcp__gxworks__' + tool, arguments: args,
    agent: { session: { snapshotEvents: () => messages } } }, () => 'allowed')
}
const message = (text, kind = 'user') => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })

async function dispatch(tool, args, messages) {
  let hook
  apply({ on: (name, callback) => { if (name === 'tools/execute') hook = callback } })
  const exec = { name: 'mcp__gxworks__' + tool, arguments: Object.freeze(args),
    agent: { session: { snapshotEvents: () => messages } } }
  return hook(exec, () => exec.arguments)
}

test('the host sends original human messages in chronological order', async () => {
  const original = 'FX3U。D0 回零后识别下一件。\r\n多件物料分别追踪。'
  const events = [message(original), message('要求用四通道定时器。', 'system'), message('停机清除任务。')]
  const args = { user_requirement: '模型摘要。', instruction_details: true }
  assert.deepEqual(await dispatch('get_generation_context', args, events), {
    user_requirement: original + '\n停机清除任务。', instruction_details: true,
  })
  assert.deepEqual(await dispatch('get_generation_context', { workflow: 'direct_generation' }, events), {
    workflow: 'direct_generation', user_requirement: original + '\n停机清除任务。',
  })
  assert.deepEqual(await dispatch('get_generation_context', { workflow: 'detailed' }, events), { workflow: 'detailed' })
  assert.deepEqual(await dispatch('get_design_context', { cursor: 'next' }, events), { cursor: 'next' })
})

test('candidate review requirements are enforced by the current backend contract', () => {
  for (const tool of ['create_program_candidate', 'create_fbd_candidate']) {
    assert.equal(evaluate(tool, { operation: 'generate' }, []), 'allowed')
  }
  assert.equal(evaluate('create_program_candidate', { generation_context_id: 'edit', ladder: { mode: 'partial', r: [] } }, []), 'allowed')
  assert.equal(evaluate('create_st_candidate', { operation: 'generate' }, []), 'allowed')
  assert.equal(evaluate('create_sfc_candidate', { operation: 'generate' }, []), 'allowed')
  assert.equal(evaluate('create_fbd_candidate', { operation: 'edit' }, []), 'allowed')
  assert.equal(evaluate('create_fbd_candidate', { operation: 'import' }, []), 'allowed')
  assert.equal(evaluate('get_generation_context', {}, []), 'allowed')
})

test('Desktop binds confirmation to the human choice for this draft and session', async () => {
  const hooks = {}
  let pick = 1
  apply({ on: (name, callback) => { hooks[name] = callback },
    get: () => ({ ask: async ({ questions: [question] }) => {
      assert.match(question.detail, /Compare two ways/)
      assert.match(question.detail, /Use feedback/)
      const option = question.options[pick]
      return { answers: [{ id: question.id, selected: [option.label] }] }
    } }) })
  const session = {}
  const exec = { name: 'mcp__gxworks__propose_design_plan', agent: { session } }
  const result = { isError: false, value: { structuredContent: { ok: true, data: {
    draft_id: 'new', review: { summary: 'Compare two ways', approaches: [
      { name: 'State bit', approach_id: 'state' }, { name: 'Output contact', approach_id: 'contact', generation_guide: 'Use feedback' }] },
    issues: { errors: [] }, user_requirement: 'Start and stop.' } } } }
  const review = () => hooks['tools/post-execute'](exec, result, () => ({ kind: 'accept' }))
  const confirm = (draft_id, approach_id, owner = session) => hooks['tools/pre-execute']({
    name: 'mcp__gxworks__confirm_design_plan', arguments: { draft_id, approach_id }, agent: { session: owner } }, () => 'allowed')
  assert.equal(confirm('new', 'contact').kind, 'deny')
  const decision = (await review()).value.structuredContent.data
  assert.deepEqual(decision.next_actions[0].arguments, { draft_id: 'new', approach_id: 'contact' })
  assert.equal(confirm('new', 'contact'), 'allowed')
  assert.equal(confirm('new', 'state').kind, 'deny')
  assert.equal(confirm('old', 'contact').kind, 'deny')
  assert.equal(confirm('new', 'contact', {}).kind, 'deny')
  pick = 2
  assert.equal((await review()).value.structuredContent.data.approved, false)
  assert.equal(confirm('new', 'contact').kind, 'deny')
})

test('a draft that only lacks user facts still opens the window and submits the answers', async () => {
  const hooks = {}
  let asked
  apply({ on: (name, callback) => { hooks[name] = callback },
    get: name => name === 'userQuestions' ? { ask: async request => {
      asked = request.questions
      const [choice, parameter] = request.questions
      return { answers: [
        { id: choice.id, selected: [choice.options[0].label] },
        { id: parameter.id, selected: ['保留在途物料'] }] }
    } } : undefined })
  const session = {}
  const draft = { draft_id: 'd2', user_requirement: 'D0 件间回 0。',
    review: { summary: '整字移位历史', approaches: [{ name: '整字移位循环', approach_id: 'word' }],
      parameters: [{ id: 'stop_wip', name: '停机后在途物料怎样处理', required: true, value: '', options: ['保留在途物料', '清除'] }] },
    issues: { errors: [{ code: 'required_parameter_missing', path: '$.parameters[0].value', message: '必填参数尚未填写' }] } }
  const result = { isError: false, value: { structuredContent: { ok: true, data: draft } } }
  const decision = (await hooks['tools/post-execute']({ name: 'mcp__gxworks__propose_design_plan',
    agent: { session } }, result, async () => ({ kind: 'accept' }))).value.structuredContent.data
  assert.deepEqual(asked.map(question => question.id), ['gxworks-design', 'gxworks-parameter-stop_wip'])
  assert.deepEqual(asked[1].options, [{ label: '保留在途物料' }, { label: '清除' }])
  assert.equal(decision.approved, true)
  assert.deepEqual(decision.next_actions[0].arguments, { draft_id: 'd2', approach_id: 'word',
    parameter_answers: { stop_wip: '保留在途物料' } })
  assert.equal(hooks['tools/pre-execute']({ name: 'mcp__gxworks__confirm_design_plan',
    arguments: decision.next_actions[0].arguments, agent: { session } }, () => 'allowed'), 'allowed')
})

test('a draft the model must still fix never reaches the human', async () => {
  const hooks = {}
  let asked = 0
  apply({ on: (name, callback) => { hooks[name] = callback },
    get: () => ({ ask: async () => { asked += 1; return { answers: [] } } }) })
  const result = { isError: false, value: { structuredContent: { ok: true, data: { draft_id: 'd3', user_requirement: 'x',
    review: { summary: 's', approaches: [{ name: 'a', approach_id: 'a1' }],
      parameters: [{ id: 'p', name: 'q', required: true, value: '', options: [] }] },
    issues: { errors: [{ code: 'invalid_io_address', path: '$.io_table[0].address', message: 'bad' }] } } } } }
  const decision = await hooks['tools/post-execute']({ name: 'mcp__gxworks__propose_design_plan',
    agent: { session: {} } }, result, async () => ({ kind: 'accept' }))
  assert.equal(asked, 0)
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.value, undefined)
})

test('an unanswered required parameter keeps the same draft for the next window', async () => {
  const hooks = {}
  apply({ on: (name, callback) => { hooks[name] = callback },
    get: () => ({ ask: async ({ questions: [choice] }) => ({ answers: [{ id: choice.id, selected: [choice.options[0].label] }] }) }) })
  const result = { isError: false, value: { structuredContent: { ok: true, data: { draft_id: 'd4', user_requirement: 'x',
    review: { summary: 's', approaches: [{ name: 'a', approach_id: 'a1' }],
      parameters: [{ id: 'mode', name: '停机后怎样', required: true, value: '' }] },
    issues: { errors: [{ code: 'required_parameter_missing', path: '$.parameters[0].value', message: 'missing' }] } } } } }
  const decision = (await hooks['tools/post-execute']({ name: 'mcp__gxworks__propose_design_plan',
    agent: { session: {} } }, result, async () => ({ kind: 'accept' }))).value.structuredContent.data
  assert.equal(decision.approved, false)
  assert.match(decision.feedback, /停机后怎样/u)
  assert.deepEqual(decision.next_actions[0].arguments, {})
})

test('the confirmation window shows the instructions the draft would use', async () => {
  const { reviewDesign } = await import('../launch/design-review.mjs')
  let detail
  const ctx = { get: name => name === 'userQuestions' ? { ask: async ({ questions }) => {
    detail = questions[0].detail
    return { answers: [{ id: questions[0].id, selected: [questions[0].options[0].label] }] }
  } } : undefined }
  const body = { ok: true, data: { draft_id: 'd6', user_requirement: '用位移位历史记录来料。',
    review: { summary: '整字移位', approaches: [{ name: '整字移位循环', approach_id: 'word', description: '整字移位',
      generation_contract: { required_opcodes: ['WSFL', 'WSFR'], instruction_instances: [{ opcode: 'SFTL' }] } }] },
    issues: { errors: [] },
    dropped_claims: [{ field: 'explicit_constraint_claims', claim: { operation: 'forbid', summary: '同色连续时不复位' } }] } }
  const reviewed = await reviewDesign(ctx, { callId: 'c1', agent: { session: {} }, signal: undefined }, body)
  assert.equal(reviewed.data.approved, true)
  assert.match(detail, /指令：WSFL、WSFR、SFTL/u)
  assert.match(detail, /同色连续时不复位/u)
})

test('the design call can omit the requirement or pass a legacy value', async () => {
  const original = 'FX3U。D0 分类，1~3 蓝，4~6 绿，7~9 灰。相邻两件之间 D0 回零一次。'
  for (const args of [{}, { user_requirement: 'FX3U，D0 做颜色分类，蓝绿灰三路分拣。' }]) {
    assert.deepEqual(await dispatch('get_design_context', args, [message(original)]), { user_requirement: original })
  }
  assert.deepEqual(await dispatch('get_design_context', { user_requirement: '模型代写。' }, []), { user_requirement: '' })
})

test('the confirmation window stays short and speaks the user language', async () => {
  const details = []
  const ctx = { get: name => name === 'userQuestions' ? { ask: async ({ questions }) => {
    details.push(questions[0].detail)
    return { answers: questions.map((question, index) => index === 0
      ? { id: question.id, selected: [question.options[0].label] }
      : { id: question.id, custom: '保留在途物料' }) }
  } } : undefined }
  const approach = { approach_id: 'q', name: '整字移位追踪', description: '用整字移位链跟踪在途物料',
    generation_guide: '先建自锁，再按颜色生成占用与动作梯级，最后统一输出',
    implementation_semantics: [{ kind: 'structure', status: 'required', value: 'self_hold' },
      { kind: 'structure', status: 'required', value: 'edge_trigger' }],
    generation_contract: { required_opcodes: ['WSFL'], forbidden_opcodes: ['OUT'], instruction_instances: [] },
    pros: '状态清晰', cons: '需按节拍重算' }
  const draft = { draft_id: 'd7', user_requirement: '三色物料分拣，D0 分类，连续多件需要分别追踪到站并动作。',
    review: { summary: '整字移位追踪', approaches: [approach],
      io_table: [{ address: 'X1', label: '启动' }],
      io_bindings: [{ address: 'X1', label: '启动' }, { address: 'X3', label: '停止', active_level: 0 }],
      parameters: [{ id: 'stop_wip', name: '停机后在途物料怎样处理', required: true, value: '' }],
      behavior_constraints: [{ id: 'b1' }], user_notes: '' },
    issues: { errors: [] } }
  const reviewed = await reviewDesignShared(ctx, { callId: 'c1', agent: { session: {} } }, { ok: true, data: draft })
  assert.equal(reviewed.data.approved, true)
  const detail = details[0]
  assert.doesNotMatch(detail, /\{"|"[a-z_]+":/u, 'no wire JSON in the window')
  assert.match(detail, /指令：WSFL/u)
  assert.match(detail, /关键实现：✓自锁保持 ✓边沿触发/u)
  assert.match(detail, /待确认参数：停机后在途物料怎样处理/u)
  assert.match(detail, /I\/O X1 启动、X3 停止 \(有效电平=0\)/u)
  assert(detail.length < 1200, 'window stays short: ' + detail.length)

  const english = structuredClone(draft)
  english.user_requirement = 'Sort three colours; D0 carries the colour code; several parts travel at once.'
  await reviewDesignShared(ctx, { callId: 'c2', agent: { session: {} } }, { ok: true, data: english })
  assert.match(details[1], /Planned instructions：WSFL/u)
  assert.match(details[1], /How to build it/u)
  assert.doesNotMatch(details[1], /\{"|"[a-z_]+":/u)
  // The draft's own choices are never attributed to the user.
  assert.doesNotMatch(details[0], /用户指定|原文要求/u)
  assert.doesNotMatch(details[1], /User requirement|you asked/u)
})

test('a language without a label table gets a neutral symbol layout', async () => {
  const seen = []
  const ctx = { get: name => name === 'userQuestions' ? { ask: async ({ questions }) => {
    seen.push(questions[0])
    return { answers: questions.map((question, index) => index === 0
      ? { id: question.id, selected: [question.options[0].label] }
      : { id: question.id, custom: '保留' }) }
  } } : undefined }
  const approach = { approach_id: 'q', name: 'シフト追跡', description: '色ビットを左シフトして位置を追う',
    generation_guide: '自己保持を作ってから色ごとに梯級を生成する', pros: '状態が明確', cons: '周期の再計算が必要',
    generation_contract: { required_opcodes: ['WSFL'], forbidden_opcodes: ['M8011'] } }
  const draft = { draft_id: 'd8', user_requirement: '三色物料の自動分別。D0 の色コードで判定し、複数個を追跡して仕分ける。',
    review: { summary: '色コードで追跡して仕分ける', approaches: [approach],
      io_bindings: [{ address: 'X1', label: '起動' }],
      parameters: [{ id: 'stop', name: '停止後の扱い', required: true, value: '' }],
      behavior_constraints: [{ id: 'b1' }] },
    issues: { errors: [] } }
  await reviewDesignShared(ctx, { callId: 'c3', agent: { session: {} } }, { ok: true, data: draft })
  const question = seen[0]
  assert.equal(question.header, undefined, 'no localized header either')
  assert.match(question.detail, /⚙ WSFL/u)
  assert.match(question.detail, /⛔ M8011/u)
  assert.match(question.detail, /\? 停止後の扱い/u)
  assert.match(question.detail, /» 三色物料の自動分別/u)
  assert.doesNotMatch(question.detail, /拟定指令|Planned instructions|优势|Pros：|关键实现/u)
  assert.doesNotMatch(question.detail, /\{"|"[a-z_]+":/u)
  assert.equal(question.options[question.options.length - 1].label, '✎')
})

test('only explicit question-window answers enter the requirement', async () => {
  const askCall = { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q1',
    arguments: JSON.stringify({ questions: [{ id: 'stop_mode', question: '停机时清零还是保持 D0？', options: [
      { label: '清零复位', description: '清零 D0' }, { label: '保留', description: '保持 D0' },
    ] }, { id: 'delay', question: '启动延时多久？' }] }) } }
  const askReply = { type: 'tool/result', data: { message: { toolCallId: 'q1', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ answers: [
      { id: 'stop_mode', selected: ['清零复位', '无关内容'], custom: '同时关闭Y0' },
      { id: 'delay', selected: [], custom: '5 秒' },
    ] }) }] } } }
  const lateAnswer = { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: 'q1' },
    content: askReply.data.message.content } }
  for (const reply of [askReply, lateAnswer]) {
    const events = [message('X0 启动电机。'), askCall, reply, message('X1 急停。')]
    assert.deepEqual(await dispatch('get_design_context', { user_requirement: '模型猜测应保持 D0。' }, events), {
      user_requirement: 'X0 启动电机。\n清零复位：清零 D0\n同时关闭Y0\n问题：启动延时多久？\n用户答复：5 秒\nX1 急停。',
    })
  }
})

test('partial parameter answers re-prompt only remaining questions, and diacritic Latin uses neutral layout', async () => {
  const rounds = []
  const ctx = { get: name => name === 'userQuestions' ? { ask: async ({ questions }) => {
    rounds.push(questions.map(q => q.id))
    if (rounds.length === 1) {
      return { answers: [
        { id: questions[0].id, selected: [questions[0].options[0].label] },
        { id: 'gxworks-parameter-p1', custom: '5秒' },
      ] }
    }
    return { answers: [{ id: 'gxworks-parameter-p2', custom: '保持输出' }] }
  } } : undefined }
  const draft = {
    draft_id: 'd-part', user_requirement: "Contrôle d'arrêt d'urgence avec temporisation.",
    review: {
      summary: 'Temporisation',
      approaches: [{ approach_id: 'a1', name: 'Temporisateur', description: 'Marche/arrêt' }],
      parameters: [
        { id: 'p1', name: 'Durée', required: true, value: '' },
        { id: 'p2', name: 'Comportement arrêt', required: true, value: '' },
      ],
    },
    issues: { errors: [
      { code: 'required_parameter_missing', path: '$.parameters[0].value', message: 'missing p1' },
      { code: 'required_parameter_missing', path: '$.parameters[1].value', message: 'missing p2' },
    ] },
  }
  let firstHeader
  const origAsk = ctx.get('userQuestions').ask
  const wrappedCtx = { get: name => name === 'userQuestions' ? { ask: async req => {
    if (rounds.length === 0) firstHeader = req.questions[0].header
    return origAsk(req)
  } } : undefined }
  const reviewed = await reviewDesignShared(wrappedCtx, { callId: 'c-part', agent: { session: {} } }, { ok: true, data: draft })
  assert.equal(firstHeader, undefined, 'French with diacritics uses neutral layout instead of English')
  assert.deepEqual(rounds, [
    ['gxworks-design', 'gxworks-parameter-p1', 'gxworks-parameter-p2'],
    ['gxworks-parameter-p2'],
  ])
  assert.equal(reviewed.data.approved, true)
  assert.deepEqual(reviewed.data.next_actions[0].arguments, {
    draft_id: 'd-part', approach_id: 'a1', parameter_answers: { p1: '5秒', p2: '保持输出' },
  })
})



test('all language workflows use upstream tools and next actions without a private generator', async () => {
  const hooks = {}, registered = []
  apply({ on: (name, hook) => { hooks[name] = hook },
    get: name => name === 'tools' ? { register: tool => registered.push(tool) } : undefined })
  assert.deepEqual(registered, [])
  for (const target_mode of ['ladder', 'st', 'fbd', 'sfc']) {
    const value = { structuredContent: { ok: true, data: { project: { target_mode },
      next_actions: [{ tool: 'get_generation_context', arguments: { workflow: 'direct_generation' } }] } } }
    const decision = { kind: 'accept' }
    assert.equal(await hooks['tools/post-execute']({ name: 'mcp__gxworks__create_project', agent: {} },
      { value }, async () => decision), decision)
    const args = { generation_mode: 'direct', target_mode }
    assert.equal(evaluate('create_project', args, [message('完整的操作顺序。')]), 'allowed')
  }
})


test('complete upstream reads and errors pass through unchanged', async () => {
  const hooks = {}
  apply({ on: (name, hook) => { hooks[name] = hook } })
  for (const tool of ['get_generation_context', 'get_design_context', 'search_plc_manual', 'get_fbd_catalog', 'gxworks_read_context_unit']) {
    for (const isError of [false, true]) {
      const body = isError ? { ok: false, error: { code: 'HOST_CONTEXT_TOO_LARGE' } } : {
        ok: true, data: { document: { output_contract: { protocol: 'compact_ladder/1.4' },
          input_conditions: [{ condition_ref: 'stop', when: 'run_permit' }],
          operation_bindings: [{ form_ref: 'move', parameters: ['source', 'destination'] }],
          output_schema: { anyOf: [{ required: ['timer', 'duration_ms', 'tick_ms'] }] } },
        delivery: { complete: true } },
      }
      const result = { isError, value: { content: [{ type: 'text', text: JSON.stringify(body) }] } }
      const before = structuredClone(result), decision = { kind: 'accept' }
      assert.equal(await hooks['tools/post-execute']({ name: 'mcp__gxworks__' + tool, arguments: {}, agent: {} },
        result, async () => decision), decision)
      assert.deepEqual(result, before)
    }
  }
})


test('the confirmation window retains upstream output behavior and does not infer contact type from signal level', async () => {
  let detail
  const ctx = { get: () => ({ ask: async ({ questions }) => {
    detail = questions[0].detail
    return { answers: [] }
  } }) }
  await reviewDesignShared(ctx, { agent: { session: {} } }, { ok: true, data: {
    draft_id: 'd', user_requirement: '启动与停止', issues: { errors: [] }, review: {
      summary: '按输入控制输出', io_bindings: [{ address: 'X1', label: '停止', active_level: 0 }],
      approaches: [{ approach_id: 'a', name: '方案', output_logic: [{ target: 'Y0', state: '运行状态',
        activation: '启动成立且停止未生效', update: '每扫描更新', release: '停止生效', interruption: '停止优先', selection: '普通输出赋值' }],
        decision_basis: [{ variant: '方案', premise: '接线尚待确认', status: 'unknown', conclusion: 'conditional',
          applicability_conditions: [{ premise: '现场条件未确定', status: 'unknown' }] }] }],
    },
  } })
  for (const text of ['运行状态', '停止优先', '普通输出赋值', '接线尚待确认', 'conditional', '现场条件未确定', '有效电平=0']) assert(detail.includes(text), text)
  assert(!detail.includes('(NC)'))
})
