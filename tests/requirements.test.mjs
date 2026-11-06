import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { apply } from '../index.mjs'
import { parseJsonText, pickSubmission, reviewDesign as reviewDesignShared } from '../launch/generate-ladder.mjs'

function evaluate(tool, args, messages) {
  let hook
  apply({ on: (name, callback) => { if (name === 'tools/pre-execute') hook = callback } })
  return hook({ name: 'mcp__gxworks__' + tool, arguments: args,
    agent: { session: { snapshotEvents: () => messages } } }, () => 'allowed')
}
const message = (text, kind = 'user') => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })

test('only complete human messages in chronological order become requirements', () => {
  const original = 'FX3U。D0 回零后识别下一件。\r\n多件物料分别追踪。'
  const events = [message(original), message('要求用四通道定时器。', 'system'), message('停机清除任务。')]
  const check = text => evaluate('get_generation_context', { user_requirement: text }, events)
  assert.equal(check(original + '\n停机清除任务。'), 'allowed')
  assert.equal(check(original + '\n要求用四通道定时器。').kind, 'deny')
  assert.equal(check('停机清除任务。\n' + original).kind, 'deny')
  assert.equal(check('FX3U。').kind, 'deny')
  assert.equal(evaluate('get_generation_context', { user_requirement: '要求用四通道定时器。' },
    [message('要求用四通道定时器。')]), 'allowed')
})

