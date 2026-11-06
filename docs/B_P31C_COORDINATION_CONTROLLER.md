# B-P3.1C 持续任务协调控制

## 目标

P3.1C 将 P3.1A 的单周期调度器和 P3.1B 的会话桥接器组合为可持续运行的控制层。它负责启动、暂停、恢复、立即检查、取消和页面状态展示，但不内置任何生产 AI 适配器。

默认发行版使用空 `ExecutionAdapterRegistry`，因此不会产生自动外部调用或费用。人工复制 Prompt 与原有 Codex 隔离执行链路继续可用。

## 调用关系

```text
TaskAnalysisPanel
  -> TaskCoordinationController
      -> runCoordinationCycle()                 (P3.1A)
      -> ExecutionAdapterRegistry               (A 组注入)
      -> reconcileTaskSessionWithCoordination() (P3.1B)
      -> TaskCoordinationStore / TaskSessionStore
```

- B 组控制执行时机、依赖、并发、暂停恢复和状态建议。
- A 组按 Provider 注入 `ExecutionAdapter`，负责真实软件或 API 调用。
- C 组电脑操作能力只能由 A 组适配器使用，B 不直接发电脑操作命令。
- D 组评价仍只提供证据和建议；P3.1C 不自动验收。

## 安全规则

1. 每个会话首次启动自动协调都必须在当前运行期重新确认。
2. 应用重启或重新打开带自动任务的会话时默认暂停。
3. 恢复和“仅检查”先查询已有执行引用，不自动重复派发。
4. 暂停停止新派发和后续轮询，不会假装已经终止外部执行。
5. 调度器在跨越适配器 `dispatch()` 边界前再次检查暂停状态。
6. 自动任务只能使用 Provider 声明支持且注册表已接入的 `api` 或 `local-agent` 模式。
7. 切换 Provider 后执行方式恢复为 `manual`，避免把旧授权带到新 Provider。
8. 同一任务一旦进入统一协调链路，人工开始和旧 Codex 专用入口均被锁定。
9. 存储损坏不会自动删除；用户可在页面明确清除协调记录。
10. 自动完成结果只进入 `review`，仍需人工验收。

## A 组适配器接入

页面或联调入口通过以下属性注入：

```ts
<TaskAnalysisPanel
  coordinationAdapters={registry}
  coordinationStore={store}
/>
```

适配器必须遵守 P3.0 契约：

- `dispatchId` 幂等；
- `dispatch()`、`inspect()`、`cancel()` 返回结构化安全结果；
- 不返回供应商正文、凭据或绝对路径；
- 恢复时能够根据 `ExecutionReference` 查询，而不是重新收费调用；
- 未知状态不得自动重跑。

## 当前限制

- 默认生产注册表为空，尚未接入 A 组真实适配器。
- 不自动切换 Provider，不自动重试收费调用。
- 不自动执行 D 组验收建议。
- 原 Codex 专用链路暂保留，后续跨组联调后再决定迁移方式。

## 验证

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm test:task-ui
git diff --check
```
