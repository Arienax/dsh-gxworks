// SPDX-License-Identifier: AGPL-3.0

import { designApprovals, reviewDesign, revisedRequirements } from './launch/design-review.mjs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledArchiveParts } from './launch/bundled-runtime.mjs'

/** 插件名，与包名一致：patch 覆盖时按它定位。 */
export const name = 'dsh-gxworks'
export const inject = ['tools', 'mcpManager']

const packageRoot = dirname(fileURLToPath(import.meta.url))
const required = ['launch/mcp-launch.mjs', 'launch/bundled-runtime.mjs',
  'runtime/backend.json', 'skills']

/** Read explicit selections and custom answers from the host's question events. */
function questionAnswers(events) {
  const asked = new Map()
  const answersByEvent = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'ask_user_question' && event.data.callId) {
      try {
        const parsed = typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments
        if (Array.isArray(parsed?.questions)) asked.set(event.data.callId, parsed.questions)
      } catch { /* ignore malformed arguments */ }
      continue
    }
    const result = event.type === 'tool/result' ? event.data?.message : undefined
    const reply = event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply'
    if (result?.isError || (result && event.data.error)) continue
    const callId = reply ? event.data.source.callId : result?.toolCallId
    const questions = asked.get(callId)
    if (!questions) continue
    const content = reply ? event.data.content : result.content
    const text = content?.find(block => block.type === 'text')?.text
    let payload
    try { payload = JSON.parse(text) } catch { continue }
    if (!Array.isArray(payload?.answers)) continue
    asked.delete(callId)
    const answers = []
    for (const answer of payload.answers) {
      const question = questions.find(q => q && q.id === answer?.id)
      if (!question) continue
      const selected = Array.isArray(answer.selected) ? answer.selected : []
      const options = Array.isArray(question.options) ? question.options : []
      for (const option of options) {
        if (typeof option?.label !== 'string' || !selected.includes(option.label)) continue
        answers.push({ text: option.label, detail: option.description })
      }
      if (typeof answer.custom === 'string' && answer.custom.trim()) {
        answers.push({ text: answer.custom, prompt: options.length ? undefined : question.question })
      }
    }
    answersByEvent.set(event, answers)
  }
  return answersByEvent
}

function humanText(event) {
  if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') return ''
  return event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function sessionRequirement(session) {
  const events = session?.snapshotEvents?.() || []
  const answers = questionAnswers(events)
  const parts = []
  for (const event of events) {
    const original = humanText(event)
    if (original.trim()) parts.push(original)
    for (const { text, detail, prompt } of answers.get(event) || []) {
      if (detail) parts.push(`${text}：${detail}`)
      else if (prompt) parts.push(`问题：${prompt}\n用户答复：${text}`)
      else parts.push(text)
    }
  }
  parts.push(...(revisedRequirements.get(session) || []))
  return parts.join('\n')
}

export function apply(ctx) {
  const logger = ctx?.logger?.('dsh-gxworks')
  const missing = required.filter(relative => !existsSync(join(packageRoot, relative)))
  missing.push(...bundledArchiveParts.filter(path => !existsSync(path)))
  if (missing.length > 0) {
    logger?.warn?.(`dsh-gxworks: 安装包缺少 ${missing.join('、')}，MCP 工具与技能不可用；请重新安装本包`)
    return
  }
  // The rc.3 manager owns connection status, reconnects and plugin disposal.
  ctx.mcpManager.register('gxworks', {
    transport: 'stdio', command: process.execPath,
    args: [join(packageRoot, 'launch', 'mcp-launch.mjs'), '--read-budget-tokens', '128000'],
    // DSH scrubs its own variables from subprocesses unless explicitly passed.
    env: process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {},
    startupTimeoutMs: 600000, toolCallTimeoutMs: 600000, closeTimeoutMs: 10000,
    reconnect: { enabled: true, maxAttempts: 3 },
  })
  ctx.on('tools/execute', async (exec, next) => {
    const session = exec.agent?.session
    const args = exec.arguments
    if (!session || !args || args.cursor) return next()
    const design = exec.name === 'mcp__gxworks__get_design_context'
    const generation = exec.name === 'mcp__gxworks__get_generation_context'
      && args.workflow !== 'detailed' && (args.workflow === 'direct_generation' || Object.hasOwn(args, 'user_requirement'))
    if (design || generation) {
      const requirement = sessionRequirement(session)
      // The host freezes the parsed arguments before dispatch; replace the whole object.
      exec.arguments = Object.freeze({ ...args, user_requirement: requirement })
    }
    return next()
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (result.isError || !exec.agent || !exec.name.startsWith('mcp__gxworks__')) return next()
    if (exec.name !== 'mcp__gxworks__propose_design_plan') return next()
    const decision = await next()
    if (decision.kind !== 'accept' || decision.value !== undefined || decision.content !== undefined) return decision
    const reviewed = await reviewDesign(ctx, exec, result.value?.structuredContent)
    if (!reviewed) return decision
    if (reviewed.block) return { kind: 'block', feedback: [{ type: 'text', text: reviewed.block }] }
    const reviewedBody = { ...result.value.structuredContent, data: reviewed.data }
    return { ...decision, value: { ...result.value, structuredContent: reviewedBody,
      content: [{ type: 'text', text: JSON.stringify(reviewedBody) }] } }
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!exec.name.startsWith('mcp__gxworks__')) return next()
    const tool = exec.name.slice('mcp__gxworks__'.length)
    const args = exec.arguments
    if (tool === 'confirm_design_plan' && exec.agent) {
      const approved = designApprovals.get(exec.agent?.session)
      if (!approved || approved.draft_id !== args.draft_id || approved.approach_id !== args.approach_id) {
        return { kind: 'deny', reason: '请先用 propose_design_plan({}) 展示草稿，并使用用户在确认窗口中选择的方案。' }
      }
    }
    return next()
  })
  logger?.debug?.('dsh-gxworks: 内置后端、launcher 与 skills 就位')
}
