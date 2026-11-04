import { explicitDirect, generatorName, humanTexts, registerLadderGenerator } from './launch/generate-ladder.mjs'
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

function quotesUserMessages(request, events) {
  let remaining = normalize(request)
  for (const event of events) {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const original = normalize(event.data.content.filter(block => block.type === 'text')
      .map(block => block.text).join('\n'))
    if (!original) continue
    if (remaining === original) return true
    if (remaining.startsWith(original + ' ')) remaining = remaining.slice(original.length + 1)
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
  const approvals = new WeakMap()
  const revisedRequirements = new WeakMap()
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (result.isError || !exec.agent) return next()
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
    const body = result.value?.structuredContent
    const draft = body?.data
    const choices = draft?.review?.approaches
    const session = exec.agent.session
    approvals.delete(session)
    if (!body?.ok || !choices?.length || draft.issues?.errors?.length) return decision
    const questions = ctx.get?.('userQuestions')
    if (!questions) return { kind: 'block', feedback: [{ type: 'text', text: '当前宿主没有用户确认入口。可在 Desktop 打开此草稿继续确认。' }] }
    const labels = choices.map((choice, i) => `方案 ${i + 1} · ${choice.name}`)
    const { summary, approaches, io_table, parameters, ...spec } = draft.review
    const detail = [summary, ...approaches.map((a, i) => [`### ${labels[i]}`, a.description,
      a.pros && `优势：${a.pros}`, a.cons && `限制：${a.cons}`, a.generation_guide,
      ...['implementation_semantics', 'implementation_preferences', 'construction_plan', 'explicit_user_constraints']
        .filter(key => a[key] && Object.keys(a[key]).length).map(key => JSON.stringify(a[key]))].filter(Boolean).join('\n\n')),
      io_table?.length && '### I/O\n' + io_table.map(row => `- ${row.address} · ${row.label || ''}`).join('\n'),
      parameters?.length && '### 参数\n' + parameters.map(row => `- ${row.name || row.id} · ${row.value ?? ''} ${row.unit || ''}`).join('\n'),
      Object.keys(spec).length && '### 其他规格\n' + JSON.stringify(spec, null, 2),
      '### 原始需求', draft.user_requirement].filter(Boolean).join('\n\n')
    const question = { id: 'gxworks-design', header: '工程设计', question: '选择要按其生成程序的方案，或提出修改。',
      detail, options: [...choices.map((a, i) => ({ label: labels[i], description: a.description || a.generation_guide || '按此方案生成' })),
        { label: '修改方案', description: '返回设计阶段，补充要求或调整方案。' }] }
    if (choices.length === 1) question.intent = { kind: 'plan-review', approve: labels[0], callId: exec.callId }
    let answer
    try {
      answer = await questions.ask({ questions: [question], agent: exec.agent, signal: exec.signal })
    } catch (error) {
      if (error.code !== 'ASK_CANCELLED') throw error
      answer = { answers: [] }
    }
    const item = answer.answers.find(entry => entry.id === question.id)
    const index = item?.custom === undefined && item?.selected?.length === 1 ? labels.indexOf(item.selected[0]) : -1
    let response
    if (index >= 0) {
      const selection = { draft_id: draft.draft_id, approach_id: choices[index].approach_id }
      approvals.set(session, selection)
      response = { approved: true, next_actions: [{ tool: 'confirm_design_plan', arguments: selection }] }
    } else {
      response = { approved: false, feedback: item?.custom || '用户要求修改方案。请先听取修改意见。' }
      if (item?.custom?.trim()) {
        const requirement = draft.user_requirement + '\n' + item.custom
        revisedRequirements.set(session, normalize(requirement))
        response.next_actions = [{ tool: 'get_design_context', arguments: { user_requirement: requirement } }]
      }
    }
    const reviewed = { ...body, data: response }
    return { ...decision, value: { ...result.value, structuredContent: reviewed,
      content: [{ type: 'text', text: JSON.stringify(reviewed) }] } }
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!exec.name.startsWith('mcp__gxworks__')) return next()
    const tool = exec.name.slice('mcp__gxworks__'.length)
    const args = exec.arguments
    if (tool === 'confirm_design_plan') {
      const approved = approvals.get(exec.agent?.session)
      if (!approved || approved.draft_id !== args.draft_id || approved.approach_id !== args.approach_id) {
        return { kind: 'deny', reason: '请先用 propose_design_plan({}) 展示草稿，并使用用户在确认窗口中选择的方案。' }
      }
    }
    if (!exec.agent) return next()
    if (tool === 'create_project' && args.generation_mode === 'direct' &&
        !explicitDirect(humanTexts(exec.agent.session).at(-1))) {
      return { kind: 'deny', reason: '本次用户消息未选择 Direct。省略 generation_mode 继续默认 Design。用户可用“直接生成”或 /gxworks-direct 选择快速生成。' }
    }
    if (['get_design_context', 'get_generation_context'].includes(tool) && args.user_requirement &&
        revisedRequirements.get(exec.agent.session) !== normalize(args.user_requirement) &&
        !quotesUserMessages(args.user_requirement, exec.agent.session.snapshotEvents())) {
      return { kind: 'deny', reason: 'user_requirement 请逐字复制完整用户消息，多轮原文可按顺序换行拼接。模型提出的方案放入设计草稿，指令选型放入 implementation_review。' }
    }
    if ((tool === 'create_program_candidate' || (['create_st_candidate', 'create_fbd_candidate',
        'create_sfc_candidate'].includes(tool) && args.operation === 'generate')) && !args.implementation_review) {
      return { kind: 'deny', reason: '请先用用户原文取得生成上下文，按实际 CPU 查证相关指令并完成全部分页，比较后附上 implementation_review。' }
    }
    return next()
  })
  logger?.debug?.('dsh-gxworks: 内置后端、launcher 与 skills 就位')
}
