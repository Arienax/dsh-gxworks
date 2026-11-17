// SPDX-License-Identifier: AGPL-3.0

/** Refuse to pack the launcher without the actual backend again. */
import { statSync } from 'node:fs'
import { backend, bundledArchiveParts } from '../launch/bundled-runtime.mjs'

try {
  const sizes = bundledArchiveParts.map(part => statSync(part).size)
  if (!sizes.length || sizes.some(size => size === 0) || sizes.reduce((sum, size) => sum + size, 0) < 1_000_000) {
    throw new Error('后端归档缺失或不完整')
  }
  process.stderr.write(`[dsh-gxworks] 打包包含 GXWorks Agent ${backend.version} Windows x64 后端\n`)
} catch (error) {
  process.stderr.write(`[dsh-gxworks] 不能生成缺少后端的插件包：${error.message}\n`)
  process.exitCode = 1
}
