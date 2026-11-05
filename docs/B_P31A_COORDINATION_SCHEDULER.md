# B-P3.1A 确定性任务调度核心

## 当前范围

P3.1A 在 P3.0 协作契约之上提供一次性、无定时器的纯调度周期。它不会操作页面、不会直接修改 `TaskSessionV1`，也不会连接真实 AI。

调用方每次显式调用 `runCoordinationCycle()`，调度器会：

1. 严格校验任务会话与独立协调状态；
2. 查询已有执行引用，生成会话状态变更建议；
3. 按计划顺序和并发容量筛选新的 `api` / `local-agent` 任务；
4. 在调用执行适配器前保存 `dispatching` 意图；
5. 保存收据、快照和安全错误；
6. 返回下一次建议查询时间，不自行启动轮询。

`manual` 任务继续沿用现有人工流程。P3.1B 才会把 `TaskCoordinationEffect` 接入任务会话状态转换，P3.1C 再增加持续轮询和页面控制。

## 并发和依赖规则

- 默认全局并发数为 2；同一 Provider 并发数为 1。
- `queued` 和 `running` 占用并发槽；`needs-input` 不阻塞其他独立分支。
- 只有 `ready` 且全部直接依赖任务均为 `done` 的任务可以派发。
- 多个无依赖根任务可以并行；汇总任务必须等待其声明的全部依赖。
- 本机代理需要读取交接文件时，必须先通过现有交接授权检查，否则只输出 `needs-input` 建议。

## 幂等与恢复原则

`dispatchId` 由以下字段确定性生成：

```text
sessionId + planId + taskId + attempt + providerId
```

派发跨越 A 组适配器边界之前，B 必须先持久化 `dispatching` 意图。恢复时遵循：

- 已有 `ExecutionReference`：只调用 `inspect()`；
- `dispatching` 但没有执行引用：状态转为 `unknown`，要求人工核对；
- 执行不存在、快照无效或状态未知：不得自动重派；
- 限流和临时不可用可保留重试信息，但 P3.1A 不执行自动重试；
- 不允许因为替代 Provider 可用而隐式改派。

以上规则用于避免重复收费、重复文件修改和崩溃后的不确定重放。

## 独立协调状态

协调记录使用独立键：

```text
petcast.task-coordination.v1
```

协调状态只保存会话/计划关联、任务、Provider、尝试次数、稳定派发 ID、阶段、执行引用、最近快照和安全错误。它不保存：

- API Key 或登录凭据；
- 绝对路径；
- 完整供应商响应；
- 完整前置任务输出；
- 额度数据。

存储上限为 2 MiB，损坏、超限或关联 ID 不匹配的数据会安全失败，且不会被静默覆盖。

## 输出给 P3.1B 的效果

调度器只输出建议，不直接修改任务会话：

- `dispatch-accepted`
- `execution-running`
- `execution-needs-input`
- `execution-completed`
- `execution-failed`
- `execution-cancelled`
- `execution-unknown`

效果包含稳定派发关联和经过严格校验的安全快照。任务状态的最终转换仍由 B 的会话状态层完成。

## 验证

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm test:task-ui
git diff --check
```

P3.1A 的测试使用内存存储和内存执行适配器，不访问网络，也不会产生真实 AI 调用或费用。
