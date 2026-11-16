# D 模块试用与联调

本地开发基线为 GitHub main 提交 1207e348ee6d5ef6ec9128e0b3bd9b86481ce1ed。

## 报告试用

从主页进入“使用历史与报告”。默认打开“近七天”，可切换到周报、自然月或独立的月报示意。展开“使用习惯与任务反馈”中的任务，可以核对实际模型、用时、失败和重试。“平台资源”按账号、平台、资源种类和单位展示期内最近的采样。

月报示意的三条任务共上报 7,200 Token，其中输入 6,000、输出 1,200。在“示例活动通知”中录入修订版、保存、比较和恢复。示意成果版本仅在当前页面使用。

实际成果位于任务分析的最终验收区域。点击“归档当前成果”，之后可以在同一账号的“近七天 → 已归档成果”中重新打开。Markdown 导出使用本机下载功能。HTML 预览采用隔离框架。无账号执行的人工任务归入本机范围。

## 组间接口

- A 可调用 appendResourceSamples(scope, samples) 或导出 v1 JSON 供报告导入。界面提供当前作用域对应的 JSON 模板。账号字段使用别名，时间为 UTC ISO 字符串，百分比、Token 和货币余额分别使用 quota-percent、tokens、balance。Codex 历史直接读取现有有效采样；第二平台需由适配器提供真实值。
- B 的任务账本支持可选调用阶段 stage（planning 或 execution）及实测人工等待 humanWaitMs。旧账本和缺少计量的调用可继续读取。调用时间以区间并集计算。没有人工等待事件的任务显示“未记录”。
- B 的最新自动派发进入待验收后，任务卡提供“成果检查证据”。D 从经校验的摘要与逐项证据生成 accepted、revise 或 unknown，交给 B 决策接口并保存到该会话。失败项建议返工，证据不足转人工核对。文件选择只核对所选文件的名称及非空大小。当前策略保留人工确认。
- 真实任务链的验收依赖 A 的运行适配器。跨模块测试用受控执行结果覆盖失败退回、下一次尝试通过及决策持久化。

## B 组接入入口

上传包已对齐 main 的 a895edf。App.tsx 把 TaskEvidenceAdapter 注入 TaskAnalysisPanel。任务进入待验收后，B 的 requestTaskEvaluation 构造请求并调用 evaluate(request, signal)，再由现有协调逻辑保存建议。可选 evidence 字段支持逐项补充证据（reference 为 check:0、check:1 等，按验收项顺序）。同一次派发沿用 B 的稳定评价 ID。缺少依据时返回 unknown，人工策略下仍由用户确认。联调时验证一次失败退回和下一次尝试通过。

验证命令：node --test tests/d-workspace.test.mjs tests/task-evaluation*.test.mjs
