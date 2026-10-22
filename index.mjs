/**
 * dsh-gxworks 的 Host 半边。
 *
 * 这个 bundle 的主体是 `cordis.patch.yml`：它插入 `@deepseek-ai/dsh-mcp-client`（以 stdio 启动本机
 * GXWorks Agent MCP）与 `@deepseek-ai/dsh-skill-filesystem`（注册本包自带的 gxworks-mcp-router 技能）。
 *
 * 本模块不接管那两个行，只做一件安装完整性检查：确认包内确实带着 launcher 与技能目录。
 * 缺文件时（例如安装形态丢了 `files` 里的条目）在启动日志里直接告警，而不是等到第一次调工具才失败。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名，与包名一致：patch 覆盖时按它定位。 */
export const name = 'dsh-gxworks'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const required = ['launch/mcp-launch.mjs', 'skills']

/**
 * 校验安装形态。
 * @param ctx Cordis 上下文；只用到可选的 logger，缺失时静默通过。
 */
export function apply(ctx) {
  const logger = ctx?.logger?.('dsh-gxworks')
  const missing = required.filter(relative => !existsSync(join(packageRoot, relative)))
  if (missing.length > 0) {
    logger?.warn?.(`dsh-gxworks: 安装包缺少 ${missing.join('、')}，MCP 工具与技能不可用；请重新安装本包`)
    return
  }
  logger?.debug?.('dsh-gxworks: launcher 与 skills 就位')
}
