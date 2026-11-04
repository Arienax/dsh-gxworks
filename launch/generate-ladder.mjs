// The local MCP owns engineering facts and validation. Desktop owns its model.
export const generatorName = 'gxworks_generate_ladder'

export function humanTexts(session) {
  return session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'user')
    .map(e => e.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).filter(Boolean)
}

export function explicitDirect(text = '') {
  return /(?:^|[\n。！？；，,.!;]\s*)(?:请|请你|这次|本次)?\s*(?:直接(?:帮我)?生成|跳过(?:方案|设计)确认|使用\s*direct\s*模式|(?:use\s+)?direct\s+(?:mode|generation)|\/gxworks-direct)(?:[\s，。,.!！]|程序|梯形图|$)/iu.test(text)
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
    if (Array.isArray(value) && (key === 'facts' || key === 'aspects') && path.startsWith('#/instruction_research/manual/')) {
      value = manualTable(value)
    }
    if (Array.isArray(value)) return value.map((item, i) => pack(item, path + '/' + i))
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, pack(v, path + '/' + k.replaceAll('~', '~0').replaceAll('/', '~1'), k)]))
  }
  return JSON.stringify(pack(packet, '#'))
}

const manualFormat = '手册表格中的 rows 按 columns 顺序取值，每行继承 common，并补上 extra_fields_by_row 的同序号字段。'
const selection = '按同一组工艺条件比较至少两种整体实现。区分题目要求与实现假设，估算各自的步数增长、状态和资源。未规定的容量、精度、互斥或排队条件不能作为排除另一种算法的理由。当同一段逻辑随元素或通道重复时，比较逐项展开和利用本 CPU 成组操作的整体方案，说明数据怎样表示、怎样更新、并发与复位怎样保持。优先采用能直接表达工艺、减少重复且满足原始行为的型号指令。资料缺项说明对选择的影响。'

