import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'

const {
  HeuristicTaskAnalyzer,
  MAX_TASK_ANALYSIS_PROMPT_LENGTH,
} = await loadTs('../src/task-analysis/HeuristicTaskAnalyzer.ts')
const { optimizePrompt } = await loadTs('../src/task-analysis/promptOptimizer.ts')
const { planParallelTasks } = await loadTs('../src/task-analysis/parallelPlanner.ts')

const analyzer = new HeuristicTaskAnalyzer()

const analyzeSuccessfully = async (input) => {
  const outcome = await analyzer.analyze(input)
  assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message)
  return outcome.result
}

const assertValidRange = (range) => {
  assert.equal(Number.isInteger(range.min), true)
  assert.equal(Number.isInteger(range.max), true)
  assert.ok(range.min >= 0)
  assert.ok(range.max >= 0)
  assert.ok(range.min <= range.max)
}

test('empty prompt and no files returns EMPTY_INPUT', async () => {
  const outcome = await analyzer.analyze({ prompt: '   ', files: [] })
  assert.deepEqual(outcome.ok ? null : outcome.code, 'EMPTY_INPUT')
})

test('short prompt-only input succeeds with a low general result', async () => {
  const result = await analyzeSuccessfully({ prompt: '整理内容', files: [] })
  assert.equal(result.taskType, 'general')
  assert.equal(result.complexity, 'low')
  assert.ok(result.warnings.some((warning) => warning.includes('仅基于 Prompt')))
  assertValidRange(result.estimatedInputTokens)
  assertValidRange(result.estimatedOutputTokens)
})

test('file-only input succeeds and reports that the prompt is empty', async () => {
  const result = await analyzeSuccessfully({
    prompt: '',
    files: [{ name: 'index.ts', type: 'text/typescript', size: 400 }],
  })
  assert.equal(result.taskType, 'coding')
  assert.deepEqual(result.estimatedInputTokens, { min: 132, max: 264 })
  assert.ok(result.warnings.some((warning) => warning.includes('Prompt 为空')))
})

test('prompt length boundary accepts 8000 characters and rejects 8001', async () => {
  const accepted = await analyzer.analyze({
    prompt: 'a'.repeat(MAX_TASK_ANALYSIS_PROMPT_LENGTH),
    files: [],
  })
  assert.equal(accepted.ok, true)

  const rejected = await analyzer.analyze({
    prompt: 'a'.repeat(MAX_TASK_ANALYSIS_PROMPT_LENGTH + 1),
    files: [],
  })
  assert.deepEqual(rejected.ok ? null : rejected.code, 'INPUT_TOO_LARGE')
})

test('files must be an array at runtime', async () => {
  const outcome = await analyzer.analyze({ prompt: '分析任务', files: null })
  assert.deepEqual(outcome.ok ? null : outcome.code, 'INVALID_FILE')
})

for (const [label, file] of [
  ['empty name', { name: ' ', type: 'text/plain', size: 1 }],
  ['empty MIME type', { name: 'notes.txt', type: '', size: 1 }],
  ['negative size', { name: 'notes.txt', type: 'text/plain', size: -1 }],
  ['NaN size', { name: 'notes.txt', type: 'text/plain', size: Number.NaN }],
  ['infinite size', { name: 'notes.txt', type: 'text/plain', size: Number.POSITIVE_INFINITY }],
]) {
  test(`invalid file metadata is rejected: ${label}`, async () => {
    const outcome = await analyzer.analyze({ prompt: '分析文件', files: [file] })
    assert.deepEqual(outcome.ok ? null : outcome.code, 'INVALID_FILE')
  })
}

