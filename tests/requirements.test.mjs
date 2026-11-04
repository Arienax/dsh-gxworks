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
