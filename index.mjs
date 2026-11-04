import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名，与包名一致：patch 覆盖时按它定位。 */
export const name = 'dsh-gxworks'

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
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!exec.agent || !exec.name.startsWith('mcp__gxworks__')) return next()
    const tool = exec.name.slice('mcp__gxworks__'.length)
    const args = exec.arguments
    if (tool === 'get_generation_context' && args.user_requirement &&
        !quotesUserMessages(args.user_requirement, exec.agent.session.snapshotEvents())) {
      return { kind: 'deny', reason: 'user_requirement 请逐字复制完整用户消息，多轮原文可按顺序换行拼接。模型提出的指令、容量与内部地址只写入 implementation_review。' }
    }
    if ((tool === 'create_program_candidate' || (['create_st_candidate', 'create_fbd_candidate',
        'create_sfc_candidate'].includes(tool) && args.operation === 'generate')) && !args.implementation_review) {
      return { kind: 'deny', reason: '请先用用户原文取得生成上下文，按实际 CPU 查证相关指令并完成全部分页，比较后附上 implementation_review。' }
    }
    return next()
  })
  logger?.debug?.('dsh-gxworks: 内置后端、launcher 与 skills 就位')
}
