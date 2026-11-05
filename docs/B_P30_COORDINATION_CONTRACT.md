# B-P3.0 任务协调边界与统一契约

本阶段冻结 A、B、C、D 四组之间的协调边界。这里只提供类型、校验、兼容适配器和测试夹具，不启动自动调度循环，也不改变现有任务页面。

## 职责与调用方向

| 分组 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| A | 具体 AI 执行适配器、登录与凭据、软件/API 调用、结果提取 | 任务依赖、验收决策、恢复重派策略 |
| B | 任务依赖、派发 ID、状态策略、验收建议、恢复决策 | 供应商登录、底层点击、最终成果证据归档 |
| C | 向 A 提供通用电脑操作能力 | 接收 B 的任务业务指令、决定任务状态 |
| D | 返回评价报告、验证结果和证据引用 | 直接修改 B 的任务状态、自动重新执行任务 |

稳定调用方向为：

```text
B ── ExecutionDispatchRequest ──> A ──通用操作请求──> C
B <─ ExecutionReceipt/Snapshot ─ A
B <────── EvaluationReport ────── D
B ── AcceptanceDecision（建议）──> B 的后续状态策略
```

B 不直接调用 C。D 的评价结论不是任务状态，最终状态转换权仍属于 B。

## B → A：执行派发

入口契约位于 `src/types/taskCoordination.ts`：

- `ExecutionDispatchRequest` 使用稳定的 `dispatchId` 作为幂等键。
- 相同 `dispatchId` 和相同请求必须返回同一执行；相同 ID 对应不同请求必须拒绝。
- `ExecutionReceipt` 表示适配器已接收执行。
- `ExecutionSnapshot` 表示查询时观察到的状态。
- `ExecutionAdapter` 只暴露 `dispatch()`、`inspect()` 和 `cancel()`，并接受 `AbortSignal`。

### 恢复原则

应用恢复后只能持已有执行引用调用 `inspect()`。如果 A 返回 `unknown` 或 `EXECUTION_NOT_FOUND`，B 必须进入人工核对或补充信息流程，不得用旧请求自动再次调用 `dispatch()`。这条规则用于避免重复收费和重复修改文件。

### 数据边界

允许传递：

- 任务静态定义；
- 当前实际执行 Provider；
- 直接前置任务的摘要、关键决策、验证结果、相对文件元信息和遗留问题。

禁止传递：

- API Key、Cookie、登录凭据；
- 绝对路径、路径穿越或任意电脑操作命令；
- 额度快照；
- 前置 AI 的完整输出正文；
- 非直接依赖任务的信息。

## D → B：评价与验收建议

`EvaluationReport` 只描述评价结果和证据引用。证据引用必须是非敏感引用或安全相对标识，不能嵌入大文件、完整执行输出或本机绝对路径。

`decideTaskAcceptance()` 只生成建议，不修改 `TaskSessionV1`：

- 默认 `manual` 策略下，任何报告都返回 `manual-review`。
- `trusted-evaluation` 只信任策略中显式列出的方法。
- 只有 `accepted` 且全部验证项通过时，才可建议 `complete`。
- `revise` 在未超过最大尝试次数时建议返工；达到上限后转人工确认。
- `unknown` 始终转人工核对。

## 兼容与迁移路线

- 现有 `TaskPlan`、`TaskSessionV1` 和 `schemaVersion: 1` 保持不变。
- 现有 `WorkerProvider` 不删除；`WorkerProviderExecutionAdapter` 只提供进程内兼容桥。
- 兼容桥不会在恢复后自动重新调用旧的一次性 `execute()`。
- 当前 `TaskPlanCards` 直连 Codex 的实现暂时保留。
- P3.1 再将持续调度、并发控制、状态推进和现有 Codex 路径迁移到统一 `ExecutionAdapter`。

## 校验与联调夹具

- `taskCoordinationValidation.ts`：严格拒绝未知字段、非法关联、危险路径和状态/结果不一致。
- `InMemoryExecutionAdapter`：供 B 调度器和 A/B 联调使用的零网络幂等夹具。
- `createEvaluationReportFixture()`：供 D/B 评价联调使用的安全报告夹具。
- `WorkerProviderExecutionAdapter`：旧执行接口兼容骨架。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm test:task-ui
git diff --check
```