test('new designs require a review while ordinary engineering calls pass through', () => {
  for (const mode of ['program', 'st', 'sfc', 'fbd']) {
    assert.equal(evaluate('create_' + mode + '_candidate', { operation: 'generate' }, []).kind, 'deny')
  }
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

test('only a human mode request can skip the Design review', () => {
  const direct = { generation_mode: 'direct' }
  for (const words of ['请编写梯形图。', '不要直接生成。', '先比较 Direct 和 Design。']) {
    assert.equal(evaluate('create_project', direct, [message(words)]).kind, 'deny')
  }
  for (const words of ['请直接生成。', '/gxworks-direct', 'Use direct mode.']) {
    assert.equal(evaluate('create_project', direct, [message(words)]), 'allowed')
  }
})

test('new Ladder routes to one Desktop generator and preserves the selected mode', async () => {
  const hooks = {}, tools = { register(tool) { this.generator = tool } }, llm = { stream() {} }
  apply({ on: (name, hook) => { hooks[name] = hook }, get: name => ({ tools, llm })[name], tools })
  assert.equal(tools.generator.name, 'gxworks_generate_ladder')
  for (const [tool, stage] of [['get_design_context', { stage: 'design' }], ['get_generation_context', {}]]) {
    const value = { structuredContent: { ok: true, data: { selected_project_id: 'p',
      project: { target_mode: 'ladder' }, next_actions: [{ tool }] } } }
    const decision = await hooks['tools/post-execute']({ name: 'mcp__gxworks__create_project', agent: {} },
      { value }, async () => ({ kind: 'accept' }))
    assert.deepEqual(decision.value.structuredContent.data.next_actions, [
      { tool: tools.generator.name, arguments: { project_id: 'p', ...stage } }])
  }
})

for (const degraded of [false, true]) for (const notes of ['complete', 'misnested', 'absent'])
test(`Direct preserves the program and reads all pages; degraded=${degraded}; notes=${notes}`, async () => {
  const raw = 'Copy the input buffer to the output buffer.', scope = { type: 'object', required: ['r'], properties: { r: { type: 'array' } } }
  const ladder = { r: [{ c: [], b: [{ i: [], o: ['BMOV D0 D10 K4'] }] }], device_comments: [] }
  const review = { selected: 'BMOV copies the whole block.', alternatives: [{ method: 'MOV', tradeoff: 'One per word.' }] }
  const facts = [1, 2, 3, 4].map(value => ({ dimension: 'test.long_fact_dimension', value,
    selection_applicability: 'applicable', ...(value === 3 ? { conditions: ['only on edge'] } : {}) }))
  let reads = 0, generations = 0, saved
  const fragmentReview = { status: 'not_established', blocking: false,
    findings: [{ network_index: 2, reason: 'external_write_activation_not_established' }] }
  const notices = []
  const doc = { project_id: 'p', generation_context_id: 'receipt', generation_instructions: 'Web Direct',
    workflow_mode: 'direct_generation', output_contract: { protocol: 'compact_ladder/1.3', tool: 'create_program_candidate' },
    generation_input: { request: raw, output_schema: scope }, instruction_research: { families: { copy: ['BMOV'] }, manual: { coverage: { status: 'incomplete' }, knowledge: [{ facts }] } } }
  const tools = {
    register(d) { this.generator = d },
    get() { return { parameters: { properties: { implementation_review: { properties: {
      selected: { type: 'string' }, alternatives: { type: 'array' }, limitations: { type: 'string' } } } } } } },
    async execute({ name, arguments: args }) {
      let data
      if (name.endsWith('get_current_project')) data = { project_id: 'p', target_mode: 'ladder', version_count: 0 }
      else if (name.endsWith('get_generation_context')) {
        const page = reads++
        if (page === 0) assert.deepEqual(args, { workflow: 'direct_generation', user_requirement: raw, instruction_details: true })
        else assert.deepEqual(args, { cursor: 'next' })
        data = { document: { $ref: '#/objects/doc' }, objects: page === 1 ? { doc } : {}, delivery: {
          page, document_id: 'manual-context', complete: page === 1, next: page === 1 ? null : {
            tool: 'get_generation_context', arguments: { cursor: 'next' } } } }
      } else {
        assert(name.endsWith('create_program_candidate')); saved = args
        assert.deepEqual(JSON.parse(JSON.stringify(args)), args, 'Desktop arguments must contain no undefined values')
          data = { candidate_id: 'example', version_id: 'v0001', fragment_review: fragmentReview,
          implementation_review: { assumptions: [{ condition: 'Model implementation note' }] }, delivery: { preferred_format: 'gxw',
          actual_format: degraded ? 'csv' : 'gxw', degraded, reason: degraded ? 'project readback mismatch' : null } }
      }
      return { isError: false, value: { structuredContent: { ok: true, data } } }
    },
  }
  const llm = { async *stream(options) {
    generations++
    assert.equal(reads, 2)
    assert.equal(options.model, 'current-model')
    assert.equal(options.provider, 'selected-provider')
    const parameters = options.tools[0].parameters.properties
    assert.deepEqual(parameters.ladder.required, ['networks'])
    assert.deepEqual(parameters.implementation_review.properties.compared_families.properties.copy.properties.instruction.enum, ['BMOV'])
    assert(parameters.implementation_review.required.includes('limitations'))
    const packet = JSON.parse(options.messages[0].content[0].text)
    const table = packet.instruction_research.manual.knowledge[0].facts
    assert.deepEqual(table.rows.map((row, i) => ({ ...table.common,
      ...Object.fromEntries(table.columns.map((key, n) => [key, row[n]])), ...table.extra_fields_by_row?.[i] })), facts)
    assert.equal(packet.request, raw)
    assert.equal(JSON.parse(options.messages[0].content[0].text).output_schema, undefined)
    const value = { implementation_review: { ...review, compared_families_note: 'extra',
        alternatives: review.alternatives.map(row => ({ ...row, note: 'Separate writes.' })), compared_families: {
          copy: { instruction: 'BMOV', tradeoff: 'Copies a contiguous range.' }, limitations: 'Check the available range.' },
        ladder: { networks: [{ shared_contacts: [], output_branches: [{ series_contacts: [], outputs: ['BMOV D0 D10 K4'] }] }], device_comments: [] } } }
    if (notes !== 'complete') {
      value.ladder = value.implementation_review.ladder
      if (notes === 'misnested') value.implementation_review = { grouped_option: {
        instruction: 'BMOV', comparison: 'Copies a contiguous range.', selected: 'Nested model note', assumptions: [] } }
      else delete value.implementation_review
    }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', name: 'submit_ladder', arguments: JSON.stringify(value) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  apply({ on() {}, get: name => ({ tools, llm })[name] })
  const session = { snapshotEvents: () => [message(raw)], append: (type, data, options) => {
    notices.push({ type, data, options })
    assert.fail('the generator must not append session events')
  }, requestHeader: () => ({
    config: { provider: 'selected-provider', model: 'current-model' } }) }
  const result = await tools.generator.execute({ project_id: 'p' }, { agent: { session }, signal: new AbortController().signal, callId: 'test' })
  assert.equal(generations, 1)
  assert.equal(result.model_calls, 1)
  assert.deepEqual(result.candidate.fragment_review, fragmentReview, 'uncertain analysis stays advisory without a repair request')
  assert.deepEqual(result.implementation_review.assumptions, [{ condition: 'Model implementation note' }], 'retain model notes without source labels')
  assert.deepEqual(notices, [], 'generation must leave the session log untouched')
  assert.equal(result.status, degraded ? 'delivery_degraded' : undefined)
  if (degraded) assert.deepEqual(result.delivery, result.candidate.delivery)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'Desktop result must contain no undefined values')
  if (notes === 'complete') assert.deepEqual(saved, { ladder, generation_context_id: 'receipt', implementation_review: {
    selected: review.selected, alternatives: [
      { method: 'MOV', tradeoff: 'One per word. Separate writes.' }, { method: 'BMOV', tradeoff: 'Copies a contiguous range.' }],
    limitations: 'Check the available range.', manual_documents: [], context_document: 'manual-context' } })
  else assert.deepEqual(saved, { ladder, generation_context_id: 'receipt', implementation_review: {
    alternatives: notes === 'misnested' ? [{ method: 'BMOV', tradeoff: 'Copies a contiguous range.' }] : [],
    manual_documents: [], context_document: 'manual-context' } })
})

for (const fixed of [true, false]) test('An independent counterexample gets one scoped repair; resolved=' + fixed, async () => {
  const raw = 'A request should light only its assigned lamp.', calls = [], submissions = [], notices = []
  const first = { c: [], b: [{ i: [], o: ['COIL Y0'] }] }
  const next = { c: ['NO X0'], b: [{ i: [], o: ['COIL Y1'] }] }
  const inputSequence = [{ at_ms: 0, set: { X0: 0 } }]
  const caseInputs = [...inputSequence, { at_ms: 15, set: { X0: 1 } }]
  const original = Array(fixed ? 18 : 2).fill(first)
  const scope = fixed ? original.map((_, index) => index) : [1]
  const ioResult = { status: 'mismatch', case_id: 'lamp', address: 'Y1', at_ms: 5, scan_ms: 5, expected: 0, actual: true,
    input_sequence: inputSequence, network_indexes: scope }
  if (fixed) Object.assign(ioResult, { case_input_sequence: caseInputs, counterexamples: [
    { at_ms: 5, address: 'Y1', expected: 0, actual: true, network_indexes: [1] },
    { at_ms: 20, address: 'Y2', expected: 1, actual: false, network_indexes: scope.slice(2) },
  ] })
  const props = { implementation_review: { properties: { selected: {}, alternatives: {}, limitations: {}, reviewed_instructions: {}, assumptions: { type: 'array' } } }, io_example: {} }
  let reads = 0
  const tools = { register(d) { this.generator = d }, get() { return { parameters: { properties: props } } },
    async execute({ name, arguments: args }) {
      let data
      if (name.endsWith('get_current_project')) data = { project_id: 'p', target_mode: 'ladder', version_count: 0 }
      else if (name.endsWith('get_generation_context')) {
        reads++
        data = { delivery: { document_id: 'doc', page: 0, complete: true }, document: { project_id: 'p', plc_model: 'FX3U',
          generation_context_id: 'same', generation_input: { request: raw, output_schema: { properties: { r: { items: { type: 'object' } } } } },
          output_contract: { protocol: 'compact_ladder/1.3', tool: 'create_program_candidate' },
          instruction_research: { families: { copy: ['BMOV'] }, ...(fixed ? { group_operations: ['BMOV'], executable_fragments: [{ id: 'range-bmov', syntax: 'FRAG range-bmov <S> <D> <N>' }] } : {}),
            manual: { knowledge: ['original manual content'] } } } }
      } else {
        assert(name.endsWith('create_program_candidate')); submissions.push(structuredClone(args))
        if (submissions.length === 1 || !fixed) {
          const failure = { ok: false, error: { code: 'CANDIDATE_BEHAVIOR_MISMATCH', behavior_result: ioResult } }
          return fixed ? { isError: true, error: { message: JSON.stringify(failure) } } : { value: { structuredContent: failure } }
        }
        data = { behavior_result: { status: 'passed_in_cases' } }
      }
      return { value: { structuredContent: { ok: true, data } } }
    } }
  const llm = { async *stream(options) {
    const tool = options.tools[0], input = JSON.parse(options.messages[0].content[0].text)
    calls.push(tool.name)
    let value
    if (tool.name === 'submit_ladder') {
      assert.deepEqual(tool.parameters.properties.implementation_review.properties.compared_families.properties.copy, { type: 'string', enum: ['BMOV'] })
      const fields = tool.parameters.properties.implementation_review
      assert.equal(fields.required.includes('grouped_option'), fixed)
      assert.equal(fields.required.includes('assumptions'), fixed)
      assert.equal(tool.parameters.properties.io_example, undefined)
      assert.equal(input.executable_fragments?.[0].id, fixed ? 'range-bmov' : undefined)
      value = { implementation_review: { selected: 'Two outputs',
        ...(fixed ? { grouped_option: { instruction: 'BMOV', comparison: 'One contiguous transfer.' }, assumptions: [] } : { alternatives: [] }),
        compared_families: { copy: 'BMOV' } },
        ladder: { r: original } }
    } else {
      assert.deepEqual(input.networks, scope.map(index => ({ index, network: first })))
      assert.equal(input.instruction_research, undefined)
      assert.deepEqual(input.counterexample.inputs, fixed ? caseInputs : inputSequence)
      assert.deepEqual(input.counterexamples, ioResult.counterexamples)
      assert.equal(input.counterexample.scan_ms, 5)
      assert.equal(input.case_id, 'lamp')
      value = { edits: [{ index: 1, networks: [next] }] }
    }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', name: tool.name, arguments: JSON.stringify(value) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  apply({ on() {}, get: name => ({ tools, llm })[name] })
  const session = { snapshotEvents: () => [message(raw)], append: type => notices.push(type),
    requestHeader: () => ({ config: { model: 'test', provider: 'test' } }) }
  const result = await tools.generator.execute({ project_id: 'p' }, { agent: { session }, signal: new AbortController().signal })
  assert.equal(reads, 1)
  assert.deepEqual(calls, ['submit_ladder', 'repair_networks'])
  assert.deepEqual(notices, [])
  assert.equal(submissions.length, 2)
  assert.deepEqual(submissions[1], { ...submissions[0], ladder: { r: original.map((row, index) => index === 1 ? next : row) } })
  assert.deepEqual(submissions[0].implementation_review.reviewed_instructions, ['BMOV'])
  if (fixed) assert.deepEqual(submissions[0].implementation_review.alternatives,
    [{ method: 'BMOV', tradeoff: 'One contiguous transfer.' }])
  assert.equal(fixed ? result.candidate.behavior_result.status : result.status, fixed ? 'passed_in_cases' : 'behavior_mismatch')
})

test('verification notice renders in the chat without becoming a model message', () => {
  let plugin, definition, renderer, dictionaries
  runInNewContext(readFileSync(new URL('../client.mjs', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) {
      assert.equal(module.id, 'dsh-gxworks')
      plugin = module.factory(name => {
        assert.equal(name, 'react')
        return { createElement: (tag, props, text) => ({ tag, props, text }) }
      })
    } } },
  })
  plugin.apply({
    effect: callback => callback(),
    locale: { register: (_namespace, values) => { dictionaries = values } },
    uiConversation: { events: { register: value => { definition = value } } },
    slots: { inject: (_name, callback) => callback(), register: (_options, component) => { renderer = component } },
  })
  assert.equal(definition.match({ type: 'assistant/message' }), null)
  const event = { type: 'dsh-gxworks/verification-started', seq: 7, data: {}, ignorable: true }
  const match = definition.match(event)
  const node = definition.buildViewNode({ key: 'notice:7', id: match.id,
    start: { event, location: { kind: 'session' } } })
  assert.equal(node.visibility, 'visible')
  assert.equal(node.anchorSeq, 7)
  assert.equal(node.target, 'chat')
  for (const language of ['zh', 'en']) {
    const rendered = renderer({ t: key => dictionaries[language][key] })
    assert.equal(rendered.props.role, 'status')
    assert.equal(rendered.text, dictionaries[language].started)
  }
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

test('a stray quote inside prose does not discard the submitted draft', () => {
  const broken = '{"summary":"用 D0 计数","approaches":[{"name":"整字移位循环","description":"按 D0 回 0 后 "重置" 历史","approach_id":"word"}]}'
  const parsed = parseJsonText(broken)
  assert.equal(parsed.value.approaches[0].description, '按 D0 回 0 后 "重置" 历史')
  assert.equal(parseJsonText('{"a":1,}').value.a, 1)
  assert.equal(parseJsonText('not json at all').error !== undefined, true)
})

test('only the named submission counts; provider noise is ignored', () => {
  const calls = [{ name: 'read_file', arguments: '{}' }, { name: 'submit_design_plan', arguments: '{"a":1}' }]
  assert.equal(pickSubmission(calls, 'submit_design_plan').call.arguments, '{"a":1}')
  assert.match(pickSubmission(calls, 'submit_ladder').error, /submit_ladder/u)
  assert.match(pickSubmission([{ name: 'submit_ladder', arguments: '{}' }, { name: 'submit_ladder', arguments: '{}' }],
    'submit_ladder').error, /2/u)
})

test('the whole Design → answers → confirmation → generation loop runs without the outer model', async () => {
  const hooks = {}, asked = [], calls = []
  const review = { selected: 'BMOV 整组搬运', alternatives: [],
    compared_families: { copy: 'BMOV' }, reviewed_instructions: [] }
  const draft = { draft_id: 'd5', user_requirement: 'D0 计数，件间回 0，停机后保留在途物料。',
    review: { summary: '整字移位历史', approaches: [{ name: '整字移位循环', approach_id: 'word', description: '整字移位' }],
      parameters: [{ id: 'stop_wip', name: '停机后在途物料怎样处理', required: true, value: '', options: ['保留在途物料', '清除'] }] },
    issues: { errors: [{ code: 'required_parameter_missing', path: '$.parameters[0].value', message: '必填参数尚未填写' }] } }
  const doc = { project_id: 'p', plc_model: 'FX3U', workflow_mode: 'detailed', generation_context_id: 'receipt',
    generation_instructions: 'Web 协议', output_contract: { protocol: 'compact_ladder/1.3', tool: 'create_program_candidate' },
    generation_input: { request: draft.user_requirement, output_schema: { type: 'object', required: ['r'],
      properties: { r: { type: 'array', items: { type: 'object' } } } } },
    instruction_research: { families: { copy: ['BMOV'] }, manual: { coverage: { status: 'complete' }, knowledge: [] } } }
  const props = { implementation_review: { properties: { selected: {}, alternatives: {}, limitations: {},
    reviewed_instructions: {}, assumptions: { type: 'array' } } }, io_example: {} }
  const tools = {
    register(definition) { this.generator = definition },
    get() { return { parameters: { properties: props } } },
    async execute({ name, arguments: args }) {
      calls.push(name.slice('mcp__gxworks__'.length))
      let data
      if (name.endsWith('get_current_project')) data = { project_id: 'p', target_mode: 'ladder', version_count: 0 }
      else if (name.endsWith('get_design_context')) data = { analysis_id: 'a1', analysis_instructions: '设计协议',
        analysis_schema: { type: 'object', required: ['summary', 'approaches'],
          properties: { summary: { type: 'string' }, approaches: { type: 'array', items: { type: 'object' } } } },
        knowledge: {}, instruction_research: null,
        delivery: { page: 0, document_id: 'design-doc', complete: true },
        document: { analysis_id: 'a1', knowledge: {}, instruction_research: null,
          analysis_schema: { type: 'object', required: ['summary', 'approaches'],
            properties: { summary: { type: 'string' }, approaches: { type: 'array', items: { type: 'object' } } } } } }
      else if (name.endsWith('propose_design_plan')) {
        assert.equal(args.analysis.approaches[0].name, '整字移位循环')
        assert.equal(hooks['tools/post-execute'] !== undefined, true, 'the hook stays registered for top-level calls')
        data = structuredClone(draft)
      } else if (name.endsWith('confirm_design_plan')) {
        assert.deepEqual(args.parameter_answers, { stop_wip: '保留在途物料' })
        data = { confirmed: true, project_id: 'p', target_mode: 'ladder', approach_id: 'word' }
      } else if (name.endsWith('get_generation_context')) {
        data = { delivery: { page: 0, document_id: 'gen-doc', complete: true }, document: doc }
      } else {
        assert(name.endsWith('create_program_candidate'))
        data = { candidate_id: 'c1', version_id: 'v0001',
          delivery: { preferred_format: 'gxw', actual_format: 'gxw', degraded: false } }
      }
      return { isError: false, value: { structuredContent: { ok: true, data } } }
    },
  }
  const llm = { async *stream(options) {
    const tool = options.tools[0]
    let text
    if (tool.name === 'submit_design_plan') {
      // A real model once emitted a bare quote inside prose here.
      text = '{"summary":"用 D0 计数","approaches":[{"approach_id":"word","name":"整字移位循环",'
        + '"description":"按 D0 回 0 后 "重置" 历史","implementation_semantics":[]}],'
        + '"missing_info":[{"id":"stop_wip","question":"停机后在途物料怎样处理","required":true,"options":["保留在途物料","清除"]}]}'
    } else {
      text = JSON.stringify({ implementation_review: { ...review, compared_families: { copy: 'BMOV' } },
        ladder: { networks: [{ shared_contacts: [], output_branches: [{ series_contacts: [], outputs: ['BMOV D0 D10 K4'] }] }] } })
    }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', name: tool.name, arguments: text } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  const file = new URL('./requirements.test.mjs', import.meta.url)
  const answers = { ask: async ({ questions }) => {
    asked.push(questions.map(question => question.id))
    const [choice, parameter] = questions
    return { answers: [{ id: choice.id, selected: [choice.options[0].label] },
      { id: parameter.id, selected: ['保留在途物料'] }] }
  } }
  apply({ on: (name, callback) => { hooks[name] = callback },
    get: name => ({ tools, llm, userQuestions: answers })[name] })
  const session = { snapshotEvents: () => [message(draft.user_requirement)],
    requestHeader: () => ({ config: { model: 'test', provider: 'test' } }) }
  const result = await tools.generator.execute({ project_id: 'p', stage: 'design' },
    { agent: { session }, signal: new AbortController().signal, callId: 'outer' })
  assert.deepEqual(asked, [['gxworks-design', 'gxworks-parameter-stop_wip']])
  assert.deepEqual(calls, ['get_current_project', 'get_design_context', 'propose_design_plan',
    'confirm_design_plan', 'get_generation_context', 'create_program_candidate'])
  assert.equal(result.candidate.version_id, 'v0001')
  assert.equal(result.model_calls, 2)
  void file
})

test('the confirmation window shows the instructions the draft would use', async () => {
  const { reviewDesign } = await import('../launch/generate-ladder.mjs')
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
