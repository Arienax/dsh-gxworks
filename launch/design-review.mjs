// SPDX-License-Identifier: AGPL-3.0

// Present backend drafts through DSH user questions; no PLC generation policy.
// A draft can be complete except for facts only the human can supply. Those
// answers are the missing input, so the window must still open instead of
// bouncing the draft back to the model for another full analysis.
const answerableErrors = new Set(['required_parameter_missing', 'parameter_details_missing'])

/** The approach the user approved for this session, consumed by confirm_design_plan. */
export const designApprovals = new WeakMap()
/** Additional requirement text explicitly submitted through the design window. */
export const revisedRequirements = new WeakMap()

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

// The window is read by a human, so it speaks the user's language and never
// dumps the wire JSON: those fields are long, token-shaped, and unreadable.
const structureWords = {
  zh: {
    self_hold: '自锁保持', set_reset_latch: '置位复位锁存', edge_trigger: '边沿触发',
    state_initialization: '状态初始化', state_transition: '状态转移', state_comparison: '状态比较',
    bit_state_machine: '位状态机', register_state_machine: '寄存器状态机',
    data_register_counter: '数据寄存器计数', hardware_counter: '高速计数器', direct_logic: '直接逻辑',
    analog_control: '模拟量控制', pulse_positioning: '脉冲定位', pid_control: 'PID 控制',
    serial_communication: '串口通信', vfd_multi_speed: '变频器多段速',
  },
  en: {
    self_hold: 'self-hold', set_reset_latch: 'set/reset latch', edge_trigger: 'edge trigger',
    state_initialization: 'state initialization', state_transition: 'state transition',
    state_comparison: 'state comparison', bit_state_machine: 'bit state machine',
    register_state_machine: 'register state machine', data_register_counter: 'register counter',
    hardware_counter: 'high-speed counter', direct_logic: 'direct logic', analog_control: 'analog control',
    pulse_positioning: 'pulse positioning', pid_control: 'PID control',
    serial_communication: 'serial communication', vfd_multi_speed: 'VFD multi-speed',
  },
}

const windowWords = {
  zh: {
    advantages: '优势', limits: '限制', instructions: '拟定指令', forbidden: '排除',
    keys: '关键实现', must: '必须', no: '禁用', anyOf: '任一',
    bindings: 'I/O', pending: '待确认参数', ignored: '原文未支持的标注（已忽略）', behaviors: '行为约束', operations: '操作意图', semantics: '执行语义',
    other: '其他', request: '原始需求（节选）', drop: '舍弃', guide: '实施要点',
    header: '工程设计', ask: '选择要按其生成程序的方案，或提出修改。', change: '修改方案',
    changeHint: '返回设计阶段，补充要求或调整方案。', params: '设计参数',
    output: '输出行为', state: '状态', activation: '生效条件', update: '更新', release: '解除条件',
    interruption: '中断处理', selection: '实现选择', basis: '方案依据', activeLevel: '有效电平',
  },
  en: {
    advantages: 'Pros', limits: 'Cons', instructions: 'Planned instructions', forbidden: 'Avoiding',
    keys: 'Key choices', must: 'must', no: 'forbid', anyOf: 'any of',
    bindings: 'I/O', pending: 'Open questions', ignored: 'Claims the request did not support (dropped)', behaviors: 'behavior constraints', operations: 'operation intents', semantics: 'execution semantics',
    other: 'Other', request: 'Request (excerpt)', drop: 'drop', guide: 'How to build it',
    header: 'Design review', ask: 'Pick the approach to implement, or ask for changes.', change: 'Change the approach',
    changeHint: 'Go back to design and add or adjust requirements.', params: 'Design parameters',
    output: 'Output behavior', state: 'State', activation: 'Activation', update: 'Update', release: 'Release',
    interruption: 'Interruption', selection: 'Implementation choice', basis: 'Decision basis', activeLevel: 'Active level',
  },
}

