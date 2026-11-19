# 09 · 实施路线、任务拆分、验收与首个迭代

> Draft v0.1｜用于新工作区启动。阶段时间是**估算**，不是承诺；以真实证据推进 Gate。

## 1. 总体路线

| 阶段 | 估算 | 核心交付 | Exit Gate |
|---|---|---|---|
| P0 技术切片 | 1–2 周 | Nx、演示 fixture、录屏、Remotion、MP4 | 真实 30 秒视频 + 回执 |
| P1 MVP | 3–6 周 | GitHub PR → Claim → Demo → 视频 | 真实 PR 完整闭环 |
| P2 Studio | 4–8 周 | 分镜编辑、品牌、多语言、多比例 | 三类视频稳定可做 |
| P3 Factory | 6–10 周 | Release 触发、批量草稿、协作 | 一次发布多渠道草稿 |
| P4 Enterprise | 持续 | ATVG2、私有执行、桌面录屏 | 独立验证的企业集成 |

工期取决于团队人数、演示环境稳定性、视频质量要求、外部服务授权及基础设施现状。

## 2. P0 详细拆分

### WP-00 工程骨架

**目标**：Nx + pnpm Workspace，web/api/worker/contracts/domain 初始项目、lint/typecheck/test/build、CI、Docker Compose 开发依赖。  
**验收**：`nx graph` 正常；模块边界测试有效；Windows 与 Codespaces 都能按 README 启动；不存在真实密钥。

### WP-01 视频 IR 与固定样片

**目标**：实现 `StoryboardV1`、`VideoSceneV1` 的 Zod Schema、Remotion Composition、30 秒静态 fixture 视频。  
**验收**：固定输入产生可播放 MP4；记录 SHA256、时长、分辨率；Schema 非法输入被拒绝。

### WP-02 真实演示录屏

**目标**：本地 fixture Web App + Playwright Browser Worker，按批准 DemoPlan 录制真实操作。  
**验收**：断言通过、视频与 trace 存储、失败截图、超时/重试、账号和域名隔离。

### WP-03 生产编排与证据

**目标**：任务队列、状态机、ArtifactReceipt、Production Monitor 最小页面。  
**验收**：任务重复投递幂等；Worker 崩溃可恢复/明确失败；UI 可见执行进度和错误。

### WP-04 第一条端到端视频

**目标**：把真实录屏、标题动效、TTS、字幕合成为 30 秒视频。  
**验收**：可播放、音画正常、字幕同步、每个镜头有素材来源；人工批准后导出。

## 3. P1 详细拆分

- WP-10 GitHub 只读连接、授权与撤销。
- WP-11 PR/Diff/Release 增量分析、source digest、KnowledgeSnapshot。
- WP-12 Feature/Claim/Evidence 审核页面。
- WP-13 AI Director：Brief → Claim → Storyboard（Schema 严格校验）。
- WP-14 Demo Planner 与 Gate 2 批准流程。
- WP-15 Scene 编辑、局部失效标记、Render Profile。
- WP-16 独立 QA：技术检查、Claim 证据、隐私审核。
- WP-17 导出 MP4/SRT/manifest 与失败恢复。

**P1 端到端验收**：选择 3 个真实 PR（用户功能、UI 改动、内部重构），系统正确筛选视频候选；对至少一个真实功能完成录屏、视频合成和审核；记录总耗时、人工介入、失败次数、成本。

## 4. 关键技术验证矩阵

| 验证 | 方法 | 必须保存的证据 |
|---|---|---|
| GitHub 读取 | 真实只读权限测试 | 权限范围、请求日志摘要 |
| 索引性能 | 冷/热/增量基准 | 仓库规模、硬件、耗时、RSS |
| 录屏稳定 | 同一 DemoPlan 重复执行 | 通过率、trace、失败截图 |
| 视频正确 | ffprobe + 播放测试 | 编码、时长、分辨率、hash |
| 恢复能力 | 强制 kill Worker | checkpoint、重试回执 |
| Claim 真实性 | 人工复核 + 测试证据 | Claim/Evidence 映射 |
| 安全边界 | 注入/SSRF/越权测试 | 阻断结果与审计记录 |
| ATVG2 解耦 | 关闭 ATVG2 运行 MVP | 独立运行报告 |

