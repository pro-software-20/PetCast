# D 任务账本：给 B / 执行器的接入说明

本文件说明已经实现的接口。当前 main 的 TaskAnalysisResult 只是分析估计，没有真实调用。不要把 estimatedInputTokens / estimatedOutputTokens 写成实际 Token。桌宠不会从 Codex 的额度百分比反推某个任务的用量或费用。

## 推荐接入方式

```ts
import { createTaskLedger } from '../history/TaskLedger'
import { TaskExecutionRecorder } from '../history/TaskExecutionRecorder'

// scope 来自 A 当前已确认的用户账号作用域，不填写开发者固定账号。
const ledger = createTaskLedger(window.petcast)
const run = new TaskExecutionRecorder(ledger, {
  ...scope, id: crypto.randomUUID(), label: '整理资料', category: 'summarize',
})
let status: 'succeeded' | 'failed' = 'succeeded'
try {
  const result = await run.call({
    id: crypto.randomUUID(), provider: '实际服务商', model: '实际模型 ID', attempt: 1,
  }, async () => {
    const response = await yourActualProviderCall() // B / 执行器自己的实现
    return {
      value: response.result,
      // 将对应服务商真实响应规范化；拿不到就返回 null。
      // usage.inputTokens 必须包含缓存输入，cachedInputTokens 是其中的子集。
      usage: normalizeProviderUsage(response),
      cost: normalizeProviderCost(response),
    }
  })
  // result 交给任务业务，报告不保存正文。
} catch (error) {
  status = 'failed'
  // 按任务业务处理原始错误；不要把凭据或完整响应写入日志。
} finally {
  await run.finish(status)
}
```

示例中的 yourActualProviderCall / normalizeProviderUsage / normalizeProviderCost 是执行器待接入函数，并非已经接好的供应商 SDK。可直接使用 `recordCompletedTask(ledger, record)` 接收已有执行器的完整记录。执行过程中可并行使用 run.call，每次调用必须有唯一 ID；相同子任务的重试递增 attempt。所有实际计费尝试都应记录，不只记录最终成功结果。

run.call 自动记录开始 / 结束时刻和成功 / 失败。调用抛错时保留失败调用，因无法从任意异常猜出服务商用量，其 usage / cost 为 null。如果服务商错误响应仍带有账单用量，执行器应使用完整 TaskRecord 接口保存实际计量。

v4.1 边界修复：每任务 1000 次调用在发起 operation 前检查，正在执行的调用也占名额。元信息与计量均复制，避免调用方后续修改影响账本。响应的计量若不合法，run.call 抛出带 code=TASK_MEASUREMENT_INVALID 的 TaskMeasurementError；服务商调用本身已完成，其调用状态仍为 succeeded，usage / cost 置为 null，随后仍可 finish 保存。执行器应单独识别此错误，修正计量接入，不能当作网络失败自动重跑收费调用；业务结果是否可用由执行器判断。存储提交使用副本，写入失败不会改坏内部重试记录。

finish 前不能有未完成调用。存储失败时 run 内保留相同最终记录；重试 `finish(status)` 不重复调用 AI、不改变结束时间。v6 已加入调用前后持久化与结束日志补存；执行器需捕获写入错误，只重试 flush / finish。记录恢复不等于任务自动续跑；服务商状态不明确时必须先核实。详见下面 v6 接口。

## TaskRecord 契约

类型统一定义于 `electron/taskLedgerSchema.ts`，前端从 `src/history/TaskLedger.ts` 导入。

- task：source、scopeId、id、短 label、category、startedAt、endedAt、status、origin、calls、quota。
- status：succeeded / failed / cancelled。只接受已经结束的任务；报告按 endedAt 落入 [startAt,endAt) 归属。
- origin：executor / import。页面导入强制标为 import，表示用户导入，未与服务商账单复核。
- call：唯一 id、taskId、provider、model、startedAt、endedAt、status、attempt、usage、cost。
- 时间均为规范 UTC ISO 字符串；调用时间必须在任务范围内；同作用域调用 ID 不能属于两个任务。
- usage：null，或 `{inputTokens, outputTokens, cachedInputTokens: number|null, basis:'provider-reported'}`。输入含缓存，不重复叠加。服务商只给 total 而不提供可核对拆分时不要杜撰 input/output；此版本先保留 null，之后按实际供应商扩展类型。
- cost：null，或 `{amount, currency:'USD'|'CNY'|其他三位大写币种, basis:'provider-reported'|'price-estimate'}`。估算必须依据调用当时价格由供应商适配器计算，账本不抓取价格、不使用订阅费换算调用成本。可选 pricing 保存 version、sourceUrl、effectiveAt；生效时间不得晚于该次调用开始。旧记录缺失此字段保持未知，不能补造依据。完整计费公式仍由适配器负责。
- quota：null，或 `{provider, window, points, basis:'exclusive-observation'}`。执行器必须确认没有其他并发消耗、没有刷新干扰，才可归因给任务；否则填 null。不同平台 / 额度窗口不混合统计。
- 未知一律 null；合法的实际零允许 0。数量非负、安全整数；成本与额度有限非负。未知附加字段被白名单丢弃，不存原始 prompt、response、API key 或登录令牌。

