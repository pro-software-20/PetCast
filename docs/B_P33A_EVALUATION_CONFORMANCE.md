# B-P3.3A D 评价适配器合规测试与验收决策桥接

## 目标

P3.3A 为 D 组评价器建立统一、零网络、可重复的接入边界。D 只提交结构化 `EvaluationReport` 和非敏感证据引用；B 负责验证报告与当前任务、最新派发和尝试次数的关联，并依据验收策略生成 `AcceptanceDecision`。

本阶段只保存验收建议，不修改 `TaskSessionV1`，不自动完成任务、不自动返工，也不会产生新的 AI 调用或费用。

## 调用方向

```text
B 构造安全 TaskEvaluationRequest
          ↓
D TaskEvaluationAdapter.evaluate()
          ↓
严格校验 EvaluationReport
          ↓
B reconcileTaskEvaluation()
          ↓
TaskAcceptanceStateV1（独立持久化）
```

## D 组必须实现

1. 实现 `TaskEvaluationAdapter.evaluate(request, signal)`；
2. 支持预取消和运行中取消，取消后不得继续产生评价结果；
3. 报告必须保留请求中的 `evaluationId`、`taskId` 和 `dispatchId`；
4. 每条验证结果必须与任务验收标准按数量、顺序和标签逐项对应；
5. 相同评价请求必须返回同一结果，相同评价 ID 不得对应不同内容；
6. 使用可注入的评价客户端，合规测试必须能够使用零网络 fixture；
7. 运行 `pnpm test:evaluation-conformance` 并提交通过结果。

## 数据边界

允许发送给 D：

- 会话、计划、任务、派发和尝试次数标识；
- 任务目标、交付物和验收标准；
- 执行结果摘要、逐项验证状态和安全相对文件路径；
- 非敏感证据类型、引用和摘要。

禁止发送给 D：

- 完整 AI 输出或完整文件内容；
- API Key、登录凭据、账号、额度；
- 绝对路径、路径穿越和供应商原始响应；
- 非当前任务或非当前最新派发的结果。

## 验收策略

- `manual` 是默认策略。无论 D 返回何种结论，B 都只生成 `manual-review`。
- `trusted-evaluation` 只有在评价方法受信、结论为 `accepted` 且所有验收项通过时，才生成 `complete` 建议。
- `revise` 在最大尝试次数内生成返工建议，达到上限后转人工复核。
- `unknown` 始终转人工复核。
- 决策只是建议；P3.3A 不直接改变任务状态。

## 持久化与恢复

验收状态使用独立键 `petcast.task-acceptance.v1`，不写入任务会话或游戏存档。写入前必须通过严格校验并满足容量限制。损坏数据会保留并返回错误，不会静默覆盖或删除。

D 组现有的历史 `TaskEvaluation` 账本用于报告和统计，不能直接作为实时 `EvaluationReport`，因为历史记录不具备最新 `dispatchId`、逐项验证和证据关联。

## 验证

```powershell
pnpm test:evaluation-conformance
pnpm test:adapter-conformance
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm test:task-ui
git diff --check
```

P3.3B 再接入 D 组真实评价器、页面展示和用户确认后的状态落地。
