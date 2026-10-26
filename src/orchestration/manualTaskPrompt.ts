import type { ProviderId, TaskExecutionResult, TaskNode, TaskPlan } from '../types/taskOrchestration'

const providerNames: Record<string, string> = {
  local: '本地人工流程',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  doubao: '豆包',
}

const providerInstructions: Record<string, string[]> = {
  codex: [
    '先检查上下文和文件权限，再提出或执行最小范围修改。',
    '返回修改文件、关键 diff 和实际运行的验证命令；未授权写入时先询问用户。',
  ],
  deepseek: [
    '使用结构化方式说明分析过程，区分事实、推断和不确定信息。',
    '不要声称已经读取未提供的文件或执行未提供的工具。',
  ],
  doubao: [
    '使用清晰自然的中文组织结果，保持目标、结构和语气一致。',
    '涉及事实、数据或引用时不要编造，并标出需要人工核验的内容。',
  ],
  local: [
    '将以下内容作为人工执行清单，逐项完成并记录结果。',
    '遇到信息或权限不足时先暂停，并向用户确认。',
  ],
}

const formatInput = (input: TaskNode['files']['inputs']) => {
  if (input.length === 0) return ['- 未提供输入文件。']
  return input.map((file) => file.kind === 'workspace'
    ? `- 工作区文件：${file.path}`
    : `- 附件：${file.name}（${file.type}，${file.size} 字节；仅有元信息，请由用户另行提供内容）`)
}

const formatPaths = (paths: string[], emptyMessage: string) => (
  paths.length > 0 ? paths.map((path) => `- ${path}`) : [`- ${emptyMessage}`]
)

export function buildManualTaskPrompt(
  task: TaskNode,
  plan: TaskPlan,
  providerId: ProviderId,
  dependencyResults: TaskExecutionResult[] = [],
  additionalReadPaths: string[] = [],
): string {
  const providerName = providerNames[providerId] ?? providerId
  const dependencyNames = task.dependsOn.map((dependencyId) => (
    plan.tasks.find((candidate) => candidate.id === dependencyId)?.title ?? dependencyId
  ))
  const instructions = providerInstructions[providerId] ?? providerInstructions.deepseek
  const readPaths = [...new Set([...(task.files.readPaths ?? []), ...additionalReadPaths])]
  const dependencyContext = dependencyResults.flatMap((result) => {
    const handoff = result.handoff
    return [
      `### ${result.taskId}`,
      `- 已验收摘要：${handoff?.summary ?? result.summary}`,
      ...(handoff?.keyDecisions.length
        ? ['- 关键决策：', ...handoff.keyDecisions.map(item => `  - ${item}`)]
        : ['- 关键决策：无额外记录。']),
      '- 验证结果：',
      ...result.verification.map(item => `  - ${item.label}：${item.status}${item.details ? `（${item.details}）` : ''}`),
      ...(handoff?.artifacts.length
        ? ['- 交接文件：', ...handoff.artifacts.map(artifact => `  - ${artifact.path}：${artifact.description}`)]
        : ['- 交接文件：无。']),
      ...(handoff?.openQuestions.length
        ? ['- 遗留问题：', ...handoff.openQuestions.map(item => `  - ${item}`)]
        : ['- 遗留问题：无。']),
    ]
  })
  const requiredArtifacts = dependencyResults.flatMap(result => result.handoff?.artifacts ?? [])

  return [
    `执行角色：${providerName}`,
    `总体目标：${plan.goal}`,
    `工作区：${plan.workspace?.displayName ?? '未选择工作区'}`,
    '',
    `当前任务：${task.title}`,
    task.description,
    '',
    '具体要求：',
    task.prompt,
    '',
    '前置依赖：',
    ...(dependencyNames.length > 0
      ? dependencyNames.map((dependency) => `- 等待“${dependency}”完成，并使用其已确认结果。`)
      : ['- 无，可以立即开始。']),
    ...(dependencyResults.length > 0 ? [
      '',
      '已验收的前置任务交接：',
      ...dependencyContext,
      '',
      '需要同时提供或确保可读取的交接文件：',
      ...(requiredArtifacts.length
        ? requiredArtifacts.map(artifact => `- ${artifact.path}`)
        : ['- 无。']),
      '- 使用外部 AI 时，请由用户同时提供上述文件；使用本机 Codex 时，只能从已授权工作区读取。',
    ] : []),
    '',
    '输入文件：',
    ...formatInput(task.files.inputs),
    '',
    '允许读取的工作区位置：',
    ...formatPaths(readPaths, '未授权读取工作区路径；如需读取，请先向用户确认。'),
    '',
    '允许修改的工作区位置：',
    ...formatPaths(task.files.allowedWritePaths, '未授权直接修改工作区文件；如需修改，请先向用户确认具体路径。'),
    '',
    '禁止修改的位置：',
    ...formatPaths(task.files.forbiddenPaths, '未指定额外禁止路径，但不得超出允许修改范围。'),
    '',
    '输出位置：',
    ...formatPaths(task.files.outputPaths, '未指定输出位置；创建文件前请先向用户确认。'),
    '',
    '应交付：',
    ...task.expectedDeliverables.map((deliverable) => `- ${deliverable}`),
    '',
    '验收标准：',
    ...task.acceptanceChecks.map((check) => `- ${check}`),
    '',
    '针对当前 AI 的执行注意事项：',
    ...instructions.map((instruction) => `- ${instruction}`),
    '',
    '完成后请先给出结果摘要，再列出实际完成内容、验证情况、限制和仍需人工确认的问题。',
  ].join('\n')
}
