# ADR-008 · Step 3 工作区存储使用 SQLite

- 状态：已接受
- 日期：2026-11-27
- 相关：docs/10 §7 S3-3/S3-4/S3-5、[ADR-001](ADR-001-api-framework-fastify.md)

## 背景

Step 3 要把 `StudioSnapshot`（13 个数组的完整工作区）从单个浏览器的
localStorage 迁移到可跨设备、可备份的存储。当前约束：

- 只有单机、单写入者，没有队列与对象存储；
- 领域模型还没有实体级 revision、tombstone 或合并元数据，暂时无法做字段级冲突合并；
- 必须保留 v1→v2 的迁移链，且迁移失败不能静默清空数据；
- 媒体二进制仍留在工作区相对路径，不在本次范围内；
- 生产环境最终可能使用 PostgreSQL，但 Step 3 不引入运维依赖。

## 决策

使用 **SQLite**（Node 内置 `node:sqlite` 的 `DatabaseSync`）作为 Step 3 的工作区存储：

- `workspaces`：每个工作区一行，`payload` 保存完整 `StudioSnapshot` JSON，
  另存 `revision`、`schema_version`、`created_at/updated_at`；
- `production_runs`：从工作区 payload 投影出来的运行索引，
  主键 `(workspace_id, id)`，用于按工作区查询运行状态；
- 写入使用 `BEGIN IMMEDIATE`，以客户端提交的 `baseRevision` 做乐观并发控制，
  过期写入返回 `409 revision_conflict` 并附带当前记录；
- schema 版本用 `PRAGMA user_version` 驱动有序、事务化的迁移；
  当前为 v2（v1 的 `production_runs.id` 全局主键改为复合主键）；
- 文件数据库启用 WAL、`foreign_keys=ON`、`busy_timeout`；
  测试使用 `:memory:`；
- 媒体二进制不入库，导出文件明确提示媒体不随 JSON 迁移。

不使用 better-sqlite3，避免原生模块编译与跨平台安装问题；`node:sqlite`
在 Node 22.13+ 可用且无需启动参数，CI 需要锁定 Node 版本并显式验证。

## 后果

正面：

- 零外部服务、零原生依赖，本地开发与 CI 可直接跑；
- 事务、崩溃恢复和单文件备份由 SQLite 提供；
- `revision` 让两个浏览器至少能发现冲突，而不是静默覆盖；
- 一个 JSON 文档保留了当前领域快照的完整性，不需要为未稳定的实体设计表结构。

代价：

- 单写入者；多进程/多实例部署前必须换成 PostgreSQL 或增加串行化层；
- 整工作区 PUT 会重写全部运行投影，规模大时需要改为增量写入；
- 没有字段级合并：冲突只能整体拉取或整体覆盖；
- `node:sqlite` 在 Node 22 中仍标记为实验性，需要 CI 运行验证；
- 无鉴权与租户隔离，当前只适合本机使用；
- 媒体文件不在备份内，跨设备恢复后引用可能失效。

## 备选方案

| 方案 | 不选原因 |
|---|---|
| 单表 PostgreSQL JSONB | 需要额外服务与运维；Step 3 还没有队列/多租户，收益不足 |
| 服务端 JSON 文件 | 无事务、无并发控制、崩溃时容易写坏；备份与迁移都要自己实现 |
| 规范化 SQLite 表（每个实体一张表） | 领域尚未稳定，迁移成本高；当前没有按实体查询的需求 |
| IndexedDB / 浏览器存储 | 不能跨设备，正是 Step 3 要解决的问题 |

## 升级路径

当出现以下任一信号时，重新评估并新开 ADR：

- 需要多实例部署或并发写入；
- 工作区体积导致整文档重写不可接受；
- 需要按实体审计、软删除或字段级合并；
- 对象存储/媒体二进制进入范围（ADR-003）。

## 验证

- `apps/api/src/app.test.ts`：创建/读取、revision 冲突、非法数据不写入、
  v1 读取升级、跨工作区相同 run id、导出。
- `apps/api/src/db/database.test.ts`：v1→v2 迁移保留数据并改为复合主键。
- `libs/domain/src/workspace.test.ts`：v1→v2 快照迁移、未来版本拒绝、
  导出/导入往返、损坏 JSON 拒绝。
