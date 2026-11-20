import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { loadTs } from './load-ts.mjs'
const { CodexAppServerSession } = await loadTs('../electron/codexAppServer.ts')

function makeSession(events) {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => true
  const messages = []
  const send = value => child.stdout.write(JSON.stringify(value) + '\n')
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line)
      if (!request.id) continue
      let result = {}
      if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'fixture@example.test' } }
      if (request.method === 'thread/start') result = { thread: { id: 'thread-1', model: 'fixture' } }
      if (request.method === 'turn/start') {
        result = { turn: { id: 'turn-1' } }
        // Deliberately notify before the turn/start reply: the client must not hang.
        for (const event of events) send(event)
      }
      send({ id: request.id, result })
    }
  })
  return { messages, session: new CodexAppServerSession('C:/fixture', { hashAccount: async () => 'scope' }, message => messages.push(message), () => child, async () => ({ executable: 'fake' })) }
}

test('Codex terminal error before turn/start reply rejects promptly and never exposes raw error details', async () => {
  const { session, messages } = makeSession([{ method: 'error', params: { willRetry: false, error: { message: 'secret-token C:/private', codexErrorInfo: 'unauthorized' } } }])
  await session.prepare('scope')
  await assert.rejects(session.run('fixture', 100), error => error.code === 'PROVIDER_FAILED')
  assert.match(messages.join(' '), /登录已失效/)
  assert.doesNotMatch(messages.join(' '), /secret-token|C:\/private/)
  session.close()
})

test('Codex retry remains active and final authoritative reply excludes commentary', async () => {
  const { session, messages } = makeSession([
    { method: 'error', params: { willRetry: true, error: { codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } } } } },
    { method: 'item/agentMessage/delta', params: { delta: '我先分析一下' } },
    { method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'commentary', text: '我先分析一下' } } },
    { method: 'item/agentMessage/delta', params: { delta: '{"plan":{}}' } },
    { method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: '{"plan":{}}' } } },
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ])
  await session.prepare('scope')
  const result = await session.run('fixture', 100)
  assert.equal(result.outputText, '{"plan":{}}')
  assert.match(messages.join(' '), /连接中断.*重试/)
  session.close()
})
