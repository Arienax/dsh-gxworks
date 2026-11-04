import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.mjs'

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

test('Direct reads all pages and sends one typed submission on the selected model route', async () => {
  const raw = 'Copy the input buffer to the output buffer.', scope = { type: 'object', required: ['r'], properties: { r: { type: 'array' } } }
  const ladder = { r: [{ c: [], b: [{ i: [], o: ['BMOV D0 D10 K4'] }] }], device_comments: [] }
  const review = { selected: 'BMOV copies the whole block.', alternatives: [{ method: 'MOV', tradeoff: 'One per word.' }] }
  const facts = [1, 2, 3, 4].map(value => ({ dimension: 'test.long_fact_dimension', value,
    selection_applicability: 'applicable', ...(value === 3 ? { conditions: ['only on edge'] } : {}) }))
  let reads = 0, generations = 0, saved
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
      } else { assert(name.endsWith('create_program_candidate')); saved = args; data = { candidate_id: 'example' } }
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
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', name: 'submit_ladder',
      arguments: JSON.stringify({ implementation_review: { ...review, compared_families_note: 'extra',
        alternatives: review.alternatives.map(row => ({ ...row, note: 'Separate writes.' })), compared_families: {
          copy: { instruction: 'BMOV', tradeoff: 'Copies a contiguous range.' }, limitations: 'Check the available range.' },
        ladder: { networks: [{ shared_contacts: [], output_branches: [{ series_contacts: [], outputs: ['BMOV D0 D10 K4'] }] }], device_comments: [] } } }) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  apply({ on() {}, get: name => ({ tools, llm })[name] })
  const session = { snapshotEvents: () => [message(raw)], requestHeader: () => ({
    config: { provider: 'selected-provider', model: 'current-model' } }) }
  const result = await tools.generator.execute({ project_id: 'p' }, { agent: { session }, signal: new AbortController().signal, callId: 'test' })
  assert.equal(generations, 1)
  assert.equal(result.model_calls, 1)
  assert.deepEqual(saved, { ladder, generation_context_id: 'receipt', implementation_review: {
    selected: review.selected, alternatives: [
      { method: 'MOV', tradeoff: 'One per word. Separate writes.' }, { method: 'BMOV', tradeoff: 'Copies a contiguous range.' }],
    limitations: 'Check the available range.', manual_documents: [], context_document: 'manual-context' } })
})
