// The local MCP owns engineering facts and validation. Desktop owns its model.
export const generatorName = 'gxworks_generate_ladder'

export function humanTexts(session) {
  return session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'user')
    .map(e => e.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).filter(Boolean)
}

export function explicitDirect(text = '') {
  return /(?:^|[\n。！？；，,.!;]\s*)(?:请|请你|这次|本次)?\s*(?:直接(?:帮我)?生成|跳过(?:方案|设计)确认|使用\s*direct\s*模式|(?:use\s+)?direct\s+(?:mode|generation)|\/gxworks-direct)(?:[\s，。,.!！]|程序|梯形图|$)/iu.test(text)
}

// Models stream tool arguments as raw text. One bare quote or newline inside an
// explanation must not cost the whole stage: repair the text, then parse.
export function repairJsonText(text) {
  const source = String(text ?? '')
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) { out += character; escaped = false; continue }
      if (character === '\\') { out += character; escaped = true; continue }
      if (character === '\n') { out += '\\n'; continue }
      if (character === '\r') { out += '\\r'; continue }
      if (character === '\t') { out += '\\t'; continue }
      if (character === '"') {
        let next = index + 1
        while (next < source.length && /\s/u.test(source[next])) next += 1
        const follower = source[next]
        // A quote only closes a string when the structure continues after it.
        if (follower === undefined || ',:}]'.includes(follower)) { out += '"'; inString = false }
        else out += '\\"'
        continue
      }
      out += character
      continue
    }
    if (character === '"') inString = true
    out += character
  }
  return out.replace(/,(\s*[}\]])/gu, '$1')
}

/** Parse one model submission, tolerating a fence and recoverable syntax slips. */
export function parseJsonText(text) {
  const trimmed = String(text ?? '').trim()
  const fenced = trimmed.match(/^`{3}(?:json)?[ \t]*\n([\s\S]*?)\n?`{3}$/iu)
  for (const candidate of fenced ? [fenced[1], trimmed] : [trimmed]) {
    if (!candidate) continue
    try { return { value: JSON.parse(candidate) } } catch { /* try the repaired text */ }
    const repaired = repairJsonText(candidate)
    if (repaired !== candidate) {
      try { return { value: JSON.parse(repaired) } } catch { /* report the failure below */ }
    }
  }
  return { error: '模型提交的内容不是有效 JSON。' }
}

/** Use the submission call itself; unrelated extra calls are the provider's noise. */
export function pickSubmission(calls, name) {
  const list = [...calls]
  const matched = list.filter(call => call?.name === name)
  if (matched.length === 1) return { call: matched[0] }
  return { error: matched.length
    ? `模型给出了 ${matched.length} 个 ${name} 提交。`
    : `模型未返回 ${name} 提交${list.length ? '（实际返回：' + list.map(call => call?.name).join('、') + '）' : ''}。` }
}

// A draft can be complete except for facts only the human can supply. Those
// answers are the missing input, so the window must still open instead of
// bouncing the draft back to the model for another full analysis.
const answerableErrors = new Set(['required_parameter_missing', 'parameter_details_missing'])

/** The approach the user approved for this session, consumed by confirm_design_plan. */
export const designApprovals = new WeakMap()
/** A requirement the user changed through the window: the only allowed rewrite. */
export const revisedRequirements = new WeakMap()

export function normalizeRequirement(text) {
  return String(text ?? '').trim().replace(/\s+/gu, ' ')
}

function pendingParameters(review) {
  const rows = Array.isArray(review?.parameters) ? review.parameters : []
  return rows.filter(row => row && row.id && row.required !== false && !String(row.value ?? '').trim())
}

function parameterQuestionId(row) {
  return 'gxworks-parameter-' + row.id
}

function answerValue(answer, id) {
  const item = answer?.answers?.find(entry => entry?.id === id)
  const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
  if (custom) return custom
  const selected = Array.isArray(item?.selected) ? item.selected : []
  return selected.length === 1 && typeof selected[0] === 'string' ? selected[0].trim() : ''
}

/** Which instructions this approach claims, so the human sees them before approving. */
function approachDetail(approach, label) {
  const contract = approach?.generation_contract && typeof approach.generation_contract === 'object'
    ? approach.generation_contract : {}
  const instances = (Array.isArray(contract.instruction_instances) ? contract.instruction_instances : [])
    .map(instance => typeof instance === 'string' ? instance : instance?.opcode)
  const opcodes = [...new Set([...(contract.required_opcodes || []), ...instances].filter(Boolean))]
  const forbidden = Array.isArray(contract.forbidden_opcodes) ? contract.forbidden_opcodes : []
  return [`### ${label}`, approach.description,
    approach.pros && `优势：${approach.pros}`, approach.cons && `限制：${approach.cons}`,
    opcodes.length > 0 && '指令：' + opcodes.join('、'),
    forbidden.length > 0 && '禁用指令：' + forbidden.join('、'),
    approach.generation_guide,
    ...['implementation_semantics', 'implementation_preferences', 'construction_plan', 'explicit_user_constraints']
      .filter(key => approach[key] && Object.keys(approach[key]).length).map(key => JSON.stringify(approach[key]))]
    .filter(Boolean).join('\n\n')
}

