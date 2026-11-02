import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseDeepSeekUpstream } from '../dist-server/server/deepSeekDiagnostics.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash'
const result = await diagnoseDeepSeekUpstream({
  apiKey: process.env.DEEPSEEK_API_KEY,
  model,
  timeoutMs: 15_000,
})

const outputDirectory = path.join(root, 'work')
const outputPath = path.join(outputDirectory, 'deepseek-upstream-diagnostic.json')
await mkdir(outputDirectory, { recursive: true })
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

console.log(`DeepSeek upstream diagnostic: ${result.code}`)
console.log(`Model: ${result.model}`)
console.log(`Ready: ${result.ready ? 'yes' : 'no'}`)
console.log('No inference request was sent. Detailed output is in work/deepseek-upstream-diagnostic.json.')

