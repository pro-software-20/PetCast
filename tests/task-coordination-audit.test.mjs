import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  appendTaskCoordinationAuditEvent,
  createEmptyTaskCoordinationAuditState,
  validateTaskCoordinationAuditState,
  MAX_TASK_COORDINATION_AUDIT_EVENTS,
} = await loadTs('../src/orchestration/taskCoordinationAudit.ts')
const {
  MemoryTaskCoordinationAuditStore,
  LocalTaskCoordinationAuditStore,
  TASK_COORDINATION_AUDIT_STORAGE_KEY,
} = await loadTs('../src/orchestration/TaskCoordinationAuditStore.ts')
const { generateTaskCoordinationAuditExport } = await loadTs('../src/orchestration/taskCoordinationAuditReport.ts')

const context = { sessionId: 'session-audit', planId: 'plan-audit', taskIds: ['task-one', 'task-two'] }
const now = new Date('2026-11-15T08:00:00.000Z')
const event = (summary = '用户确认启动自动协调。') => ({
  type: 'coordination-started', level: 'info', summary, taskId: 'task-one', providerId: 'codex', dispatchId: 'dispatch-safe', attempt: 0,
})

test('audit state stores only safe current-session events and is idempotent', () => {
  const initial = createEmptyTaskCoordinationAuditState(context, now)
  const first = appendTaskCoordinationAuditEvent(initial, context, event(), now)
  assert.equal(first.ok, true)
  assert.equal(first.state.events.length, 1)
  const duplicate = appendTaskCoordinationAuditEvent(first.state, context, { ...event(), id: first.state.events[0].id }, now)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.added, false)
  assert.deepEqual(initial.events, [])
})

test('audit validation rejects sensitive text, unknown fields, foreign tasks and excess events', () => {
  const state = createEmptyTaskCoordinationAuditState(context, now)
  const unsafe = appendTaskCoordinationAuditEvent(state, context, event('Authorization: bearer secret'), now)
  assert.equal(unsafe.ok, false)
  const invalid = validateTaskCoordinationAuditState({ ...state, surprise: true }, context)
  assert.equal(invalid.ok, false)
  const foreign = appendTaskCoordinationAuditEvent(state, context, { ...event(), taskId: 'other-task' }, now)
  assert.equal(foreign.ok, false)
  const excess = { ...state, events: Array.from({ length: MAX_TASK_COORDINATION_AUDIT_EVENTS + 1 }, (_, index) => ({
    id: `audit-${index}`, type: 'notice', level: 'info', occurredAt: now.toISOString(), summary: '安全提示。',
  })) }
  assert.equal(validateTaskCoordinationAuditState(excess, context).ok, false)
})

test('memory and local audit stores preserve corruption and export remains sanitised', async () => {
  const appended = appendTaskCoordinationAuditEvent(null, context, event(), now)
  assert.equal(appended.ok, true)
  const memory = new MemoryTaskCoordinationAuditStore()
  assert.equal((await memory.save(appended.state)).ok, true)
  assert.equal((await memory.load(context)).state.events.length, 1)
  const exported = generateTaskCoordinationAuditExport(appended.state)
  assert.match(exported.markdown, /协调审计记录/)
  assert.doesNotMatch(exported.json, /Authorization|secret|C:\\Users/i)
  const map = new Map([[TASK_COORDINATION_AUDIT_STORAGE_KEY, '{broken']])
  const local = new LocalTaskCoordinationAuditStore({
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key),
  })
  const corrupted = await local.load(context)
  assert.equal(corrupted.ok, false)
  assert.equal(map.get(TASK_COORDINATION_AUDIT_STORAGE_KEY), '{broken')
})

test('a valid audit record from an earlier session is treated as stale current-session history', async () => {
  const first = appendTaskCoordinationAuditEvent(null, context, event(), now)
  assert.equal(first.ok, true)
  const memory = new MemoryTaskCoordinationAuditStore(first.state)
  const next = await memory.load({ sessionId: 'session-next', planId: 'plan-next', taskIds: ['task-next'] })
  assert.equal(next.ok, true)
  assert.equal(next.state, null)
  assert.deepEqual(memory.peek(), first.state)
})