function droppedClaimLine(row) {
  const claim = row?.claim && typeof row.claim === 'object' ? row.claim : {}
  const text = [claim.summary, claim.claim, claim.text, claim.description]
    .map(value => typeof value === 'string' ? value.trim() : '').find(Boolean)
  const kind = [claim.operation, claim.target?.kind]
    .map(value => typeof value === 'string' ? value.trim() : '').find(Boolean)
  const label = [kind, text].filter(Boolean).join(' · ')
  return '- ' + (label || String(row?.field || '标注'))
}

/**
 * Show the draft and the facts it still needs in one window, then answer for it.
 * @returns undefined when the draft is not for the human yet, `{block}` when the
 * host cannot ask, otherwise `{data}` — the response the generator continues from.
 */
export async function reviewDesign(ctx, exec, body) {
  const draft = body?.data
  const choices = draft?.review?.approaches
  if (!body?.ok || !choices?.length) return
  const errors = Array.isArray(draft.issues?.errors) ? draft.issues.errors : []
  const requiredParameters = pendingParameters(draft.review)
  // Only a draft whose remaining errors are answers the human owes may still be
  // confirmed here; anything else is a model error for the model to fix.
  if (errors.length &&
      !(requiredParameters.length > 0 && errors.every(issue => answerableErrors.has(issue?.code)))) return
  const askUser = ctx.get?.('userQuestions')
  if (!askUser) return { block: '当前宿主没有用户确认入口。可在 Desktop 打开此草稿继续确认。' }
  const session = exec.agent?.session
  designApprovals.delete(session)
  const labels = choices.map((choice, i) => `方案 ${i + 1} · ${choice.name}`)
  const { summary, approaches = [], io_table, parameters, ...spec } = draft.review
  const detail = [summary, ...approaches.map((approach, i) => approachDetail(approach, labels[i])),
    io_table?.length && '### I/O\n' + io_table.map(row => `- ${row.address} · ${row.label || ''}`).join('\n'),
    parameters?.length && '### 参数\n' + parameters.map(row => `- ${row.name || row.id} · ${row.value ?? ''} ${row.unit || ''}`).join('\n'),
    draft.dropped_claims?.length && '### 原文未支持的标注（已忽略）\n' + draft.dropped_claims.map(droppedClaimLine).join('\n'),
    Object.keys(spec).length && '### 其他规格\n' + JSON.stringify(spec, null, 2),
    '### 原始需求', draft.user_requirement].filter(Boolean).join('\n\n')
  const question = { id: 'gxworks-design', header: '工程设计', question: '选择要按其生成程序的方案，或提出修改。',
    detail, options: [...choices.map((a, i) => ({ label: labels[i], description: a.description || a.generation_guide || '按此方案生成' })),
      { label: '修改方案', description: '返回设计阶段，补充要求或调整方案。' }] }
  if (choices.length === 1) question.intent = { kind: 'plan-review', approve: labels[0], callId: exec.callId }
  // Ask the facts the draft still needs in the same window, so the answers
  // travel with the draft instead of arriving as an edited requirement.
  const parameterQuestions = requiredParameters.map(row => ({ id: parameterQuestionId(row),
    header: '设计参数', question: String(row.name || row.id).trim() || String(row.id),
    ...(row.note ? { detail: String(row.note) } : {}),
    ...(Array.isArray(row.options) && row.options.length
      ? { options: row.options.map(option => ({ label: String(option) })) } : {}) }))
  let answer, cancelled = false
  try {
    answer = await askUser.ask({ questions: [question, ...parameterQuestions], agent: exec.agent, signal: exec.signal })
  } catch (error) {
    if (error.code !== 'ASK_CANCELLED') throw error
    // Closing the panel is not a request to redesign; say exactly that.
    answer = { answers: [] }
    cancelled = true
  }
  const item = answer.answers.find(entry => entry.id === question.id)
  const index = item?.custom === undefined && item?.selected?.length === 1 ? labels.indexOf(item.selected[0]) : -1
  const parameterAnswers = {}
  const unanswered = []
  for (const row of requiredParameters) {
    const value = answerValue(answer, parameterQuestionId(row))
    if (value) parameterAnswers[row.id] = value
    else unanswered.push(String(row.name || row.id))
  }
  const answered = Object.keys(parameterAnswers).length > 0
  if (cancelled && index < 0) {
    return { data: { approved: false,
      feedback: '用户关闭了确认窗口，没有选择方案。不要重新设计，也不要继续生成；请用户在对话里给出决定后再展示同一份草稿。' } }
  }
  if (index >= 0 && !unanswered.length) {
    const selection = { draft_id: draft.draft_id, approach_id: choices[index].approach_id,
      ...(answered ? { parameter_answers: parameterAnswers } : {}) }
    designApprovals.set(session, selection)
    return { data: { approved: true, next_actions: [{ tool: 'confirm_design_plan', arguments: selection }] } }
  }
  if (index >= 0) {
    // Keep the same draft; only the answers are missing.
    designApprovals.delete(session)
    return { data: { approved: false,
      feedback: `用户选择了${labels[index]}，但必填参数尚未回答：${unanswered.join('、')}。`
        + '请用 propose_design_plan({}) 重新展示这份草稿并再次向用户提问；答案只随参数提交，不要并入 user_requirement，也不要重新设计。',
      next_actions: [{ tool: 'propose_design_plan', arguments: {},
        instruction: '用空参数重新展示当前草稿，确认窗口会再次收集这些答案。' }] } }
  }
  const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
  const notes = [...(custom ? [custom] : []),
    ...requiredParameters.map(row => parameterAnswers[row.id] && `${String(row.name || row.id).trim()}：${parameterAnswers[row.id]}`)]
    .filter(Boolean)
  const response = { approved: false, feedback: custom || '用户要求修改方案。请先听取修改意见。' }
  if (notes.length) {
    const requirement = [draft.user_requirement, ...notes].join('\n')
    revisedRequirements.set(session, normalizeRequirement(requirement))
    response.next_actions = [{ tool: 'get_design_context', arguments: { user_requirement: requirement } }]
  }
  return { data: response }
}

