# ADR-001 · API 框架选择 Fastify

- 状态：已接受
- 日期：2026-11-27
- 相关：docs/03 §11、docs/10 §7 S3-2、[ADR-008](ADR-008-sqlite-workspace-storage.md)

## 背景

Step 3 需要一个最小后端，让工作区不再只存在单个浏览器的 localStorage 中。
docs/03 已确定模块化单体方向，但 API 框架一直列在 ADR 待办里，没有决议。
当前约束：

- Node.js 22.13+，TypeScript，Nx + pnpm；
- 只需要少量 JSON 路由，不引入 ORM、DI 容器或微服务；
- 必须在本地开发、Vitest 和后续 CI 中低成本运行；
- 需要 CORS、请求体限制和统一错误处理，但不希望自己拼装这些基础设施。

## 决策

使用 **Fastify 5**，配合 `@fastify/cors`。API 位于 `apps/api`：

- `buildApp()` 只构建实例、不监听，测试通过 `app.inject()` 直接调用；
- `main.ts` 负责读取配置、监听与优雅关闭；
- 路由只做参数校验、调用领域/存储函数、映射错误，不承载业务规则；
- 开发与测试使用 `tsx` 直接运行 TypeScript，暂不增加独立构建产物。

## 后果

正面：

- 内置 schema 校验入口、日志、请求体限制与生命周期钩子；
- `inject()` 让 API 集成测试无需真实端口，适合当前 8 个路由的规模；
- 插件生态足以覆盖 CORS、后续鉴权和 OpenAPI，而不强迫使用完整框架。

代价：

- 目前没有生产构建 target；部署前需要补 `tsc`/打包步骤并验证 Node 22 运行；
- Fastify 的请求/响应类型与领域 schema 是两套体系，边界处需要显式 Zod 校验；
- 没有鉴权、限流或多租户隔离，N3 之前只能绑定 `127.0.0.1` 使用。

## 备选方案

| 方案 | 不选原因 |
|---|---|
| Express | 需要自行补齐校验、错误处理和类型；生态更成熟但不解决当前问题 |
| Hono | 轻量且类型好，但 Node 适配、日志和测试注入的成熟度不如 Fastify |
| NestJS | 对当前「少量 JSON 路由」过重，引入装饰器、模块和 DI 的学习/维护成本 |
| Node 原生 `http` | 需要自行实现路由、CORS、body limit 和错误映射，重复造轮子 |

## 验证

- `apps/api/src/app.test.ts`：健康检查、404、创建/读取、双客户端可见、409 冲突、
  非法数据、v1→v2 读取升级、运行状态、导出、非法 workspace id。
- `apps/api/src/db/database.test.ts`：v1→v2 数据库迁移保留运行记录。