// Chinese and English have label tables; every other language gets a neutral
// symbol layout, because only the model's own sentences are in that language.
function localeOf(text) {
  const source = String(text ?? '')
  const cjk = (source.match(/[\u3400-\u9fff]/gu) || []).length
  const kana = (source.match(/[\u3040-\u30ff]/gu) || []).length
  const hangul = (source.match(/[\uac00-\ud7af]/gu) || []).length
  if (kana > 0 || hangul > 0) return 'neutral'
  if (/[\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/u.test(source)) return 'neutral'
  if (cjk > 0) return 'zh'
  if (/[\u00c0-\u024f\u1e00-\u1eff]/u.test(source)) return 'neutral'
  return 'en'
}

function wordsOf(locale) {
  return windowWords[locale] || {}
}

function shortText(text, limit) {
  const value = String(text ?? '').trim()
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value
}

function instructionNames(contract, key, property) {
  const list = contract?.[key]
  if (!Array.isArray(list)) return []
  return [...new Set(list.map(item => typeof item === 'string' ? item : item?.[property || 'opcode'])
    .filter(Boolean))].map(String)
}

/** "✓自锁保持 ✓边沿触发 ✗定时" — readable, and no field names leak. */
function semanticsText(rows, locale) {
  const table = structureWords[locale] || structureWords.en
  const parts = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const values = [row?.value, ...(Array.isArray(row?.values) ? row.values : [])].filter(Boolean)
    const names = values.map(value => table[value] || String(value).replace(/_/gu, ' '))
    if (!names.length) continue
    const mark = row.status === 'forbidden' ? '✗' : row.status === 'any_of' ? '±' : '✓'
    parts.push(mark + names.join('/'))
  }
  return parts.join(' ')
}

/** One labelled line, or a symbol-marked one when this language has no table. */
function labelled(locale, key, mark, value, limit) {
  const words = wordsOf(locale)
  const text = limit ? shortText(value, limit) : String(value ?? '').trim()
  if (!text) return ''
  if (!key) return text
  const label = words[key]
  return label ? `${label}：${text}` : `${mark} ${text}`
}

/** Which instructions this approach claims, so the human sees them before approving. */
function approachDetail(approach, label, locale) {
  const contract = approach?.generation_contract && typeof approach.generation_contract === 'object'
    ? approach.generation_contract : {}
  const opcodes = [...new Set([...instructionNames(contract, 'required_opcodes'),
    ...instructionNames(contract, 'instruction_instances')])]
  const forbidden = instructionNames(contract, 'forbidden_opcodes')
  const keys = locale === 'neutral' ? '' : semanticsText(approach?.implementation_semantics, locale)
  // No "you asked for this" wording: every opcode here is the draft's own choice,
  // whether it came from a claim about the request or from the model's planning.
  return [`### ${label}`, labelled(locale, '', '', approach.description, 200),
    labelled(locale, 'advantages', '+', approach.pros, 140),
    labelled(locale, 'limits', '−', approach.cons, 140),
    opcodes.length > 0 && labelled(locale, 'instructions', '⚙', opcodes.join('、')),
    forbidden.length > 0 && labelled(locale, 'forbidden', '⛔', forbidden.join('、')),
    keys && labelled(locale, 'keys', '◆', keys),
    ...(approach.output_logic || []).map(row => [labelled(locale, 'output', '→', row.target),
      ...['state', 'activation', 'update', 'release', 'interruption', 'selection']
        .map(key => labelled(locale, key, '·', row[key]))].filter(Boolean).join('\n')),
    ...(approach.decision_basis || []).map(row => labelled(locale, 'basis', '◇',
      [row.variant, row.premise, row.status, row.conclusion,
        ...(row.applicability_conditions || []).map(condition => [condition.premise, condition.status].filter(Boolean).join(' · '))]
        .filter(Boolean).join(' · '))),
    labelled(locale, 'guide', '→', approach.generation_guide, 120)]
    .filter(Boolean).join('\n')
}

/** One line for everything else the draft carries, instead of a JSON blob. */
function otherSummary(review, locale) {
  const words = wordsOf(locale)
  const parts = []
  const bindings = Array.isArray(review?.io_bindings) ? review.io_bindings : []
  if (bindings.length) {
    parts.push((words.bindings || 'I/O') + ' ' + bindings.slice(0, 6).map(row =>
      `${row.address} ${shortText(row.label, 16)}${[0, 1].includes(row.active_level) ? ` (${words.activeLevel || 'active'}=${row.active_level})` : ''}`.trim()).join('、'))
  }
  for (const [key, label] of [['behavior_constraints', words.behaviors], ['operation_intents', words.operations],
    ['execution_semantics', words.semantics]]) {
    const rows = review?.[key]
    if (Array.isArray(rows) && rows.length) parts.push(label ? `${label} ${rows.length}` : `×${rows.length}`)
  }
  if (review?.user_notes) parts.push(shortText(review.user_notes, 120))
  return parts.join('；')
}

