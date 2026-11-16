# B-P3.4A 零网络任务协调全链路验收

## 目标

P3.4A 使用仓库内已有的内存执行适配器和内存评价适配器，验证 B 模块从依赖调度到最终报告的完整闭环。验收过程不连接真实 A、D 适配器，不访问网络，不调用 DeepSeek、OpenAI 或 Codex，也不产生模型费用。

验收链路：

```text
依赖解锁 → 自动派发 → 状态查询 → 结果回收
→ D 评价 → B 决策建议 → 用户确认 → 后续任务解锁
```

## 自动验收矩阵

| 场景 | 验收点 |
| --- | --- |
| 并行根任务 | 两个不同 Provider 的根任务在全局并发 2 下同时派发 |
| 单 Provider 限流 | 同一 Provider 同时最多派发 1 个任务 |
| 依赖汇总 | 汇总任务在两个直接依赖均由用户确认完成后才解锁 |
| 结果回收 | 执行完成只进入 `review`，不会自动变成 `done` |
| D 评价 | `accepted`、`revise`、`unknown` 只生成建议，不直接改任务状态 |
| 人工决策 | 用户逐项确认后才完成、退回或继续人工复核 |
| 评价幂等 | 已保存评价被复用，不重复调用 D |
| 调度幂等 | 重建控制器后默认暂停，只查询已有执行，不重复派发 |
| 存储恢复 | 协调状态已保存但会话保存失败时，可从协调状态恢复 |
| 安全交接 | 只发送直接依赖的摘要、决策、验证和相对文件元信息 |
| 数据隔离 | 不发送完整 AI 输出、凭据、绝对路径、额度或供应商正文 |
| 最终报告 | 所有任务和最终验收通过后生成本地 Markdown 报告 |
| 零网络 | 测试期间任何 `fetch` 调用都会使验收失败 |

异常分支（`needs-input`、`failed`、`cancelled`、`unknown`）、无收据的 `dispatching`、迟到结果、损坏存储和输入不可变性继续由 P3.0～P3.3 的契约与单元测试覆盖；P3.4A 将这些既有测试纳入完整回归命令。

## 运行方式

```powershell
pnpm test:coordination-e2e
pnpm test:evaluation-conformance
pnpm test:adapter-conformance
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm test:task-ui
git diff --check
```

`test:coordination-e2e` 只使用内存存储和 fixture，不需要 `.env.local`、API Key、登录状态或公网服务。

## 当前跨组状态

- A 组真实 `ExecutionAdapter` 尚未接入本验收链路。P3.4A 使用 `InMemoryExecutionAdapter` 验证 B 的派发、查询、取消和恢复边界。
- D 组真实 `TaskEvaluationAdapter` 尚未接入本验收链路。P3.4A 使用 `InMemoryTaskEvaluationAdapter` 验证报告、决策和幂等边界。
- 默认发行版不会注册这些内存适配器，人工流程和现有 Codex 兼容流程不受影响。

## P3.4B 真实联调入口

真实跨组联调时，不改写本验收场景，只替换注入的适配器：

1. A 组适配器先通过 `pnpm test:adapter-conformance`。
2. D 组适配器先通过 `pnpm test:evaluation-conformance`。
3. 将真实适配器注入相同控制器与评价工作流。
4. 验证相同的派发幂等、恢复只查询、评价幂等和人工确认规则。
5. 真实联调必须显式启用，默认测试仍保持零网络。

