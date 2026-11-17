// SPDX-License-Identifier: AGPL-3.0-only

import { designApprovals, explicitDirect, generatorName, humanText, isNestedGeneratorCall,
  registerLadderGenerator, reviewDesign, revisedRequirements } from './launch/generate-ladder.mjs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名，与包名一致：patch 覆盖时按它定位。 */
export const name = 'dsh-gxworks'
export const inject = ['tools', 'llm']

const packageRoot = dirname(fileURLToPath(import.meta.url))
const required = ['launch/mcp-launch.mjs', 'launch/bundled-runtime.mjs',
  'runtime/backend.json', 'runtime/GXWorks-Agent-MCP-windows-x64.zip', 'skills']

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

function questionChoices(session) {
  return [...questionAnswers(session?.snapshotEvents?.() || []).values()].flat().map(answer => answer.text)
}

// A label needs no sentence punctuation: "方案A：…（推荐，直接生成）" is a choice.
function chosenDirect(text = '') {
  return /(?:直接|立即|马上)(?:帮我)?生成|跳过(?:方案|设计)?(?:对比|比较)?确认|direct\s*(?:mode|generation)|快捷生成/iu.test(text)
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
  if (missing.length > 0) {
    logger?.warn?.(`dsh-gxworks: 安装包缺少 ${missing.join('、')}，MCP 工具与技能不可用；请重新安装本包`)
    return
  }
  const supportsGenerator = Boolean(ctx.get?.('llm')?.stream && ctx.get?.('tools')?.register)
  if (supportsGenerator) registerLadderGenerator(ctx, sessionRequirement)
  ctx.on('tools/execute', async (exec, next) => {
    const session = exec.agent?.session
    const args = exec.arguments
    if (!session || !args || args.cursor || isNestedGeneratorCall(exec)) return next()
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
    // Nested calls made inside gxworks_generate_ladder (including through batch
    // executors that omit exec.parent) must never re-enter outer review or routing.
    if (result.isError || !exec.agent || isNestedGeneratorCall(exec)) return next()
    if (supportsGenerator && ['mcp__gxworks__create_project', 'mcp__gxworks__confirm_design_plan'].includes(exec.name)) {
      const decision = await next()
      const body = result.value?.structuredContent
      const data = body?.data
      if (decision.kind !== 'accept' || decision.value !== undefined || decision.content !== undefined ||
          (data?.project?.target_mode || data?.target_mode) !== 'ladder' ||
          !['get_generation_context', 'get_design_context'].includes(data.next_actions?.[0]?.tool)) return decision
      const design = data.next_actions[0].tool === 'get_design_context'
      const routed = { ...body, data: { ...data, next_actions: [{ tool: generatorName,
        arguments: { project_id: data.selected_project_id || data.project_id, ...(design ? { stage: 'design' } : {}) } }] } }
      return { ...decision, value: { ...result.value, structuredContent: routed,
        content: [{ type: 'text', text: JSON.stringify(routed) }] } }
    }
    if (exec.name !== 'mcp__gxworks__propose_design_plan') return next()
    const decision = await next()
    if (decision.kind !== 'accept' || decision.value !== undefined || decision.content !== undefined) return decision
    // The generator reviews its own nested draft inside execute(), where waiting
    // on the human does not hold up the rest of the model's tool batch.
    if (exec.parent !== undefined) return decision
    const reviewed = await reviewDesign(ctx, exec, result.value?.structuredContent)
    if (!reviewed) return decision
    if (reviewed.block) return { kind: 'block', feedback: [{ type: 'text', text: reviewed.block }] }
    const body = { ...result.value.structuredContent, data: reviewed.data }
    return { ...decision, value: { ...result.value, structuredContent: body,
      content: [{ type: 'text', text: JSON.stringify(body) }] } }
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!exec.name.startsWith('mcp__gxworks__')) return next()
    const tool = exec.name.slice('mcp__gxworks__'.length)
    const args = exec.arguments
    if (tool === 'confirm_design_plan') {
      const approved = designApprovals.get(exec.agent?.session)
      if (!approved || approved.draft_id !== args.draft_id || approved.approach_id !== args.approach_id) {
        return { kind: 'deny', reason: '请先用 propose_design_plan({}) 展示草稿，并使用用户在确认窗口中选择的方案。' }
      }
    }
    if (!exec.agent || isNestedGeneratorCall(exec)) return next()
    // The backend owns the semantic gate: its schema tells the model to choose
    // direct by specification completeness (porting, complete sequences, FB
    // authoring, explicit requests). Only enforce the hard floor here — the
    // literal wording of a direct request — and let the MCP server judge the rest.
    if (tool === 'create_project' && args.generation_mode === 'direct') {
      const latest = (exec.agent.session?.snapshotEvents?.() || []).findLast(event => humanText(event).trim())
      const requested = explicitDirect(latest && humanText(latest)) ||
        questionChoices(exec.agent.session).some(choice => chosenDirect(choice))
      if (!requested && !args.implementation_specified) {
        return { kind: 'deny', reason: '直接模式仅用于：跨品牌移植/转写、已给出完整时序/公式/步骤的规格、确定性 FB 编写，或用户明确要求直接生成。'
          + '开放式工艺需求请省略 generation_mode 走默认 Design；用户原话说“直接生成”时无需本参数之外的确认。' }
      }
    }
    // Mirror the backend contract exactly: only Ladder candidates and new-FBD
    // generation carry implementation_review in output_contract.required_fields
    // (generation_tools.py). ST and SFC generation leave the review optional;
    // the MCP server's check_review rejects with missing_families diagnostics
    // and next_actions when one is genuinely needed.
    if ((tool === 'create_program_candidate' ||
         (tool === 'create_fbd_candidate' && args.operation === 'generate')) &&
        !args.implementation_review) {
      return { kind: 'deny', reason: '请先用用户原文取得生成上下文，按实际 CPU 查证相关指令并完成全部分页，比较后附上 implementation_review。' }
    }
    return next()
  })
  logger?.debug?.('dsh-gxworks: 内置后端、launcher 与 skills 就位')
}
