import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'

const {
  HeuristicTaskAnalyzer,
  MAX_TASK_ANALYSIS_PROMPT_LENGTH,
} = await loadTs('../src/task-analysis/HeuristicTaskAnalyzer.ts')
const { optimizePrompt } = await loadTs('../src/task-analysis/promptOptimizer.ts')
const { planParallelTasks } = await loadTs('../src/task-analysis/parallelPlanner.ts')
const {
  MAX_TASK_ANALYSIS_FILES,
  MAX_TASK_ANALYSIS_FILE_SIZE,
  MAX_TASK_ANALYSIS_TOTAL_SIZE,
  mergeTaskAnalysisFiles,
} = await loadTs('../src/task-analysis/fileSelection.ts')

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

const metadataFile = (name, size = 1, type = 'text/plain') => ({ name, type, size })

test('file selection accepts 20 files and rejects the 21st', () => {
  const files = Array.from(
    { length: MAX_TASK_ANALYSIS_FILES + 1 },
    (_, index) => metadataFile(`file-${index}.txt`),
  )
  const selection = mergeTaskAnalysisFiles([], files)

  assert.equal(selection.files.length, MAX_TASK_ANALYSIS_FILES)
  assert.equal(selection.addedCount, MAX_TASK_ANALYSIS_FILES)
  assert.equal(selection.rejected.fileCount, 1)
})

test('file selection accepts exactly 100 MiB and rejects larger files', () => {
  const selection = mergeTaskAnalysisFiles([], [
    metadataFile('boundary.bin', MAX_TASK_ANALYSIS_FILE_SIZE, 'application/octet-stream'),
    metadataFile('too-large.bin', MAX_TASK_ANALYSIS_FILE_SIZE + 1, 'application/octet-stream'),
  ])

  assert.deepEqual(selection.files.map((file) => file.name), ['boundary.bin'])
  assert.equal(selection.rejected.tooLarge, 1)
  assert.match(selection.notice, /超过 100 MiB/)
})

test('file selection accepts exactly 500 MiB total and rejects overflow', () => {
  const boundaryFiles = Array.from(
    { length: MAX_TASK_ANALYSIS_TOTAL_SIZE / MAX_TASK_ANALYSIS_FILE_SIZE },
    (_, index) => metadataFile(`part-${index}.bin`, MAX_TASK_ANALYSIS_FILE_SIZE, 'application/octet-stream'),
  )
  const selection = mergeTaskAnalysisFiles([], [
    ...boundaryFiles,
    metadataFile('overflow.txt'),
  ])

  assert.equal(selection.files.length, boundaryFiles.length)
  assert.equal(selection.rejected.totalSize, 1)
  assert.match(selection.notice, /超过 500 MiB/)
})

test('file selection detects duplicates against current files', () => {
  const current = [metadataFile('existing.txt', 10)]
  const selection = mergeTaskAnalysisFiles(current, [
    metadataFile('existing.txt', 10),
    metadataFile('new.txt', 10),
  ])

  assert.deepEqual(selection.files.map((file) => file.name), ['existing.txt', 'new.txt'])
  assert.equal(selection.rejected.duplicate, 1)
})

test('file selection detects duplicates inside one incoming batch', () => {
  const duplicate = metadataFile('duplicate.txt', 10)
  const selection = mergeTaskAnalysisFiles([], [duplicate, duplicate])

  assert.equal(selection.files.length, 1)
  assert.equal(selection.rejected.duplicate, 1)
})

test('file selection reports multiple rejection reasons while keeping valid files', () => {
  const current = Array.from(
    { length: MAX_TASK_ANALYSIS_FILES - 1 },
    (_, index) => metadataFile(`current-${index}.txt`),
  )
  const selection = mergeTaskAnalysisFiles(current, [
    metadataFile('current-0.txt'),
    metadataFile('too-large.bin', MAX_TASK_ANALYSIS_FILE_SIZE + 1, 'application/octet-stream'),
    metadataFile('last-valid.txt'),
    metadataFile('over-count.txt'),
  ])

  assert.equal(selection.addedCount, 1)
  assert.equal(selection.rejected.duplicate, 1)
  assert.equal(selection.rejected.tooLarge, 1)
  assert.equal(selection.rejected.fileCount, 1)
  assert.match(selection.notice, /重复文件/)
  assert.match(selection.notice, /数量限制/)
})

test('file selection preserves current and accepted file order', () => {
  const selection = mergeTaskAnalysisFiles(
    [metadataFile('a.txt')],
    [metadataFile('b.txt'), metadataFile('c.txt'), metadataFile('d.txt')],
  )

  assert.deepEqual(selection.files.map((file) => file.name), ['a.txt', 'b.txt', 'c.txt', 'd.txt'])
})

test('file selection preserves an empty MIME type for analyzer validation', () => {
  const selection = mergeTaskAnalysisFiles([], [metadataFile('unknown.data', 10, '')])

  assert.equal(selection.files.length, 1)
  assert.equal(selection.files[0].type, '')
  assert.equal(selection.addedCount, 1)
})