## 5. Definition of Done（每个 WP 必须满足）

- 需求、输入输出、边界与风险已说明；
- 代码通过 lint/typecheck/test；
- 至少一个真实执行的验收用例；
- 失败路径与可观测性覆盖；
- 无硬编码凭证、无跨 Nx 边界 import；
- 产物有路径、hash、运行日志、退出码；
- 文档同步更新；
- 未完成事项明确标记，不得写成已交付。

## 6. Coding Agent 协作协议

在开始任何 WP 前，Agent 必须提交：

```text
目标（产品语言）：
当前代码与事实：
计划修改的 Nx projects：
计划文件与接口：
不会修改的范围：
风险与待确认问题：
验收命令与证据：
```

获得批准后再改动。执行完必须报告“已验证/未验证”边界、真实命令与退出码。不得因实现困难而悄悄降低验收标准。架构变化需 ADR；禁止一次任务跨越多个无关工作包。

## 7. 第一周执行顺序

**Day 1**：确定 Node LTS、pnpm、Nx 固定版本；初始化 Monorepo；建立工程边界和 CI。  
**Day 2**：contracts、domain-video、StoryboardV1、fixture 数据和单元测试。  
**Day 3**：Remotion 固定视频模板、FFmpeg/ffprobe 校验。  
**Day 4**：Playwright fixture app、DemoPlan、录屏和 trace。  
**Day 5**：将录屏插入 Remotion，导出首个真实 30 秒视频。  
**Day 6–7（缓冲）**：故障注入、资源基准、补齐文档与验收报告。

这是一份建议顺序，实际按团队容量调整；不把“Day 5”视为保证交付日期。

## 8. 第一条样片的具体选题

优先选择一个**已部署到可重置 staging 环境、可通过 UI 复现**的功能。ATVG2 可作为试点，但必须先核实功能真实状态与测试账号；如环境不稳定，先使用专门 fixture app，不阻塞视频引擎的技术验证。

建议 30 秒结构：0–5 秒问题；5–10 秒产品能力标题；10–24 秒真实 UI 操作；24–28 秒结果；28–30 秒 CTA。不要编造性能数字或客户收益。

## 9. 第一阶段风险登记

| 风险 | 信号 | 应对 |
|---|---|---|
| 过早做完整编辑器 | P0 一直没有成片 | 先做固定模板 + Scene 编辑 |
| 过早 Rust 化 | 索引尚无性能基准 | 先 Node + git/rg，再测量 |
| 录屏不稳定 | locator/账号/环境经常失效 | fixture + reset + assertions |
| Agent 失控 | 自行扩范围/改架构 | 先计划后执行 + 审批 |
| 视频缺乏质感 | 只是屏幕拼接 | 投入品牌模板与节奏设计 |
| 声称功能未上线 | PR 合并就宣传 | 发布证据 + Gate 1/3 |
| ATVG2 强耦合 | 新产品无法独立启动 | Standalone adapter 强制测试 |

## 10. 启动工作区的首条 Agent 指令

> 请先完整阅读 `docs/01` 到 `docs/09`，并检查当前目录。当前阶段只做 P0 的 WP-00 工程骨架。不要直接编写业务功能。先输出：①你对产品的理解；②拟采用的固定 Node/pnpm/Nx 版本及理由；③Nx 项目图与边界方案；④拟创建的目录与文件；⑤测试与验收命令；⑥风险和需要我批准的决策。等我确认后再实施。所有执行结果必须附真实命令、退出码和产物，不得把计划描述为已完成。

## 11. 阶段评审模板

```text
Stage / WP:
Commit SHA:
Scope completed:
Commands executed + exit codes:
Artifacts + SHA256:
Evidence links:
Failure tests:
Performance / cost measurements:
Known gaps:
Decision: PASS / CONDITIONAL / FAIL
Next approved WP:
```

**关联文档**：01–08。
