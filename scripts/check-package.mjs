// SPDX-License-Identifier: AGPL-3.0

/** Refuse to pack the launcher without the actual backend again. */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { backend, bundledArchiveParts, packageRoot } from '../launch/bundled-runtime.mjs'

try {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (backend.archivePackages?.length !== bundledArchiveParts.length ||
      backend.archivePackages.some(name => manifest.dependencies?.[name] !== backend.version)) {
    throw new Error('后端依赖必须按顺序完整列出并固定版本')
  }
  const sizes = bundledArchiveParts.map(part => statSync(part).size)
  if (!sizes.length || sizes.some(size => size === 0) || sizes.reduce((sum, size) => sum + size, 0) < 1_000_000) {
    throw new Error('后端归档缺失或不完整')
  }
  process.stderr.write(`[dsh-gxworks] 安装时自动获取 ${sizes.length} 个固定版本依赖，包含完整 GXWorks Agent ${backend.version} 后端\n`)
} catch (error) {
  process.stderr.write(`[dsh-gxworks] 不能生成缺少后端的插件包：${error.message}\n`)
  process.exitCode = 1
}