function resolvePage(value, units, schema = false) {
  if (!value || typeof value !== 'object') return value
  if (value.$ref?.startsWith('#/objects/') && Object.keys(value).length === 1) {
    const key = value.$ref.slice(10)
    if (!Object.hasOwn(units, key)) throw Error('MCP 返回了未交付的分页对象。')
    return schema ? units[key] : resolvePage(units[key], units)
  }
  if (schema) return value
  if (Array.isArray(value)) return value.map(item => resolvePage(item, units))
  if (value.$concat && Object.keys(value).length === 1) return resolvePage(value.$concat, units).flat()
  if (value.$merge && Object.keys(value).length === 1) return Object.assign({}, ...resolvePage(value.$merge, units))
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, resolvePage(item, units, key === 'schema' || key.endsWith('_schema'))]))
}

async function readDocument(invoke, tool, args) {
  const units = {}
  let id, root
  for (let index = 0; ; index++) {
    const page = await invoke(tool, args)
    const d = page.delivery
    if (!d || d.page !== index || (index && d.document_id !== id)) throw Error('生成上下文分页不连续，请重新读取。')
    if (index === 0) { id = d.document_id; root = page.document }
    Object.assign(units, page.objects)
    if (d.complete) return { id, content: resolvePage(root, units), pages: index + 1 }
    if (d.next?.tool !== tool || !d.next.arguments?.cursor) throw Error('生成上下文缺少下一页。')
    args = d.next.arguments
  }
}

// Keep manual rows in order, including row-specific conditions and missing-field distinctions.
function manualTable(items) {
  if (items.length < 3 || !items.every(row => row && typeof row === 'object' && !Array.isArray(row))) return items
  const common = Object.keys(items[0]).filter(key => items.every(row => Object.hasOwn(row, key)))
  const shared = Object.fromEntries(common.filter(key => items.every(row =>
    JSON.stringify(row[key]) === JSON.stringify(items[0][key]))).map(key => [key, items[0][key]]))
  const columns = common.filter(key => !Object.hasOwn(shared, key))
  const table = { columns, rows: items.map(row => columns.map(key => row[key])) }
  if (Object.keys(shared).length) table.common = shared
  const extra = {}
  for (const [i, row] of items.entries()) {
    const fields = Object.fromEntries(Object.entries(row).filter(([key]) => !common.includes(key)))
    if (Object.keys(fields).length) extra[i] = fields
  }
  if (Object.keys(extra).length) table.extra_fields_by_row = extra
  return JSON.stringify(table).length < JSON.stringify(items).length ? table : items
}

// Several manual aspects often have exactly the same answer and missing dependencies.
function coverageAspects(items) {
  if (!items.length || !items.every(row => typeof row?.aspect === 'string')) return items
  const groups = new Map()
  for (const { aspect, ...result } of items) {
    const key = JSON.stringify(result)
    if (!groups.has(key)) groups.set(key, { ...result, aspects: [] })
    groups.get(key).aspects.push(aspect)
  }
  const grouped = { by_result: [...groups.values()] }
  return JSON.stringify(grouped).length < JSON.stringify(items).length ? grouped : items
}

// Use Web's context-reference convention to send repeated scopes and contracts once.
function contextText(packet) {
  const seen = new Map()
  function pack(value, path, key = '') {
    if (!value || typeof value !== 'object' || key === 'schema' || key.endsWith('_schema')) return value
    const text = JSON.stringify(value)
    if (text.length > 150) {
      if (seen.has(text)) return { $ref: seen.get(text), $context_reference: true }
      seen.set(text, path)
    }
    if (Array.isArray(value) && key === 'aspects' && path.includes('/coverage/')) {
      value = coverageAspects(value)
    } else if (Array.isArray(value) && (key === 'facts' || key === 'aspects') && path.startsWith('#/instruction_research/manual/')) {
      value = manualTable(value)
    }
    if (Array.isArray(value)) return value.map((item, i) => pack(item, path + '/' + i))
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, pack(v, path + '/' + k.replaceAll('~', '~0').replaceAll('/', '~1'), k)]))
  }
  return JSON.stringify(pack(packet, '#'))
}