for (const [label, file, expectedType, uncertain] of [
  ['code', { name: 'app.tsx', type: 'text/typescript', size: 800 }, 'coding', false],
  ['PDF', { name: 'report.pdf', type: 'application/pdf', size: 800 }, 'analysis', true],
  ['image', { name: 'diagram.png', type: 'image/png', size: 800 }, 'analysis', true],
  ['binary', { name: 'archive.bin', type: 'application/octet-stream', size: 800 }, 'general', true],
]) {
  test(`${label} metadata influences classification and uncertainty`, async () => {
    const result = await analyzeSuccessfully({ prompt: '', files: [file] })
    assert.equal(result.taskType, expectedType)
    assert.equal(
      result.warnings.some((warning) => warning.includes('额外不确定性')),
      uncertain,
    )
    assertValidRange(result.estimatedInputTokens)
  })
}

test('multiple files and operation types produce a mixed high-complexity result', async () => {
  const result = await analyzeSuccessfully({
    prompt: '实现代码，分析报告并测试结果',
    files: [
      { name: 'app.ts', type: 'text/typescript', size: 2_000 },
      { name: 'report.pdf', type: 'application/pdf', size: 2_000 },
      { name: 'diagram.png', type: 'image/png', size: 2_000 },
    ],
  })
  assert.equal(result.taskType, 'mixed')
  assert.equal(result.complexity, 'high')
  assert.equal(result.estimationBasis, 'heuristic-metadata')
  assert.ok(result.assumptions.some((assumption) => assumption.includes('未读取')))
})

test('all successful sample estimates keep non-negative ordered integer ranges', async () => {
  const samples = [
    { prompt: '解释结果', files: [] },
    { prompt: '', files: [{ name: 'a.md', type: 'text/markdown', size: 0 }] },
    { prompt: '测试代码', files: [{ name: 'a.js', type: 'text/javascript', size: 1_000_001 }] },
    { prompt: '分析图片', files: [{ name: 'a.webp', type: 'image/webp', size: 5_000_000 }] },
  ]

  for (const input of samples) {
    const result = await analyzeSuccessfully(input)
    assertValidRange(result.estimatedInputTokens)
    assertValidRange(result.estimatedOutputTokens)
  }
})

test('two numbered tasks are planned in parallel', () => {
  const result = planParallelTasks({
    prompt: '1. 编写接口文档\n2. 检查测试结果',
    files: [],
  })
  assert.equal(result.canRunInParallel, true)
  assert.ok(result.parallelPlan.some((step) => step.includes('统一汇总')))
})

test('explicit independent task markers produce a parallel plan', () => {
  const result = planParallelTasks({
    prompt: '请分别分析日志；撰写报告，两个任务互不依赖',
    files: [],
  })
  assert.equal(result.canRunInParallel, true)
})

test('dependency markers override numbered task parallelism', () => {
  const result = planParallelTasks({
    prompt: '1. 生成数据\n2. 基于前一步完成报告',
    files: [],
  })
  assert.equal(result.canRunInParallel, false)
  assert.ok(result.parallelPlan.some((step) => step.includes('依赖')))
})

test('a prompt without independent-task evidence defaults to serial execution', () => {
  const result = planParallelTasks({ prompt: '修复登录页面问题', files: [] })
  assert.equal(result.canRunInParallel, false)
})

test('prompt optimizer cleans whitespace and lists file metadata', () => {
  const optimized = optimizePrompt('  修复   登录问题\n\n\n\n补充测试  ', {
    taskType: 'coding',
    files: [{ name: 'src/login.ts', type: 'text/typescript', size: 20 }],
  })
  assert.match(optimized, /修复 登录问题\n\n补充测试/)
  assert.match(optimized, /src\/login\.ts（text\/typescript）/)
  assert.match(optimized, /保持原任务范围/)
})

test('empty prompt optimizer output is a fillable template', () => {
  const optimized = optimizePrompt('   ', { taskType: 'general', files: [] })
  assert.match(optimized, /请补充需要完成的具体任务/)
  assert.match(optimized, /未提供文件/)
})

test('unexpected analyzer exceptions return ANALYSIS_FAILED', async () => {
  const throwingInput = new Proxy({}, {
    get() {
      throw new Error('unexpected input failure')
    },
  })
  const outcome = await analyzer.analyze(throwingInput)
  assert.deepEqual(outcome.ok ? null : outcome.code, 'ANALYSIS_FAILED')
})
