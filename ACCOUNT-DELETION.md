# 账号删除实现与联调

2026-11-08。客户端已按用户选择的 B「原生分组列表」实现。用户决定本轮仅完成代码与隔离测试，真实 Supabase 联调等管理密钥配置后再进行。没有发送真实删除验证码、删除真实账号或部署迁移。

## 部署顺序

1. 先部署业务数据库迁移 `20261108010000_account_deletion`。命令：`npm run prisma:migrate`；随后 `npm run prisma:generate`。
2. 在后端配置该 Supabase 项目的 `SUPABASE_SERVICE_ROLE_KEY`，只存服务端。客户端只能使用 publishable key。没有管理密钥时删除接口返回 `503 DELETION_UNAVAILABLE`，后台清理不启动。
3. 如果项目存在 Supabase Storage bucket，先在该 Supabase 项目执行 `supabase/migrations/20261108010000_account_owned_storage.sql`。该 RPC 只授权 service_role，以 `storage.objects.owner_id` 查找准确归属；实际对象删除走 Storage API。不能按目录前缀猜测归属。由服务端以管理员身份上传、owner_id 为空的对象必须由上传系统设置准确归属后再启用此功能；当前应用附件存在业务数据库，由业务清理事务删除。
4. 启用现有 Supabase 手机短信认证及短信 hook，使用专用测试账号验证验证码发送、核验、Storage 和 Auth 硬删除；不要用日常账号验收。
5. 后端、数据库兼容部署且专用账号验收完成后，再发布客户端。

本机主业务库的迁移状态检查显示新迁移待执行。本轮未向该库部署迁移。

## 协议与恢复

保留 `GET/PATCH /users/me`。新增接口：

| 接口 | 授权 | 行为 |
| --- | --- | --- |
| `POST /users/me/deletion-code` | 当前有效登录身份 | 仅向绑定手机号发送验证码，不创建账号；60 秒冷却、5 分钟业务有效期、最多 5 次验证 |
| `DELETE /users/me` | 当前有效登录身份 | `code` 六位、`confirmation=DELETE_ALL_DATA`、客户端 UUIDv4 `operationId` 与 32 字节随机十六进制 `receiptSecret`；验证身份一致才受理，返回 202 |
| `GET /account-deletions/:id` | Bearer 任务专用 secret | 仅返回该任务 `processing/completed/cancelled`；不依赖已删除的 Supabase 身份 |
| `POST /account-deletions/:id/cancel` | 同一任务专用 secret | 仅取消尚未受理的请求，封住响应丢失后延迟 DELETE 的窗口；已受理返回 409，不能撤销 |
| `GET /users/me/deletion-status` | 本项目历史签名的用户 JWT | 仅返回该用户 `active/deleting/deleted`。允许历史过期令牌，仅用于其他设备确认是否清理本机数据，不能访问业务数据 |

受理事务创建持久化任务、哈希凭据回执并标记账号 `deleting`。所有业务写入、同步、上传在同一账号事务锁下重新核验状态。普通访问每次检查远端身份，失效身份不能被首次登录逻辑重新创建。

后台启动恢复任务，每 30 秒检查，原子抢占租约，失败退避重试。先在业务事务内清理健康记录、药品、照片附件、字典、提醒及其历史快照、同步回执和删除标记；事务失败回滚。之后清理 Supabase Storage，再 Auth 硬删除，最后删除业务账号与任务。外部超时、进程退出、重复提交均可重试，不将失败标成成功。

任务完成后保留不含用户 ID、手机号或业务数据的匿名回执 30 天，仅含随机任务 ID、secret 哈希、状态和到期时间；随后删除。查询凭据仅能查询或取消自己的未受理提交。

客户端提交前持久化恢复标记；受理或结果未知时冻结业务、停止同步并等待数据库/照片操作关闭。云端完成后只清理该账号 SQLite/WAL/SHM/journal、照片目录、数据库密钥、账号缓存和登录凭据。确认完成标记先落盘、清理标记最后删除，App 重启可继续。普通断网、刷新失败或登录过期不清理本地数据。

离线其他设备只能在下次联网确认后清理。平台备份和供应商日志按各自保留期限清除，界面未承诺即时抹除这些副本。

## 本轮隔离验收

- 后端单元测试：136 项通过。
- 常规 HTTP 测试：96 项通过；47 项依赖其他独立数据库的既有测试按默认配置跳过。
- `node scripts/test-account-deletion.mjs`：8 项通过，在本机专用测试库中创建随机独立 schema，执行真实迁移、种入两个账号的 14 类关联数据，完成后仅清理该 schema。Supabase 通过隔离替身，不使用真实管理密钥。
- 验证验证码错误/过期/限流、身份注入、重复提交、其他账号不受影响、数据库故障回滚、Auth 删除响应丢失、重试、旧同步/附件写入阻断、历史签名令牌仅可查询状态。
- 实际 Supabase Auth、Storage、短信供应商与真机文件系统联调未进行；需按部署顺序使用专用账号验收。

官方接口依据：[Auth 硬删除](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser)、[用户管理与令牌说明](https://supabase.com/docs/guides/auth/managing-user-data)、[Storage 对象归属](https://supabase.com/docs/guides/storage/security/ownership)。