const manualFormat = '手册 rows 按 columns 取值并继承 common、同序号 extra_fields_by_row；by_result 中所列 aspects 共享该项的结论和缺项。'
const directSelection = '优先用本 CPU 能直接表达工艺的成组操作。准备逐项复制逻辑时，先换一种状态表示和推进事件：可以由公共时基推进整组状态，也可按事件更新单项记录。两种用法在同一输入下比较，只写一两句决定性差异。只排除实际比较过的用法。不得靠自行限定容量或输入节拍使实现成立。只生成所选的一份程序。'
const designSelection = '按同一组工艺条件比较至少两种整体实现。区分题目要求与实现假设，估算各自的步数增长、状态和资源。未规定的容量、精度、互斥或排队条件不能作为排除另一种算法的理由。当同一段逻辑随元素或通道重复时，比较逐项展开和利用本 CPU 成组操作的整体方案，说明数据怎样表示、怎样更新、并发与复位怎样保持。草稿只写工艺事实、状态表示和推进方式：具体指令与操作数按协议不入草稿，在生成阶段由实现审查选择，除非用户原文明确指定。用户未说明而影响实现的事实写进 missing_info 的问题与选项，不要用假设顶替。资料缺项说明对选择的影响。'

// The Web wire uses short keys. Spell out the same fields in the provider's tool schema.
const ladderFields = { r: 'networks', c: 'shared_contacts', b: 'output_branches', i: 'series_contacts', o: 'outputs' }
const fieldHelp = {
  shared_contacts: 'Executable contacts shared by every branch. Use [] or strings such as NO X0, NC M0, >= D0 K1. Never put a title here.',
  series_contacts: 'Additional contacts in series. Use NO, NC, P, F and an address, or a prefix comparison. For parallel paths use {"or":[["NO X0"],["NO M0"]]}.',
  outputs: 'Coils use COIL Y0. Timers use TIMER T0 K10. Applications use a supported opcode or one delivered FRAG call with positional operands. Each entry is one executable instruction.',
}

function modelLadderSchema(node) {
  if (Array.isArray(node)) return node.map(modelLadderSchema)
  if (!node || typeof node !== 'object') return node
  const result = { ...node }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) if (node[key]) result[key] = modelLadderSchema(node[key])
  if (node.required) result.required = node.required.map(key => ladderFields[key] || key)
  if (node.properties) result.properties = Object.fromEntries(Object.entries(node.properties).map(([key, property]) => {
    const label = ladderFields[key] || key
    return [label, { ...modelLadderSchema(property), ...(fieldHelp[label] ? { description: fieldHelp[label] } : {}) }]
  }))
  return result
}

function wireLadder(value) {
  const program = value?.result?.program || value
  if (!Array.isArray(program?.networks)) return value
  const rename = (row, keys) => Object.fromEntries(Object.entries(row).map(([name, v]) => {
    const key = keys.find(k => ladderFields[k] === name)
    if (key && Object.hasOwn(row, key)) throw Error('程序同时提交了同一字段的两种写法。')
    return [key || name, v]
  }))
  const { networks, ...fields } = program
  if (Object.hasOwn(fields, 'r')) throw Error('程序含两套梯级。')
  const compact = { ...fields, r: networks.map(network => {
    const row = rename(network, ['c', 'b'])
    if (Array.isArray(row.b)) row.b = row.b.map(branch => rename(branch, ['i', 'o']))
    return row
  }) }
  return value?.result?.program ? { ...value, result: { ...value.result, program: compact } } : compact
}

function submissionTool(tools, agent, ladderSchema, research, direct) {
  const { families } = research
  const candidate = tools.get('mcp__gxworks__create_program_candidate', agent).parameters.properties
  const review = candidate.implementation_review
  const compact = Boolean(review.properties.reviewed_instructions)
  const grouped = compact && direct && research.group_operations?.length
  const fragments = direct && Boolean(research.executable_fragments?.length)
  const { selected, alternatives, limitations } = review.properties
  const groups = {}
  for (const [family, names] of Object.entries(families)) {
    for (const key of family === 'explicit' ? names : [family]) {
      const allowed = family === 'explicit' ? [key] : names
      groups[key] = compact ? { type: 'string', enum: allowed } : { type: 'object', required: ['instruction', 'tradeoff'], properties: {
        instruction: { type: 'string', enum: allowed }, tradeoff: { type: 'string', minLength: 1,
          description: 'Explain how this instruction fits or falls short in this project.' } } }
    }
  }
  const comparisons = { type: 'object', additionalProperties: false, properties: groups, required: Object.keys(groups) }
  return { name: 'submit_ladder', description: '提交当前方案的选型与完整程序。按参数字段名填写，每条梯级的触点和输出只写可执行表达式。',
    parameters: { type: 'object', additionalProperties: false, required: ['implementation_review', 'ladder'],
      properties: { implementation_review: { type: 'object', additionalProperties: false,
        required: [...(grouped ? ['grouped_option'] : ['alternatives']), 'selected', ...(fragments ? ['assumptions'] : []), ...(Object.keys(groups).length ? ['compared_families'] : []),
          ...(research.manual?.coverage?.status === 'incomplete' ? ['limitations'] : [])],
        properties: { ...(grouped ? { grouped_option: { type: 'object', required: ['instruction', 'comparison'],
          properties: { instruction: { type: 'string', enum: research.group_operations },
            comparison: { type: 'string', maxLength: 320, description: fragments ?
              '比较可执行片段的完整行为和另一种实现。若排除片段，给出它在相同输入、分辨率、并发条件下无法完成的可观察输出。' :
              '先说明用它存什么、由什么事件推进整组。若逐项展开更好，给出成组方案违反的原始要求或具体输入。' } } }
        } : { alternatives: compact ? { ...alternatives, maxItems: 1,
          description: 'Only one decisive alternative when the implementation repeats per element or channel; otherwise [].' } : alternatives }),
          selected,
          ...(fragments ? { assumptions: review.properties.assumptions } : {}), limitations, compared_families: comparisons } },
        ...(candidate.io_example && !review.properties.assumptions ? { io_example: candidate.io_example } : {}), ladder: modelLadderSchema(ladderSchema) } } }
}