// The Web wire uses short keys. Spell out the same fields in the provider's tool schema.
const ladderFields = { r: 'networks', c: 'shared_contacts', b: 'output_branches', i: 'series_contacts', o: 'outputs' }
const fieldHelp = {
  shared_contacts: 'Executable contacts shared by every branch. Use [] or strings such as NO X0, NC M0, >= D0 K1. Never put a title here.',
  series_contacts: 'Additional contacts in series. Use NO, NC, P, F and an address, or a prefix comparison. For parallel paths use {"or":[["NO X0"],["NO M0"]]}.',
  outputs: 'Coils use COIL Y0. Timers use TIMER T0 K10. Applications use an actual opcode and space-separated operands. Each entry is one executable instruction.',
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

function submissionTool(tools, agent, ladderSchema, research) {
  const { families } = research
  const review = tools.get('mcp__gxworks__create_program_candidate', agent).parameters.properties.implementation_review
  const { selected, alternatives, limitations } = review.properties
  const groups = {}
  for (const [family, names] of Object.entries(families)) {
    for (const key of family === 'explicit' ? names : [family]) {
      const allowed = family === 'explicit' ? [key] : names
      groups[key] = { type: 'object', required: ['instruction', 'tradeoff'], properties: {
        instruction: { type: 'string', enum: allowed }, tradeoff: { type: 'string', minLength: 1,
          description: 'Explain how this instruction fits or falls short in this project.' } } }
    }
  }
  const comparisons = { type: 'object', additionalProperties: false, properties: groups, required: Object.keys(groups) }
  return { name: 'submit_ladder', description: '提交当前方案的选型与完整程序。按参数字段名填写，每条梯级的触点和输出只写可执行表达式。',
    parameters: { type: 'object', additionalProperties: false, required: ['implementation_review', 'ladder'],
      properties: { implementation_review: { type: 'object', additionalProperties: false,
        required: ['selected', 'alternatives', ...(Object.keys(groups).length ? ['compared_families'] : []),
          ...(research.manual?.coverage?.status === 'incomplete' ? ['limitations'] : [])],
        properties: { selected, alternatives, limitations, compared_families: comparisons } }, ladder: modelLadderSchema(ladderSchema) } } }
}

function wireReview(value) {
  const { selected, alternatives = [], compared_families = {} } = value
  const limitations = value.limitations || (typeof compared_families.limitations === 'string' ? compared_families.limitations : undefined)
  const comparisons = Object.values(compared_families).filter(row => row && typeof row.instruction === 'string'
    && typeof row.tradeoff === 'string').map(row => ({ method: row.instruction, tradeoff: row.tradeoff }))
  const methods = alternatives.map(({ method, tradeoff, note }) => ({ method,
    tradeoff: note && typeof note === 'string' ? [tradeoff, note].filter(Boolean).join(' ') : tradeoff }))
  return { selected, alternatives: [...methods, ...comparisons], ...(limitations ? { limitations } : {}) }
}

async function modelResponse(llm, exec, system, input, metrics, stage, submission) {
  const config = exec.agent.session.requestHeader()?.config
  if (!config?.model || !config?.provider) throw Error('当前会话没有已选模型。')
  const started = Date.now(), blocks = new Map()
  let finish, usage
  const calls = new Map()
  const task = stage === 'design'
    ? '当前只做规格设计。原始需求是下面资料中的 request 字段。根据型号和工艺比较有实质差异的方案；调用 submit_design_plan 提交草稿供用户选择。'
    : '现在按证据选择可维护的实现并生成完整程序。下面 request 是工艺输入；请按 submit_ladder 的字段提交实际比较和 Web 格式的程序。'
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
  const draft = calls.size ? [...calls.values()].map(call => call.arguments).join('\n') : [...blocks.values()].join('').trim()
  if (calls.size && (calls.size !== 1 || [...calls.values()][0].name !== submission?.name)) {
    return { error: '模型未返回唯一的 ' + submission?.name + ' 提交。', draft }
  }
  try {
    return { value: JSON.parse(draft.replace(/^\x60{3}(?:json)?\s*\n([\s\S]*)\n\x60{3}$/i, '$1')) }
  } catch {
    return { error: '模型提交的内容不是有效 JSON。', draft }
  }
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
    async execute(args, exec) {
      if (!exec.agent) throw Error('需要当前 Desktop 会话。')
      let calls = 0
      async function invoke(tool, input) {
        const result = await tools.execute({ name: 'mcp__gxworks__' + tool, arguments: input,
          callId: exec.callId + '-gx-' + (++calls), rootCallId: exec.rootCallId || exec.callId,
          parent: exec.token, signal: exec.signal, agent: exec.agent })
        for (const extra of result.additionalContexts || []) exec.deferContext(extra)
        if (result.isError) throw Error(tool + '：' + result.error.message)
        const body = result.value.structuredContent || JSON.parse(result.value.content[0].text)
        if (!body.ok) throw Error(tool + '：' + JSON.stringify(body.error))
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
      if (args.stage === 'design' && !project.has_confirmed_spec) {
        const { content: design } = await readDocument(invoke, 'get_design_context', {
          user_requirement: raw, instruction_details: true })
        const input = contextText({ request: raw, knowledge: design.knowledge, instruction_research: design.instruction_research })
        if (!design.analysis_schema?.properties?.approaches) throw Error('后端未交付 Web Design 草稿结构。')
        const submission = { name: 'submit_design_plan', parameters: design.analysis_schema,
          description: '按 Web Design 结构提交规格草稿。把工艺事实与备选实现分开，证据须逐字来自用户。' }
        const analysis = await modelResponse(llm, exec, [design.analysis_instructions, manualFormat, selection].join('\n'), input, metrics, 'design', submission)
        if (analysis.error) return { status: 'repair_required', error: analysis.error, draft: analysis.draft,
          project_id: project.project_id, analysis_id: design.analysis_id, model_calls: metrics.length, metrics,
          next_actions: [{ tool: 'propose_design_plan', instruction: '整理返回的草稿，沿用 analysis_id 提交。' }] }
        const proposal = await invoke('propose_design_plan', { analysis_id: design.analysis_id, analysis: analysis.value })
        if (!proposal.approved) return { project_id: project.project_id, model_calls: metrics.length, metrics, proposal,
          ...(proposal.status ? { status: proposal.status, next_actions: proposal.next_actions } : {}) }
        const confirm = proposal.next_actions?.find(action => action.tool === 'confirm_design_plan')
        if (!confirm) throw Error('缺少当前用户已选择的设计方案。')
        const saved = await invoke('confirm_design_plan', confirm.arguments)
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
      const submit = submissionTool(tools, exec.agent, output_schema, research)
      const input = contextText({ ...engineering, instruction_research: research, request })
      const system = [
        '只调用 submit_ladder。其参数 schema 是本次唯一返回格式；以下 Web 程序协议仅定义该工具的 ladder 字段。',
        '<ladder_field>', doc.generation_instructions, '</ladder_field>', manualFormat,
        contextArgs.workflow === 'detailed' ? '已确认的结构是实施输入。只比较在该结构内如何实现各功能，不再重选总体方案。' : selection,
        '提交前按实际扫描顺序，用一组能区分实现优劣的输入走读将提交的网络。若程序依赖用户未声明的前提，修正实现或在 limitations 说明影响。',
        '工具中的 networks / shared_contacts / output_branches / series_contacts / outputs 分别承载 Web 的 r / c / b / i / o。所有网络没有标题字段。',
        '先在 implementation_review 比较各功能组的代表指令和普通实现，写出名称、行为、资源代价及资料缺项。然后填写 ladder。c 和 i 都是触点表达式，说明文字只写在注释或决策中。',
      ].join('\n')
      const response = await modelResponse(llm, exec, system, input, metrics, 'generate', submit)
      const reply = response.value
      // Some tool adapters close the review one field late. A sole nested program can still be submitted verbatim.
      if (reply && !reply.ladder && reply.implementation_review?.ladder) reply.ladder = reply.implementation_review.ladder
      const recover = (error, draft) => ({ status: 'repair_required', project_id: project.project_id,
        error, draft, model_calls: metrics.length, metrics, next_actions: [{ tool: 'create_program_candidate',
          arguments: { generation_context_id: doc.generation_context_id },
          instruction: '就地修正已返回的程序或补齐选型比较，沿用这次读取的工程与手册。' }],
        context_document: id, manual_documents: [] })
      if (response.error) return recover(response.error, response.draft)
      if (!reply?.ladder || !reply.implementation_review) return recover('生成响应缺少 ladder 或 implementation_review。', reply)
      let implementation
      try { implementation = wireReview(reply.implementation_review) }
      catch (error) { return recover(String(error.message), reply) }
      const review = { ...implementation, context_document: id, manual_documents: [] }
      if (!review.limitations?.trim()) delete review.limitations
      let candidate, program
      try { program = wireLadder(reply.ladder) }
      catch (error) { return recover(String(error.message), reply) }
      try {
        candidate = await invoke('create_program_candidate', { ladder: program,
          generation_context_id: doc.generation_context_id, implementation_review: review })
      } catch (error) {
        if (exec.signal?.aborted) throw error
        const state = await invoke('get_current_project', {})
        if (state.project_id !== args.project_id || state.version_count) return {
          status: 'inspect_saved_result', project_id: args.project_id, model_calls: metrics.length, metrics,
          error: String(error.message), next_actions: [{ tool: 'list_projects' }] }
        return recover(String(error.message), { ladder: program, implementation_review: implementation })
      }
      return { project_id: project.project_id, workflow: doc.workflow_mode, model_calls: metrics.length, metrics,
        context_pages: pages, implementation_review: implementation, candidate,
        ...(candidate.save_result?.status === 'saved_native_diagnostic' ? { status: 'native_validation_failed',
          version_id: candidate.version_id, diagnostics: candidate.validation } : {}) }
    },
  })
}
