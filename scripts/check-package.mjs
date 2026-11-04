/** Refuse to pack the launcher without the actual backend again. */
import { statSync } from 'node:fs'
import { backend, bundledArchive } from '../launch/bundled-runtime.mjs'

try {
  if (statSync(bundledArchive).size < 1_000_000) throw new Error('后端归档缺失或不完整')
  process.stderr.write(`[dsh-gxworks] 打包包含 GXWorks Agent ${backend.version} Windows x64 后端\n`)
} catch (error) {
  process.stderr.write(`[dsh-gxworks] 不能生成缺少后端的插件包：${error.message}\n`)
  process.exitCode = 1
}