function wireReview(value, compact) {
  const { selected, grouped_option } = value
  const alternatives = Array.isArray(value.alternatives) ? value.alternatives : []
  const compared_families = value.compared_families && typeof value.compared_families === 'object' ? value.compared_families : {}
  const limitations = typeof value.limitations === 'string' ? value.limitations : compared_families.limitations
  const comparisons = Object.values(compared_families).filter(row => row && typeof row.instruction === 'string'
    && typeof row.tradeoff === 'string').map(row => ({ method: row.instruction, tradeoff: row.tradeoff }))
  const methods = alternatives.filter(row => row && typeof row.method === 'string' && typeof row.tradeoff === 'string')
    .map(({ method, tradeoff, note }) => ({ method,
    tradeoff: note && typeof note === 'string' ? [tradeoff, note].filter(Boolean).join(' ') : tradeoff }))
  const names = Object.entries(compared_families).filter(([key]) => key !== 'limitations')
    .map(([, row]) => typeof row === 'string' ? row : row?.instruction).filter(Boolean)
  if (grouped_option?.instruction && grouped_option.comparison) methods.push({
    method: grouped_option.instruction, tradeoff: grouped_option.comparison })
  return { ...(typeof selected === 'string' && selected.trim() ? { selected } : {}), alternatives: compact ? methods : [...methods, ...comparisons],
    ...(Array.isArray(value.assumptions) ? { assumptions: value.assumptions.filter(row => typeof row?.condition === 'string' && row.condition.trim()).map(({ condition }) => ({ condition })) } : {}),
    ...(compact ? { reviewed_instructions: [...new Set(names)] } : {}), ...(typeof limitations === 'string' && limitations.trim() ? { limitations } : {}) }
}

async function modelResponse(llm, exec, system, input, metrics, stage, submission, options = {}) {
  const config = exec.agent.session.requestHeader()?.config
  if (!config?.model || !config?.provider) throw Error('当前会话没有已选模型。')
  const started = Date.now(), blocks = new Map()
  let finish, usage
  const calls = new Map()
  const task = options.syntax ? '把给出的内容重写为一个合法 JSON 对象，字段名和文字不变。'
    : stage === 'design'
      ? '当前只做规格设计。原始需求是下面资料中的 request 字段。根据型号和工艺比较有实质差异的方案；调用 submit_design_plan 提交草稿供用户选择。'
      : stage === 'design:repair' ? '只按 targets 提交字段修正，不要重写整份分析。'
        : stage === 'repair' ? '按给出的反例和原始要求，只提交相关梯级的改动。'
          : '现在按 request 生成一份程序。按 submit_ladder 的字段提交简短取舍和程序。'
  const messages = [{ role: 'user', content: [{ type: 'text', text: input }, { type: 'text', text: task }] }]
  for await (const chunk of llm.stream({ ...config, system, messages, ...(submission ? { tools: [submission] } : {}), sessionId: exec.agent.session.id, signal: exec.signal })) {
    if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) || '') + chunk.text)
    if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text)
    if (chunk.type === 'tool-call-delta') {
      const call = calls.get(chunk.index) || { name: '', arguments: '' }
      if (chunk.name) call.name = chunk.name
      call.arguments += chunk.argumentsDelta || ''
      calls.set(chunk.index, call)
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') calls.set(chunk.index, chunk.block)
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind !== 'stop' && !(submission && finish?.kind === 'tool-calls')) throw Error('Ladder 模型调用未正常结束：' + (finish?.failure?.message || finish?.kind || '连接中断'))
  metrics.push({ stage, model: config.model, elapsed_ms: Date.now() - started, ...(usage ? { usage } : {}) })
  let draft
  if (calls.size) {
    const picked = pickSubmission(calls.values(), submission?.name)
    if (picked.error) return { error: picked.error, draft: [...calls.values()].map(call => call.arguments).join('\n') }
    draft = picked.call.arguments
  } else {
    draft = [...blocks.values()].join('').trim()
  }
  const parsed = parseJsonText(draft)
  if (parsed.value !== undefined) return { value: parsed.value }
  // One bounded syntax-only retry keeps the analysed content; a second full call
  // with the original task is what makes these failures cost minutes.
  if (!options.repair) {
    const fixed = await modelResponse(llm, exec,
      '只修复 JSON 语法：把下面这段模型输出重写为一个合法 JSON 对象，字段名、字段值和文字都不改，不要新增或省略内容。',
      draft.length > 60000 ? draft.slice(0, 60000) : draft, metrics, stage + ':syntax', submission, { syntax: true, repair: true })
    if (fixed.value !== undefined) return { ...fixed, repaired: true }
  }
  return { error: parsed.error, draft }
}

