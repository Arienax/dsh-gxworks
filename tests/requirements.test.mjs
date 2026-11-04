import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.mjs'

function evaluate(tool, args, messages) {
  let hook
  apply({ on: (name, callback) => { assert.equal(name, 'tools/pre-execute'); hook = callback } })
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
