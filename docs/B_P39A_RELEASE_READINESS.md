# B-P3.9A：发布前验收与交接

## 范围

P3.9A 不新增自动执行权限，也不会在脚本中调用 DeepSeek、Codex、Render 或其他外部模型。它把已经完成的 B 协调能力整理为一套可复现的本地发布门禁和人工验收清单。

## 本地发布门禁

在仓库根目录运行：

```powershell
pnpm verify:release
```

该命令顺序执行契约、类型、A 执行适配器、D 评价、B 协调链路、桌面 DeepSeek × D、构建和 Electron 页面验收，最后运行 `git diff --check`。

它不会：

- 启动 `dev:ai`；
- 读取 `.env.local` 或 `DEEPSEEK_API_KEY`；
- 调用真实模型或公网 API；
- 创建外部执行或产生费用。

任何一步失败都停止后续步骤；修复后从头重新执行。若在受限 CI/沙盒环境中 Electron 无法启动，应在一台标准 Windows 桌面环境补跑页面与桌面冒烟项，并记录原因，不能把环境跳过标记为通过。

## 合并后的人工验收

优先使用一个已经完成且停留在 `review` 的统一 DeepSeek 任务；以下步骤不产生第二次模型调用：

1. 重启桌面应用，进入任务分析页面。
2. 确认自动协调显示“已暂停”，并看到该任务恢复的派发记录。
3. 点击“请求评价”，确认 D 只显示安全摘要、逐项验证、证据摘要、规则版本和建议动作。
4. 重新打开页面，再次请求评价；应复用已保存报告，不能重新调用 D。
5. 只有用户手动确认或完成现有人工验收后，任务才可进入 `done`。

若需要进行一次新的真实 DeepSeek 执行，必须按 `B_P38A_DEEPSEEK_DESKTOP_INTEGRATION.md` 在本机显式确认队列；一次验收只允许一个低风险、无文件写入任务。遇到限流、超时、未知执行或取消时，先使用任务卡的恢复操作核对外部状态，禁止直接重新派发。

## Windows 安装包门禁

公开包仅在已配置非敏感 HTTPS 公网服务地址时构建：

```powershell
pnpm dist:win:public
Get-FileHash release\windows\PetCast-Setup-*-x64.exe -Algorithm SHA256
```

发布前必须由另一台 Windows 10/11 x64 电脑完成：安装、启动、任务页打开、关闭重开、卸载。安装包与 SHA-256、测试日期和验收人记录到发布说明；未经异机验收不得声称公开版已完成最终验证。

## 交接责任

| 范围 | 负责人 | 发布前证据 |
| --- | --- | --- |
| DeepSeek 凭据、IPC 与 `dispatch/inspect/cancel` | A | 适配器合规测试、桌面受控验收 |
| 队列确认、恢复、人工决策与安全边界 | B | `pnpm verify:release`、P3.8B 人工验收记录 |
| 安装包、异机桌面环境与电脑操作能力 | C | Windows 异机安装验收与 SHA-256 |
| 证据评价与建议展示 | D | 评价合规、报告复用与人工确认记录 |

## 严禁提交的本地内容

- `.env.local` 和任何 API Key；
- `PetCast-quota-diagnostic.txt` 等本机诊断输出；
- `.petcast-auth-*` 等认证测试目录；
- `work/` 下可能包含本机验收结果的文件。
