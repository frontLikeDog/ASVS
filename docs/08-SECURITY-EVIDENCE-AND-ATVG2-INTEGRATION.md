# 08 · 安全、事实证据与 ATVG2 集成边界

> Draft v0.1｜威胁模型覆盖源码、凭证、浏览器执行、生成内容、跨租户数据和对外声明。

## 1. 威胁模型

**资产**：GitHub 访问令牌、私有源码、客户演示数据、浏览器 session、品牌素材、录屏、成片、证据与审核记录。  
**不可信输入**：README、PR 评论、Issue、网页 DOM、上传文件、第三方素材、模型输出。  
**攻击面**：提示注入、SSRF、任意脚本执行、凭证泄露、租户越权、恶意依赖、供应链、录屏意外泄密、伪造产品声明。

## 2. 接入模式与权限

| 模式 | 允许访问 | 默认禁止 |
|---|---|---|
| UI-only | 受控演示 URL、测试账号、上传文档 | 源码、生产数据库 |
| Developer | 授权仓库只读 PR/Commit/文件 | 推送、合并、修改设置 |
| Enterprise | 企业托管执行与索引 | 未授权数据出境 |

GitHub 优先使用范围受限、可撤销的安装授权；只申请必要的只读权限。凭证保存在 Secret Manager 或加密存储，应用数据只保存引用；严禁写入日志、LLM prompt、视频素材和 Git 仓库。

## 3. 执行沙箱

- Browser Worker 仅能访问明确 allowlist 的目标 origin；阻止访问内网元数据地址、localhost（除显式批准的本地开发模式）、云凭证端点及非授权域名。
- 网络层执行出站限制，不仅依赖模型指令；防止 DNS 重绑定与重定向绕过。
- 禁止执行仓库任意 `postinstall`、shell、浏览器 eval；需要构建项目时使用单独审查和沙箱策略。
- 使用测试账号与可重置 fixture；生产环境默认只读，任何写操作需单独策略批准。
- 限制 CPU、内存、磁盘、网络、执行时长、并发；容器运行非 root，最小文件系统权限。
- 上传文件检查 MIME/大小；扫描恶意内容；素材存储按租户隔离。

## 4. Evidence 不是“AI 觉得可信”

证据分类：

1. **Source Evidence**：源码位置、PR、Commit、文档片段（说明设计/实现意图）。
2. **Test Evidence**：CI/E2E 结果、测试输入、运行版本（说明指定条件下通过）。
3. **Runtime Evidence**：真实 UI 操作 trace、截图、录屏、assertions（说明演示成功）。
4. **Release Evidence**：部署版本、Feature Flag、公开可用范围（说明对外可用状态）。
5. **Human Approval**：授权人员对 Claim 与成片的明确批准（说明发布责任）。

任何单类证据都不能替代其他类别。例如源码存在不证明已部署；录屏成功不证明大规模性能收益。

## 5. Claim 发布规则

- **可展示**：在指定环境真实演示成功，Claim 与演示画面一致，已批准。
- **需限定**：仅 staging、仅 Beta、仅管理员可用，文案必须标明范围。
- **禁止**：功能未实现、测试失败、证据过期、量化收益无依据、展示真实敏感数据。
- **争议**：进入人工复核；系统保留审核理由、批准人、对象 digest 与时间。

审核前对 Claim 做来源校验、证据有效期与环境匹配；视频导出 manifest 包含已批准 Claim revisions 与证据引用。

## 6. 数据治理

- 默认不将私有源码全文发送给外部模型；按需检索最小片段，允许客户禁用云模型。
- 明确数据保留期、删除流程、模型供应商数据处理条款和地域限制。
- 录屏前注入合成测试数据；录屏后检查敏感字段并允许遮挡/重录。
- 审计记录不可由普通编辑者修改；关键行为保留 actor、scope、timestamp、digest。
- 下载链接短期有效、访问鉴权、可撤销；跨租户 ID 猜测不能访问对象。

## 7. ATVG2 复用原则

**业务独立**：Video Studio 有自己的项目、视频、证据、审批、运行状态与存储，不直接查询 ATVG2 内部数据库。  
**协议兼容**：通过版本化 DTO 交换 ProductEvent、EvidenceRef、CapabilityInvocation。  
**可选接入**：Standalone 模式在没有 ATVG2 的情况下完成完整 MVP。  
**验证优先**：每项复用必须以真实集成测试、故障恢复测试、回执和性能基准确认。

### 适配关系

| ATVG2 概念 | Video Studio 候选用途 | 边界 |
|---|---|---|
| Observation | 录屏步骤与工具调用轨迹 | 不依赖内部事件表 |
| WorkEpisode | 生产过程的可审计封装 | 先使用本地 ProductionRun |
| Evidence | Claim 证据引用与校验 | 本地 EvidenceRef 为主 |
| Capability Asset | 复用演示/渲染技能 | P4 才做深度集成 |
| Policy / Approval | 危险操作审批语义 | 本地策略引擎可独立运行 |
| Development Factory | 新版本事件触发视频候选 | 只接收已授权事件 |
| Desktop Control Plane | 桌面录制 | 非 MVP 依赖 |

## 8. 建议的端口

```ts
interface ProductKnowledgePort {
  getSnapshot(projectId: string): Promise<unknown>;
  listFeatures(snapshotId: string): Promise<unknown[]>;
}
interface DemoExecutionPort {
  execute(approvedPlanId: string): Promise<unknown>;
}
interface EvidenceVerificationPort {
  verify(claimIds: string[], contextId: string): Promise<unknown[]>;
}
interface CapabilityInvocationPort {
  invoke(capabilityId: string, inputRef: string): Promise<unknown>;
}
```

这些是**边界示意**，具体 DTO 以 `libs/contracts` 中的版本化 Schema 为准。`adapters-atvg2` 仅实现这些端口，不把 ATVG2 类型直接暴露给 domain。

## 9. 安全验收用例

1. 恶意 README 指示上传 `.env` → 工具层拒绝，记录事件。
2. 演示页面跳转到未授权域名 → 阻断。
3. PR 触发生产环境写操作 → 默认拒绝。
4. 租户 A 猜测租户 B 的 artifactId → 403/404 且无信息泄露。
5. Worker 崩溃 → 凭证不进入日志/核心转储共享目录。
6. Claim 证据过期 → 发布审核阻断。
7. 审批后修改 DemoPlan → 旧审批失效。
8. 录屏出现 token → 质量门禁失败并要求遮挡/重录。
9. ATVG2 不可达 → Standalone 模式仍能完成视频制作。
10. 撤销仓库授权 → 后续同步失败可见，已保存数据按保留策略处理。

**关联文档**：03、05、06、07、09。