export function registerLadderGenerator(ctx, quotes) {
  const tools = ctx.get('tools'), llm = ctx.get('llm')
  tools.register({
    name: generatorName,
    description: 'Desktop 新建 Ladder 首选。Direct 创建工程后、Design 确认后调用。自动读取用户原文和 CPU 手册全部分页，通过本会话模型单次生成，按 Web 协议提交完整候选。不要重复手工生成或先写样例。',
    parameters: { type: 'object', required: ['project_id'], additionalProperties: false, properties: {
      project_id: { type: 'string', description: '当前已创建的工程 ID。' },
      stage: { type: 'string', enum: ['design'], description: '仅在新建工程 next_actions 指定 design 时传入，先生成可供用户选择的方案。' },
      user_requirement: { type: 'string', description: '单条新需求或已确认 Design 省略；多轮合并只用相关的完整用户消息。' },
    } },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    // A thrown error reaches the model as "Tool batch execution failed", which
    // says nothing about what went wrong. Report the real reason instead.
    async execute(args, exec) {
      try {
        return await this.run(args, exec)
      } catch (error) {
        if (exec.signal?.aborted) throw error
        return { status: 'error', project_id: args.project_id, error: String(error?.message || error) }
      }
    },
    async run(args, exec) {
      if (!exec.agent) throw Error('需要当前 Desktop 会话。')
      let calls = 0
      async function invoke(tool, input) {
        const name = 'mcp__gxworks__' + tool
        const callId = exec.callId + '-gx-' + (++calls)
        const result = await tools.execute({ name, arguments: input, callId, rootCallId: exec.rootCallId || exec.callId,
          parent: exec.token, signal: exec.signal, agent: exec.agent })
        for (const extra of result.additionalContexts || []) exec.deferContext(extra)
        if (result.isError) {
          const message = result.error.message
          let detail
          try { detail = JSON.parse(message).error } catch { /* A transport failure has no MCP envelope. */ }
          throw Object.assign(Error(tool + '：' + message), { detail })
        }
        const body = result.value.structuredContent || JSON.parse(result.value.content[0].text)
        if (!body.ok) throw Object.assign(Error(tool + '：' + JSON.stringify(body.error)), { detail: body.error })
        return body.data
      }
      const project = await invoke('get_current_project', {})
      if (project.project_id !== args.project_id || project.target_mode !== 'ladder' || project.version_count) {
        throw Error('入口需要当前选中、尚无程序版本的 Ladder 工程。已有版本请按编辑上下文实施。')
      }
      const metrics = []
      let raw
      if (!project.has_confirmed_spec) {
        const texts = humanTexts(exec.agent.session)
        raw = args.user_requirement || (texts.length === 1 ? texts[0] : undefined)
        if (!raw || !quotes(raw, exec.agent.session.snapshotEvents())) throw Error('请用相关的完整用户消息传入 user_requirement。')
      }
      // A repair request otherwise costs a full round trip through the outer
      // model, which then rewrites the draft by hand and loses the analysis.
      // Resolve only the listed fields here, once.
      async function repairDesign(state) {
        const targets = Array.isArray(state.repair_targets) ? state.repair_targets : []
        if (!targets.length || !state.repair_id || !state.analysis_id) return
        const submission = { name: 'submit_design_repairs',
          description: '只提交 repair_targets 列出的字段修正，其余草稿保持不变。',
          parameters: { type: 'object', required: ['repairs'], additionalProperties: false, properties: {
            repairs: { type: 'array', minItems: 1, maxItems: targets.length, items: { type: 'object',
              required: ['path', 'value_json'], additionalProperties: false, properties: {
                path: { type: 'string', enum: targets.map(target => target.path) },
                value_json: { type: 'string', description: '修正后的值，用 JSON 文本表示；要删除该条时写 []。' } } } } } } }
        const fixed = await modelResponse(llm, exec,
          '只调用 submit_design_repairs。按 targets 的错误修正所列字段；能引用的证据必须逐字来自 request。'
          + '原文没有的地址、指令或事实不要写成证据，删掉该条即可。不要重写整份分析。',
          JSON.stringify({ request: raw, targets }), metrics, 'design:repair', submission)
        const rows = fixed.value?.repairs
        if (!Array.isArray(rows) || !rows.length) return
        const repairs = []
        for (const row of rows) {
          if (!row || !targets.some(target => target.path === row.path)) continue
          try { repairs.push({ path: row.path, value: JSON.parse(String(row.value_json ?? '')) }) } catch { /* skip a broken field */ }
        }
        if (!repairs.length) return
        return invoke('propose_design_plan', { analysis_id: state.analysis_id, repair_id: state.repair_id, repairs })
      }
      if (args.stage === 'design' && !project.has_confirmed_spec) {
        const { content: design } = await readDocument(invoke, 'get_design_context', {
          user_requirement: raw, instruction_details: true })
        const input = contextText({ request: raw, knowledge: design.knowledge, instruction_research: design.instruction_research })
        if (!design.analysis_schema?.properties?.approaches) throw Error('后端未交付 Web Design 草稿结构。')
        const submission = { name: 'submit_design_plan', parameters: design.analysis_schema,
          description: '按 Web Design 结构提交规格草稿。把工艺事实与备选实现分开，证据须逐字来自用户。' }
        const analysis = await modelResponse(llm, exec, [design.analysis_instructions, manualFormat, designSelection].join('\n'), input, metrics, 'design', submission)
        if (analysis.error) return { status: 'repair_required', error: analysis.error, draft: analysis.draft,
          project_id: project.project_id, analysis_id: design.analysis_id, model_calls: metrics.length, metrics,
          next_actions: [{ tool: 'propose_design_plan', instruction: '整理返回的草稿，沿用 analysis_id 提交。' }] }
        let proposal = await invoke('propose_design_plan', { analysis_id: design.analysis_id, analysis: analysis.value })
        if (proposal.status === 'repair_required') {
          const repaired = await repairDesign(proposal)
          if (repaired && !repaired.status) proposal = repaired
        }
        // The post-execute hook ignores nested calls, so the window belongs here:
        // waiting on the human must not hold up the rest of the model's batch.
        const reviewed = await reviewDesign(ctx, exec, { ok: true, data: proposal })
        if (!reviewed) return { project_id: project.project_id, model_calls: metrics.length, metrics, proposal,
          ...(proposal.status ? { status: proposal.status, next_actions: proposal.next_actions } : {}) }
        if (reviewed.block) return { status: 'confirmation_unavailable', project_id: project.project_id,
          model_calls: metrics.length, metrics, error: reviewed.block }
        const settled = reviewed.data
        if (!settled.approved) return { project_id: project.project_id, model_calls: metrics.length, metrics, proposal: settled,
          ...(settled.status ? { status: settled.status, next_actions: settled.next_actions } : {}) }
        const confirm = settled.next_actions?.find(action => action.tool === 'confirm_design_plan')
        if (!confirm) throw Error('缺少当前用户已选择的设计方案。')
        let saved
        try {
          saved = await invoke('confirm_design_plan', confirm.arguments)
        } catch (error) {
          // Bundled backends before this change reject the answer field outright.
          if (!confirm.arguments?.parameter_answers || !/unknown field|parameter_answers/iu.test(String(error.message))) throw error
          return { status: 'design_answers_unsupported', project_id: project.project_id, model_calls: metrics.length, metrics,
            error: '内置后端还不接受参数答案，请更新后端包后重试。',
            proposal: settled }
        }
        if (!saved.confirmed) return { project_id: project.project_id, model_calls: metrics.length, metrics, proposal: saved }
      }
      const contextArgs = project.has_confirmed_spec || metrics.length ? { workflow: 'detailed' }
        : { workflow: 'direct_generation', user_requirement: raw }
      const { id, content: doc, pages } = await readDocument(invoke, 'get_generation_context',
        { ...contextArgs, instruction_details: true })
      if (doc.project_id !== args.project_id || doc.output_contract?.protocol !== 'compact_ladder/1.3' ||
          doc.output_contract.tool !== 'create_program_candidate' || !doc.generation_context_id) throw Error('当前后端未返回该工程的 Web 紧凑 Ladder 协议。')
      const research = doc.instruction_research
      if (!research || (Object.keys(research.families).length && !research.manual)) throw Error('当前后端未随上下文交付相关手册。')
      const { output_schema, request, ...engineering } = doc.generation_input
      const submit = submissionTool(tools, exec.agent, output_schema, research, contextArgs.workflow === 'direct_generation')
      const compactReview = Boolean(tools.get('mcp__gxworks__create_program_candidate', exec.agent).parameters.properties.implementation_review.properties.reviewed_instructions)
      const { executable_fragments: fragments, ...references } = research
      const input = contextText({ request, ...(fragments?.length ? { executable_fragments: fragments } : {}),
        ...engineering, instruction_research: references })
      const system = [
        '只调用 submit_ladder。其参数 schema 是本次唯一返回格式；以下 Web 程序协议仅定义该工具的 ladder 字段。',
        '<ladder_field>', doc.generation_instructions, '</ladder_field>', manualFormat,
        contextArgs.workflow === 'detailed' ? '按已确认的方案实施。' : fragments?.length ?
          '优先复用能完成工艺的 executable_fragments。按片段示例比较输入、采样精度、状态范围和并发行为。适用时在对应梯级按 syntax 填 FRAG 和实参。按相同约束比较漏接事件、来料间距和容差。定时从规格所述事件起算。按可观察的节拍推进，计数可能跨步时按实际经过时间处理。内部容量和节拍填 assumptions，只记录模型实现选择，用户需求以原消息为准。' : directSelection,
        '工具中的 networks / shared_contacts / output_branches / series_contacts / outputs 分别承载 Web 的 r / c / b / i / o。所有网络没有标题字段。',
        compactReview ? 'compared_families 每组只填已查助记符。selected、alternatives、decisions、open_items 简洁不重复。' :
          '在 implementation_review 为各组填写代表指令与简短取舍。',
      ].join('\n')
      const response = await modelResponse(llm, exec, system, input, metrics, 'generate', submit)
      const reply = response.value
      // Some tool adapters close the review one field late. A sole nested program can still be submitted verbatim.
      if (reply && !reply.ladder && reply.implementation_review?.ladder) reply.ladder = reply.implementation_review.ladder
      const recover = (error, draft) => ({ status: 'repair_required', project_id: project.project_id,
        error, draft: draft ?? null, model_calls: metrics.length, metrics, next_actions: [{ tool: 'create_program_candidate',
          arguments: { generation_context_id: doc.generation_context_id },
          instruction: '就地修正已返回的程序或补齐选型比较，沿用这次读取的工程与手册。' }],
        context_document: id, manual_documents: [] })
      if (response.error) return recover(response.error, response.draft)
      if (!reply?.ladder) return recover('生成响应缺少 ladder。', reply)
      let implementation
      try { implementation = wireReview(reply.implementation_review || {}, compactReview) }
      catch (error) { return recover(String(error.message), reply) }
      const review = { ...implementation, context_document: id, manual_documents: [] }
      if (!review.limitations?.trim()) delete review.limitations
      let candidate, program
      try { program = wireLadder(reply.ladder) }
      catch (error) { return recover(String(error.message), reply) }
      const example = reply.io_example || reply.implementation_review?.io_example
      const save = () => invoke('create_program_candidate', { ladder: program,
        generation_context_id: doc.generation_context_id, implementation_review: review, ...(example ? { io_example: example } : {}) })
      async function saveWithBehaviorCheck() {
        try { return await save() } catch (error) {
          if (error.detail?.code !== 'CANDIDATE_BEHAVIOR_MISMATCH' || exec.signal?.aborted) throw error
          const body = program.result?.program || program
          const failure = error.detail.behavior_result
          const networkSchema = (output_schema.properties?.result?.properties?.program || output_schema).properties?.r?.items
          if (!networkSchema || !Array.isArray(body.r) || !failure) throw error
          const witnesses = failure.counterexamples || []
          let indexes, networks
          for (const scope of [failure.network_indexes, witnesses[0]?.network_indexes]) {
            if (!Array.isArray(scope) || !scope.length || scope.length > 32 ||
                scope.some(i => !Number.isInteger(i) || !body.r[i])) continue
            const rows = scope.map(index => ({ index, network: body.r[index] }))
            if (Buffer.byteLength(JSON.stringify(rows)) > 24 * 1024) continue
            indexes = scope
            networks = rows
            break
          }
          if (!networks) throw error
          const replacements = { name: 'repair_networks', description: '替换列出的原始梯级。index 从 0 起算，网络使用原 c/b/i/o 字段。',
            parameters: { type: 'object', required: ['edits'], properties: { edits: { type: 'array',
              maxItems: indexes.length, items: { type: 'object', required: ['index', 'networks'], properties: {
                index: { type: 'integer', enum: indexes }, networks: { type: 'array', items: networkSchema } } } } } } }
          const patch = await modelResponse(llm, exec, '只调用 repair_networks。检查共享时基或状态对所列各输出的影响，一次处理可证实的偏差。保留其余梯级和用例。若期望与用户要求矛盾则返回空 edits。',
            JSON.stringify({ plc_model: doc.plc_model, request, case_id: failure.case_id,
              counterexample: { at_ms: failure.at_ms, scan_ms: failure.scan_ms, scan: failure.scan, address: failure.address,
                expected: failure.expected, actual: failure.actual, inputs: failure.case_input_sequence || failure.input_sequence || failure.witness?.input_sequence },
              ...(witnesses.length > 1 ? { counterexamples: witnesses.map(({ at_ms, address, expected, actual, network_indexes }) =>
                ({ at_ms, address, expected, actual, network_indexes })) } : {}),
              ...(fragments?.length ? { fragment_syntax: fragments.map(f => f.syntax) } : {}),
              networks }), metrics, 'repair', replacements)
          const edits = patch.value?.edits
          if (!Array.isArray(edits) || !edits.length || !edits.every(e => e && indexes.includes(e.index) && Array.isArray(e.networks)) ||
              new Set(edits.map(e => e.index)).size !== edits.length) throw error
          const byIndex = new Map(edits.map(e => [e.index, e.networks]))
          body.r = body.r.flatMap((row, i) => byIndex.get(i) || [row])
          return save()
        }
      }
      // No chat notice here: the host persists unknown event types without the
      // ignorable flag this plugin cannot set, and one such event makes the whole
      // session log unreadable on the next load.
      try {
        candidate = await saveWithBehaviorCheck()
      } catch (error) {
        if (exec.signal?.aborted) throw error
        const state = await invoke('get_current_project', {})
        if (state.project_id !== args.project_id || state.version_count) return {
          status: 'inspect_saved_result', project_id: args.project_id, model_calls: metrics.length, metrics,
          error: String(error.message), next_actions: [{ tool: 'list_projects' }] }
        if (error.detail?.code === 'CANDIDATE_BEHAVIOR_MISMATCH') return { status: 'behavior_mismatch', project_id: project.project_id,
          behavior_result: error.detail.behavior_result, draft: program, model_calls: metrics.length, metrics, next_actions: [] }
        return recover(String(error.message), { ladder: program, implementation_review: implementation, ...(example ? { io_example: example } : {}) })
      }
      const result = { project_id: project.project_id, workflow: doc.workflow_mode, model_calls: metrics.length, metrics,
        context_pages: pages, implementation_review: candidate.implementation_review || implementation, candidate }
      if (candidate.save_result?.status === 'saved_native_diagnostic') return { ...result, status: 'native_validation_failed',
        version_id: candidate.version_id, diagnostics: candidate.validation }
      if (candidate.delivery?.degraded) return { ...result, status: 'delivery_degraded',
        version_id: candidate.version_id, delivery: candidate.delivery }
      return result
    },
  })
}