接口：`appendTaskRecords(TaskRecord[])`、`queryTaskRecords(query)`、`clearTaskRecords(scope)`。每次写入最多 500 个任务，每任务最多 1000 次调用。同 scope + task.id 相同内容重试幂等；内容冲突整批拒绝，避免旧数据被意外覆盖。任务账本与额度历史独立清除。

## 报表口径

成功任务统计平均 / 最低 / 最高完成时长（经过时间，含等待与重试）。Token 均值仅纳入所有调用都提供用量的成功任务；费用均值只纳入所有调用都提供同一币种、同一来源费用的成功任务。任务 quota 只统计可独占归因记录，并按 provider / window 分组。表格显示每项有效任务数；极值悬停显示任务 ID，下方可展开对应任务。

费用合计包括失败和取消任务的已知调用，按币种及服务商上报 / 估算分开；Token 合计包括所有状态的已知用量，不含缺失的未知值。未完整覆盖时不能称为完整账单。缓存输入不重复计数。

高消耗区域按已知 Token 排序列出前 5 个任务，显示输入 / 输出分布、失败和重试次数、逐调用模型与耗时。它提供排查线索，不自动认定长上下文或重试就是浪费。

## 手动导入与验收

页面可导入 `{ "version": 1, "tasks": [...] }` 的 UTF-8 JSON，文件最多 2 MB / 500 个任务；必须与当前页面来源 / scopeId 一致。只导入本机当前账号导出的记录，其他作用域整批拒绝。重复导入不会重复计量，冲突会报错。页面不提供凭据输入，也不能借此运行 AI 任务。

“月报示意”有 3 个完全独立的模拟任务，用于查看平均 / 极值表和调用展开效果；示意不保存。`scripts/test-history-ui.mjs` 使用临时存储验收真实文件接口、模拟隔离、导入重启和清除。

后续执行器接入后，点击“刷新报告”即可读取新的任务记录。记录适配器成功写入或清除后会通知当前页面；跨标签页存储变化也会刷新。报告打开且可见时每 30 秒补查一次，因此外部执行器写入后不依赖额度采样变化；隐藏时暂停补查，恢复可见时重读。


## 自动任务建议（v3 已实现）

`src/reports/taskAdvisor.ts` 的 `taskAdvice(records, query)` 已接入任务账本页面；无需组员另写建议规则。记录或报告区间变化会重新计算，清除 / 切换账号后旧建议消失。规则、测试和时机评估说明见 `D_TASK_ADVICE.md`。

TaskRecord 新增可选 `evaluation`，兼容现有版本 1 文件；未提供时保留未知：

```ts
const evaluation = {
  comparisonKey: '同一任务集-规模档位-版本',
  accepted: true,
  method: 'rubric' as const, // 或 user，表示用户评价
  rubricVersion: '验收标准-v1',
}
await run.finish('succeeded', null, evaluation)
```

comparisonKey 必须由执行器按真实可比范围填写，不能对不同规模任务统一填一个常量。模型对比只纳入相同 category / comparisonKey / method / rubricVersion 的已评价记录；没有评价不自动视为达标。

完成时已知的评价仍可随 finish 提供。v5 支持事后通过独立追加日志补评或修订；不要重写同一任务 ID 的原始完成记录。原始调用账单不可变，建议读取派生的最新评价视图。

时间建议可由执行器调用 `timingAdvice(pendingTask, currentQuota, now)`，也可在页面展开“仅评估额度等待时间（不选择模型）”手动填写。需要截止时间、紧急程度、预计耗时和两种额度预算；CurrentQuota 使用 A 当前已验证账号的 fresh 结果。这个函数返回建议，不运行任务、设置定时器或发送提醒。

综合模型与时间推荐改用 `recommendTaskPlan`，读取同一账本的评价、实际消耗和耗时；接口及资源输入见 [D_UNIFIED_PLAN.md](D_UNIFIED_PLAN.md)。


## v5：事后评价接口与存储兼容

页面：展开“逐任务 / 逐调用明细”→对应任务→“评价结果与修订历史”。填写可比任务组、评价标准版本，选择达标 / 需修改 / 无法判断，可附 500 字以内说明。历史修订始终保留。

```ts
import { applyTaskEvaluations } from '../../electron/taskEvaluations'
import { recommendationQuery } from '../history/recommendationHistory'

// 完成时先保存实际执行记录。之后用户看完结果再评价：
await ledger.appendTaskEvaluations([{
  ...scope, id: crypto.randomUUID(), taskId,
  createdAt: new Date().toISOString(),
  supersedes: latestEvaluation?.id ?? null,
  comparisonKey: '同规模同要求任务组', rubricVersion: '验收标准-v1',
  method: 'user', verdict: 'accepted', note: '',
}])
// 也支持 verdict=revise/unknown，程序评价使用 method=rubric。
const query = recommendationQuery(scope, 90)
const [tasks, events] = await Promise.all([
  ledger.queryTaskRecords(query), ledger.queryTaskEvaluations(query),
])
const evidence = applyTaskEvaluations(tasks, events)
// evidence 仅交给建议函数，不重新写入原始任务账本。
```

