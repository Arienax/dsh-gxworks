// SPDX-License-Identifier: AGPL-3.0

/** Prepare independent npm packages from the unchanged release archive parts. */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = process.argv[2]
if (!output || !isAbsolute(output)) throw new Error('Pass an absolute output directory outside the repository.')
const relativeOutput = relative(root, output)
if (!isAbsolute(relativeOutput) && relativeOutput !== '..' && !relativeOutput.startsWith(`..${sep}`)) {
  throw new Error('Runtime packages must be prepared outside the repository.')
}
const backend = JSON.parse(await readFile(join(root, 'runtime', 'backend.json'), 'utf8'))
const plugin = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (backend.archivePackages?.length !== backend.archiveParts.length) throw new Error('Runtime package list is incomplete.')
await mkdir(output, { recursive: true })
for (const [index, name] of backend.archivePackages.entries()) {
  if (plugin.dependencies[name] !== backend.version) throw new Error(`Unpinned runtime dependency: ${name}`)
  const file = backend.archiveParts[index]
  const source = join(root, 'runtime', file)
  const size = (await stat(source)).size
  if (size === 0 || size > 64 * 1024 * 1024) throw new Error(`Unexpected part size: ${file}`)
  const target = join(output, name.split('/').at(-1))
  await mkdir(target)
  await copyFile(source, join(target, file))
  await copyFile(join(root, 'LICENSE'), join(target, 'LICENSE'))
  await writeFile(join(target, 'package.json'), JSON.stringify({
    name, version: backend.version,
    description: `GXWorks Agent MCP ${backend.version} runtime archive part ${index + 1}/${backend.archiveParts.length} for dsh-gxworks.`,
    license: 'AGPL-3.0', author: plugin.author, repository: plugin.repository,
    homepage: plugin.homepage, files: [file, 'LICENSE', 'README.md'],
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
  }, null, 2) + '\n')
  await writeFile(join(target, 'README.md'), `# ${name}\n\n` +
    `Runtime archive part ${index + 1}/${backend.archiveParts.length} for dsh-gxworks ${plugin.version}. ` +
    'Install dsh-gxworks; its exact-version dependencies install all parts automatically from your npm registry. ' +
    'The launcher assembles the complete backend locally without downloading from GitHub.\n\n' +
    `This file is an unchanged part of GXWorks Agent MCP ${backend.version}. ` +
    `Corresponding source: [GXWorks Agent](${backend.repository}/tree/${backend.sourceCommit}). ` +
    'Licensed under AGPL-3.0; all upstream and third-party notices remain inside the assembled archive.\n')
  process.stdout.write(`${target}\n`)
}
