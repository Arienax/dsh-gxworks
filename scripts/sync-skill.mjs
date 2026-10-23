#!/usr/bin/env node
/**
 * Refresh `skills/gxworks-mcp-router/` from a GXWorks Agent checkout.
 *
 * The skill is authored upstream in Arienax/gxworks-agent, which republishes it
 * with the source repository and the MCP release packages. This bundle keeps a
 * verbatim copy so a profile install needs no second checkout; run this script
 * after pulling the upstream skill and review the diff before committing.
 *
 * Usage: node scripts/sync-skill.mjs [--source <gxworks-agent checkout>]
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'gxworks-mcp-router'
const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

function argument(name, argv) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个目录参数。`)
  return value
}

const argv = process.argv.slice(2)
const source =
  argument('--source', argv) ??
  process.env.GXWORKS_AGENT_ROOT ??
  process.env.GXWORKS_AGENT_HOME ??
  resolve(PACKAGE_ROOT, '..', 'gxworks-agent')

const from = join(resolve(source), 'skills', SKILL_NAME)
if (!existsSync(join(from, 'SKILL.md'))) {
  console.error(`[dsh-gxworks] 找不到上游技能：${from}`)
  console.error('用法：node scripts/sync-skill.mjs --source <GXWORKS_AGENT_DIR>')
  process.exit(2)
}

const destination = join(PACKAGE_ROOT, 'skills', SKILL_NAME)
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(from, destination, { recursive: true })

// Provenance note kept next to the copy so the package explains itself offline.
const header = await readFile(join(destination, 'SKILL.md'), 'utf8')
const version = /^  version: '?(?<version>[^'\n]+)'?$/m.exec(header)?.groups?.version ?? 'unknown'
const commit = /^  source-commit: (?<commit>\S+)$/m.exec(header)?.groups?.commit ?? 'unknown'
await writeFile(
  join(destination, 'COPYING.md'),
  [
    `# ${SKILL_NAME} — 来源说明`,
    '',
    '本目录是 `Arienax/gxworks-agent` 中同名技能的原样副本，随本插件分发，便于一次安装即带齐 MCP 工具选型说明。',
    '',
    `- 上游仓库：https://github.com/Arienax/gxworks-agent`,
    `- 技能版本：${version}`,
    `- 同步自提交：${commit}`,
    `- 上游路径：\`skills/${SKILL_NAME}/\``,
    `- 许可：Apache-2.0（见本包 LICENSE）`,
    '',
    '上游技能变更后，在本包根目录执行 `npm run sync-skill` 重新同步并复核差异。',
    '',
  ].join('\n'),
  'utf8',
)

console.log(`[dsh-gxworks] 已同步 ${SKILL_NAME}（${version} @ ${commit}）→ ${destination}`)