supersedes 必须指向当前最新评价，没有追加评价时为 null。旧页面与另一页面同时提交时，后到的过期版本拒绝，刷新后再评；相同事件 ID、相同内容重试幂等，冲突拒绝。每任务最多 50 次评价，全部最多 100,000 条；每次批量最多 500 条。评价必须关联同来源 / 账号的现存任务，时间不早于任务结束。允许至多 5 分钟设备时间偏移，但未来评价暂不进入当前建议。

queryTaskRecords 始终返回不可变的原始完成记录；queryTaskEvaluations 按任务结束时间选择相关评价历史，而不是按评价日期截断，因而上月任务本月补评也能读取。unknown 会使派生视图不再携带达标评价，但不删历史评价。

桌面与浏览器的任务账本都升级为 `{version:2,tasks,evaluations}`。文件路径仍为 petcast-task-ledger-v1.json，浏览器 key 仍为 petcast.task-ledger.v1，方便就地升级；新版本可读取旧 version=1，在下一次成功写入时保存为 version=2。旧程序不支持新日志，不能降级后继续写同一任务账本。游戏存档和额度历史不升级。清除账号任务会同时清除该账号评价；损坏日志会报错并保留原文件。

新增受限 IPC：tasks:evaluate、tasks:evaluations，经原有主窗口 / 主 frame / 页面地址校验；对应 preload 方法 appendTaskEvaluations、queryTaskEvaluations。

明细支持任务 ID / 名称搜索、模型 / 类别 / 状态筛选、每页 20 条和当前筛选全部结果的 CSV 导出。CSV 每次调用一行，保留来源与评价标识；无调用任务仍有一行，未知计量留空，不把缓存子集重复相加。导出经过公式前缀处理。CSV 不作为账本导入格式；原有 version=1/tasks JSON 导入保持不变。

`tests/executor-report-integration.test.mjs` 验证记录器→文件存储→事后评价→推荐的整条接口链路，使用本地构造的服务商响应，未进行真实收费调用。B 仍需提供实际 provider operation，并处理执行权限、重试、并发和存储失败重试队列。


## v6：执行日志与中断核对

TaskLedger 新增 writeExecutionEvent(event)、queryExecutions(scope)、reconcileExecutions(scope)，Electron 对应 tasks:execution-write / tasks:executions / tasks:reconcile。必须同时合并主进程、preload、前端与 schema；旧适配器没有 writeExecutionEvent 时，记录器在调用供应商之前拒绝执行。

TaskExecutionRecorder.call 先保存 begin 与 start，再发起 operation；返回或失败后保存 complete，最后才把结果交给调用方。文件写入使用临时文件、sync 和替换，浏览器使用独立 localStorage 与同一跨标签锁。已发起但无完成记录的调用标为待核实，不当作未执行，也不记零费用。同一任务 ID 不可新建记录器后重跑，同一调用 ID 不可重复 start。

- TASK_PERSISTENCE_FAILED：mayHaveExecuted=false 表示本次 operation 尚未调用；true 表示可能已执行/计费。不要自动重试 run.call，更不能换新 ID 绕过记录；检查存储后仅重试 run.flush() / run.finish(status)。
- finish 先持久化完整结束日志，再写入报告账本。若第二步失败，重启后可调用 reconcileExecutions(scope)，或在“执行恢复检查”点击“补存已结束任务”。同一记录幂等补存，冲突拒绝覆盖。
- queryExecutions 返回当前账号 ExecutionRun（owner、task、pending、finished）。未结束任务不进入完成任务统计；task.calls 是已保存调用，pending 是结果待核实调用。task.status 在 finished=false 时只是内部占位，不表示整个任务已成功。它也可能仍在运行，不能仅因列表存在就宣告崩溃。
- 核实待确认调用后，执行器可用原 owner / taskId / 调用元信息提交 complete 与 finish；必须依据真实供应商结果，不能补造零用量。D 不自动执行核实、重新调用或续跑工作流。
- 日志只保存元信息、计量与状态，不保存输出正文。因此恢复费用记录不等于恢复完整业务结果；服务商请求 ID、远端幂等及结果恢复仍由适配器实现。

文件为 petcast-task-ledger-v1.json.executions.json；浏览器 key 为 petcast.task-ledger.v1.executions。结束任务账本仍 version=2，执行日志独立 version=1。日志上限 10,000 个任务，桌面文件 64 MB；容量不足时阻止新调用。未核实记录不自动淘汰，需确认后管理；不是无限期无限量存储。

“清除当前账号任务记录”同时删除该账号任务、评价及执行恢复副本，其他账号不受影响；先停止任务再清除。多个存储文件的删除不是跨文件事务，失败时界面要求重新核对并重试，不承诺全部回滚。避免用旧版本程序操作 v6 数据目录。
