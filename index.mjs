import { designApprovals, explicitDirect, generatorName, humanTexts, isNestedGeneratorCall,
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

function normalize(text) {
  return text.trim().replace(/\s+/gu, ' ')
}

/** Options and custom answers the human gave in question windows, newest last. */
function questionAnswerSteps(events) {
  const asked = new Map()
  const stepsByEvent = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'ask_user_question' && event.data.callId) {
      let questions = []
      try {
        const parsed = typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments
        questions = Array.isArray(parsed?.questions) ? parsed.questions : []
      } catch { /* ignore malformed arguments */ }
      asked.set(event.data.callId, questions)
      continue
    }
    const message = event.type === 'tool/result' ? event.data?.message : undefined
    if (!message || message.isError || !asked.has(message.toolCallId)) continue
    const text = (message.content || []).filter(block => block?.type === 'text').map(block => block.text).join('')
    let payload
    try { payload = JSON.parse(text) } catch { continue }
    const questions = asked.get(message.toolCallId) || []
    const answerSteps = []
    for (const answer of payload?.answers || []) {
      const prompt = questions.find(q => q && q.id === answer.id)?.question
      for (const value of [...(answer.selected || []), ...(typeof answer.custom === 'string' ? [answer.custom] : [])]) {
        if (typeof value === 'string' && value.trim()) {
          const clean = value.trim()
          const variants = [clean]
          if (typeof prompt === 'string' && prompt.trim()) {
            variants.push(`${prompt.trim()}：${clean}`, `${prompt.trim()}: ${clean}`)
          }
          answerSteps.push(variants)
        }
      }
    }
    if (answerSteps.length) stepsByEvent.set(event, answerSteps)
  }
  return stepsByEvent
}

function questionChoices(session) {
  const events = session?.snapshotEvents?.() || []
  const byEvent = questionAnswerSteps(events)
  return [...byEvent.values()].flat(2)
}

// A label needs no sentence punctuation: "方案A：…（推荐，直接生成）" is a choice.
function chosenDirect(text = '') {
  return /(?:直接|立即|马上)(?:帮我)?生成|跳过(?:方案|设计)?(?:对比|比较)?确认|direct\s*(?:mode|generation)|快捷生成/iu.test(text)
}

function quotesUserMessages(request, events) {
  const start = normalize(request)
  if (!start) return false
  const answerMap = questionAnswerSteps(events)
  const steps = []
  for (const event of events) {
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const original = normalize((event.data.content || []).filter(block => block.type === 'text')
        .map(block => block.text).join('\n'))
      if (original) steps.push([original])
    } else if (answerMap.has(event)) {
      for (const variants of answerMap.get(event)) {
        const normalized = variants.map(normalize).filter(Boolean)
        if (normalized.length) steps.push(normalized)
      }
    }
  }
  let candidates = new Set([start])
  for (const options of steps) {
    const next = new Set(candidates)
    for (const remaining of candidates) {
      for (const segment of options) {
        if (remaining === segment) return true
        if (remaining.startsWith(segment + ' ')) next.add(remaining.slice(segment.length + 1))
      }
    }
    candidates = next
  }
  return false
}

export function apply(ctx) {
  const logger = ctx?.logger?.('dsh-gxworks')
  const missing = required.filter(relative => !existsSync(join(packageRoot, relative)))
  if (missing.length > 0) {
    logger?.warn?.(`dsh-gxworks: 安装包缺少 ${missing.join('、')}，MCP 工具与技能不可用；请重新安装本包`)
    return
  }
  const supportsGenerator = Boolean(ctx.get?.('llm')?.stream && ctx.get?.('tools')?.register)
  if (supportsGenerator) registerLadderGenerator(ctx, quotesUserMessages)
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
      const requested = explicitDirect(humanTexts(exec.agent.session).at(-1)) ||
        questionChoices(exec.agent.session).some(choice => chosenDirect(choice))
      if (!requested && !args.implementation_specified) {
        return { kind: 'deny', reason: '直接模式仅用于：跨品牌移植/转写、已给出完整时序/公式/步骤的规格、确定性 FB 编写，或用户明确要求直接生成。'
          + '开放式工艺需求请省略 generation_mode 走默认 Design；用户原话说“直接生成”时无需本参数之外的确认。' }
      }
    }
    if (['get_design_context', 'get_generation_context'].includes(tool) && args.user_requirement &&
        revisedRequirements.get(exec.agent.session) !== normalize(args.user_requirement) &&
        !quotesUserMessages(args.user_requirement, exec.agent.session.snapshotEvents())) {
      // Hand back the exact text: the model cannot guess the user's wording, and
      // four retries in a row is worse than one long denial.
      const verbatim = humanTexts(exec.agent.session).join('\n').slice(0, 6000)
      return { kind: 'deny', reason: 'user_requirement 请逐字复制完整用户消息，多轮原文可按顺序换行拼接。'
        + '模型提出的方案放入设计草稿，指令选型放入 implementation_review。\n逐字原文：\n' + verbatim }
    }
    if ((tool === 'create_program_candidate' || (['create_st_candidate', 'create_fbd_candidate',
        'create_sfc_candidate'].includes(tool) && args.operation === 'generate')) && !args.implementation_review) {
      return { kind: 'deny', reason: '请先用用户原文取得生成上下文，按实际 CPU 查证相关指令并完成全部分页，比较后附上 implementation_review。' }
    }
    return next()
  })
  logger?.debug?.('dsh-gxworks: 内置后端、launcher 与 skills 就位')
}
