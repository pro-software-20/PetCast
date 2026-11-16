# B-P3.4B：真实 D 评价接入全链路验收

## 当前接入状态

- D 组的 `TaskEvidenceAdapter` 已由主程序注入任务分析页面；它根据逐项验收状态和关联证据生成 `accepted`、`revise` 或 `unknown` 报告。
- B 组仍持有状态决定权。D 的报告经严格关联校验和持久化后只形成建议，任务完成、退回或继续人工复核均由用户操作。
- A 组尚未交付可注册到统一协调器的真实 `ExecutionAdapter`。本验收使用 `InMemoryExecutionAdapter`，正式发行版的通用适配器注册表保持为空；现有人工流程和 Codex 专用兼容流程继续可用。

## 验收矩阵

| 场景 | 检查内容 |
| --- | --- |
| 并行执行 | 两个不同 Provider 的根任务按全局并发 2 派发，汇总任务等待两个根任务完成 |
| 重启恢复 | 重建控制器默认暂停，只查询持久化执行，不重新派发 |
| D 通过 | 验收状态为通过且存在对应 `check:0` 人工证据时返回 `accepted`；B 仅提出完成建议 |
| D 建议修改 | 验收状态为失败时返回 `revise`；用户确认后才退回修改 |
| D 无法判断 | 验收状态为通过但缺少关联证据时返回 `unknown`；仍由用户人工复核 |
| 评价复用 | 同一派发和尝试的已保存报告直接复用，重建 D 实例也不会再次评价 |
| 迟到结果 | 非当前派发的评价不能覆盖当前会话或验收状态 |
| 数据边界 | D 请求不含完整 AI 输出、凭据、绝对路径和额度；直接依赖交接不含完整输出 |
| 最终报告 | 用户确认全部任务及最终验收后生成 Markdown 报告，不包含完整 AI 输出 |
| 零网络 | 测试拦截 `fetch`，不调用真实 AI、OAuth 或公网服务 |

运行：

```powershell
pnpm test:coordination-d-e2e
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

## A 组交付后的联调入口

1. A 组提供真实 `ExecutionAdapter`、可注入的零网络供应商客户端，以及通过 `pnpm test:adapter-conformance` 的 fixture。
2. 用真实适配器替换本验收中的内存 A 适配器，保留 D 的真实证据规则、B 的人工确认和恢复断言。
3. 真实供应商联调单独显式启用，先检查幂等派发、重启后只查询、取消和结果脱敏；默认自动测试继续保持零网络。

P3.4A 的内存 A/D 双 fixture 基线仍在 `docs/B_P34A_ZERO_NETWORK_ACCEPTANCE.md` 和 `pnpm test:coordination-e2e` 中独立保留。