function droppedClaimLine(row, locale) {
  const words = wordsOf(locale)
  const claim = row?.claim && typeof row.claim === 'object' ? row.claim : {}
  const text = [claim.summary, claim.claim, claim.text, claim.description]
    .map(value => typeof value === 'string' ? value.trim() : '').find(Boolean)
  const kind = [claim.operation, claim.target?.kind]
    .map(value => typeof value === 'string' ? value.trim() : '').find(Boolean)
  const label = [kind, text].filter(Boolean).join(' · ')
  return '- ' + (label || String(row?.field || words.drop || '?'))
}

/**
 * Show the draft and the facts it still needs in one window, then answer for it.
 * @returns undefined when the draft is not for the human yet, `{block}` when the
 * host cannot ask, otherwise `{data}` — the response returned to the session model.
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
  const locale = localeOf(draft.user_requirement)
  const words = wordsOf(locale)
  const numbered = choice => `${choice.name}`
  const labels = choices.map((choice, i) => locale === 'neutral' ? `${i + 1} · ${numbered(choice)}`
    : `${locale === 'zh' ? '方案' : 'Option'} ${i + 1} · ${choice.name}`)
  const { summary, approaches = [], parameters, ...rest } = draft.review
  const other = otherSummary(rest, locale)
  const open = (Array.isArray(parameters) ? parameters : []).filter(row => !String(row.value ?? '').trim())
  const ignored = (draft.dropped_claims || []).map(row => droppedClaimLine(row, locale))
  const detail = [shortText(summary, 200),
    ...approaches.map((approach, i) => approachDetail(approach, labels[i], locale)),
    open.length > 0 && labelled(locale, 'pending', '?', open.map(row => shortText(row.name || row.id, 60)).join('；')),
    ignored.length > 0 && labelled(locale, 'ignored', '!', '\n' + ignored.join('\n')),
    other && labelled(locale, 'other', '·', other),
    labelled(locale, 'request', '»', draft.user_requirement, 180)].filter(Boolean).join('\n\n')
  const question = { id: 'gxworks-design', header: words.header, detail,
    question: words.ask || shortText(summary, 80) || labels.join(' / '),
    options: [...choices.map((a, i) => ({ label: labels[i],
      description: shortText(a.description || a.generation_guide || '', 90) })),
      { label: words.change || '✎', description: shortText(words.changeHint || '', 90) }] }
  if (locale === 'neutral') delete question.header
  if (choices.length === 1) question.intent = { kind: 'plan-review', approve: labels[0], callId: exec.callId }
  // Ask the facts the draft still needs in the same window, so the answers
  // travel with the draft instead of arriving as an edited requirement.
  const parameterQuestions = requiredParameters.map(row => ({ id: parameterQuestionId(row),
    ...(words.params ? { header: words.params } : {}),
    question: String(row.name || row.id).trim() || String(row.id),
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
  let newlyAnswered = 0
  for (const row of requiredParameters) {
    const value = answerValue(answer, parameterQuestionId(row))
    if (value) {
      parameterAnswers[row.id] = value
      newlyAnswered += 1
    }
  }
  // If the user selected an approach and answered part of the required parameters,
  // ask only the remaining questions without discarding the answers already given.
  while (index >= 0 && !cancelled && newlyAnswered > 0) {
    const remainingQuestions = parameterQuestions.filter((_, i) => !parameterAnswers[requiredParameters[i].id])
    if (!remainingQuestions.length) break
    newlyAnswered = 0
    try {
      const followUp = await askUser.ask({ questions: remainingQuestions, agent: exec.agent, signal: exec.signal })
      for (const row of requiredParameters) {
        if (parameterAnswers[row.id]) continue
        const value = answerValue(followUp, parameterQuestionId(row))
        if (value) {
          parameterAnswers[row.id] = value
          newlyAnswered += 1
        }
      }
    } catch (error) {
      if (error.code !== 'ASK_CANCELLED') throw error
      cancelled = true
    }
  }
  const unanswered = requiredParameters.filter(row => !parameterAnswers[row.id]).map(row => String(row.name || row.id))
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
    revisedRequirements.set(session, [...new Set([...(revisedRequirements.get(session) || []), ...notes])])
    response.next_actions = [{ tool: 'get_design_context', arguments: { user_requirement: requirement } }]
  }
  return { data: response }
}

