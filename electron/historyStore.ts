import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendHistory, parseHistoryDocument, pruneHistory, sameScope, selectHistory, validateHistoryQuery, validateHistorySample, validateHistoryScope, type HistorySample } from './historySchema.js'

/** A single instance owns this independent file. Failed reads never become an empty save. */
export class FileUsageHistoryStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string, private readonly now = Date.now) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }
  private async read(): Promise<HistorySample[]> {
    try {
      if ((await fs.stat(this.file)).size > 128 * 1024 * 1024) throw Error('历史文件过大')
      return parseHistoryDocument(await fs.readFile(this.file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw Error('历史文件读取失败，原文件已保留；请检查文件或权限后重试')
    }
  }
  private async write(samples: HistorySample[]) {
    const raw = JSON.stringify({ version: 1, samples })
    if (Buffer.byteLength(raw)>128*1024*1024) throw Error('历史文件超过容量，原数据保留')
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, this.file)
    } finally { await fs.unlink(temporary).catch(() => undefined) }
  }
  appendUsageSample(input: unknown): Promise<void> {
    return this.serial(async () => { const sample = validateHistorySample(input); await this.write(appendHistory(await this.read(), sample, this.now())) })
  }
  queryUsageSamples(input: unknown): Promise<HistorySample[]> {
    return this.serial(async () => selectHistory(await this.read(), validateHistoryQuery(input), this.now()))
  }
  clearUsageHistory(input: unknown): Promise<void> {
    return this.serial(async () => { const scope = validateHistoryScope(input); await this.write(pruneHistory(await this.read(), this.now()).filter(s => !sameScope(s, scope))) })
  }
}
