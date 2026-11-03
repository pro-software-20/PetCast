# P2.10 Render 公网部署与团队验收

## 交付目标

P2.10 将 PetCast AI 服务部署为 Render 新加坡区域的单实例付费 Web Service，并通过持久磁盘保存匿名限流状态。团队 Windows 测试包只内置非敏感 HTTPS 服务源地址，不包含 DeepSeek Key、后端代码或本地环境文件。

本阶段仍属于匿名限流的团队测试版，不适合作为商业公开服务。DeepSeek、Render 或网络异常时，任务分析页继续回退本地规则大脑。

## Render 创建步骤

1. 登录 Render，并确认已连接 `pro-software-20/PetCast` GitHub 仓库。
2. 在 Render Dashboard 选择 **New → Blueprint**，导入仓库根目录的 `render.yaml`。
3. 确认服务名为 `petcast-ai-pro-software-20-beta`、区域为 Singapore、规格为 `0.5c-512mb`、实例数为 1。
4. 在首次 Blueprint 配置中填写 `DEEPSEEK_API_KEY`。不要把 Key 写入 Git、聊天记录、安装包或普通环境说明。
5. 确认 `/data` 挂载 1 GB 持久磁盘，健康检查路径为 `/health`。
6. 等待部署完成，记录 Render 实际分配的 `https://*.onrender.com` 地址。
7. 在 DeepSeek 控制台设置消费上限，并在 Render 配置账单提醒。

挂载持久磁盘的 Render 服务不支持自定义 `maxShutdownDelaySeconds`，Blueprint 不设置该字段，使用平台对磁盘服务的默认关闭行为。

如果 Render 账号尚未连接 GitHub，先完成 GitHub 授权再创建 Blueprint。Secret 只在首次创建时填写；后续 Blueprint 同步不会覆盖 `sync: false` 的 Secret。

## 公网服务验收

先执行零推理检查：

```powershell
$env:PETCAST_PUBLIC_AI_API_URL="https://Render实际域名"
pnpm test:public-ai
```

确认健康检查和安全拒绝通过后，只执行一次真实规划：

```powershell
$env:PETCAST_RUN_PUBLIC_AI_TESTS="1"
pnpm test:public-ai
Remove-Item Env:PETCAST_RUN_PUBLIC_AI_TESTS
```

脱敏报告写入被 Git 忽略的 `work/public-ai-acceptance.json`。报告不得包含 API Key、完整 Prompt、任务正文或 DeepSeek 原始响应。

## 团队安装包

公网验收通过后构建 `0.1.3-beta.1`：

```powershell
$env:PETCAST_PUBLIC_AI_API_URL="https://Render实际域名"
pnpm dist:win:public
```

检查：

- `dist-electron/ai-service-config.json` 只含 HTTPS origin；
- 成品不含 `.env.local`、`DEEPSEEK_API_KEY`、`dist-server`、诊断报告或用户数据；
- `release/windows/SHA256SUMS.txt` 与安装包一致；
- GitHub 使用 `v0.1.3-beta.1` Draft Release，异机验收前不公开发布。

## 异机验收记录

| 项目 | 结果 |
| --- | --- |
| Render 服务地址 | 待部署后填写 |
| 部署提交 | 待部署后填写 |
| `/health` | 待验收 |
| 公网真实规划 | 待验收 |
| 安装包 SHA-256 | 待构建后填写 |
| 测试电脑与 Windows 版本 | 待异机验收 |
| DeepSeek 规划成功 | 待异机验收 |
| 断网回退本地规则 | 待异机验收 |
| 会话恢复不重复调用 | 待异机验收 |
| 其他模块回归 | 待异机验收 |

## 回滚与故障处理

- 新部署健康检查失败时，在 Render Deploys 页面回滚到上一个成功部署。
- DeepSeek 费用异常时先暂停 Render 服务或移除 Key，并在 DeepSeek 控制台停用对应 Key。
- 持久磁盘服务部署时会短暂停机；测试期间不扩展为多实例。
- 客户端无法访问服务时不自动重试收费规划，继续使用本地规则大脑。
