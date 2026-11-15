# B-P3.7A 协调审计时间线与脱敏导出

## 范围

本阶段为当前任务会话提供独立的协调审计记录，不修改 `TaskSessionV1`、协调状态 schema、A 组执行适配器或 D 组评价适配器。

审计会记录用户确认、派发意图、适配器收据与状态快照、暂停/恢复/取消、异常恢复决定、D 评价建议和用户最终决定。每条记录仅包含安全摘要及关联标识；不会保存 Prompt、完整 AI 输出、文件内容、凭据、绝对路径、额度或供应商原始响应。

## 存储与恢复

- 浏览器存储键：`petcast.task-coordination-audit.v1`。
- 只保留当前会话，最多 500 条事件或 512 KiB。
- 损坏数据不会被静默删除；界面显示警告，但既有协调、人工验收和恢复流程仍可继续。
- 新会话遇到上一会话的有效审计记录时视为过期记录，不会误报为损坏数据。

## 页面操作

在“自动协调”区域可查看当前事件数，展开完整时间线，并执行：

- 复制脱敏 Markdown 审计记录；
- 下载脱敏 JSON 审计记录。

导出仅适合作为协作排障和复盘依据，不代替 D 组的评价报告或真实适配器的供应商日志。

## 验证

```powershell
corepack.cmd pnpm test:contracts
corepack.cmd pnpm typecheck
corepack.cmd pnpm build
corepack.cmd pnpm test:desktop
corepack.cmd pnpm test:task-ui
git diff --check
```

当前默认发行版仍不注册通用真实 A 组适配器；审计不会触发网络、模型调用或费用。
