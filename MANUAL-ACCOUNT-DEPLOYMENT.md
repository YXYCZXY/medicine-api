# 个人中心 / 账号删除：手动联调与部署

交接日期：2026-11-08。所有命令由你手动执行。下文未注明「服务器终端」的命令均在 Mac 终端执行。

## 0. 当前实际状态

**2026-11-09 更新：你已手动完成部署。** `release.env` 为 `20261108-account-management-b-01`，API 与 PostgreSQL healthy，`adminKeyConfigured=true`，账号删除迁移已完成且未回滚。下方列表是最初交接时的历史状态；当前直接从第 5 步继续，无需重做第 1–4 步的发布操作。

- 本轮后台上传已经停止，线上 API 与 PostgreSQL 均 healthy。
- 线上版本仍是 `20261108T062701Z-5f8aa2c-458542`。
- 候选版本 `20261108-account-management-b-01` 尚未部署；约 299 MiB 的镜像包，服务器只上传了 165027840 字节（约 157 MiB）。
- 本次数据库迁移尚未执行；本次发布的迁移前备份也尚未创建。
- Supabase 管理密钥已经写入本地 `.env` 和服务器 `/opt/medicine-api/api.env`，均为 600 权限；从服务器验证了管理权限有效。正在运行的旧容器尚未重新加载新增变量。
- Supabase Phone 开启、短信确认开启、现有短信 Hook 正常；当前 Storage bucket 数为 0，因此本轮无需执行 Storage RPC 迁移。
- 尾号 5090 的手机号当前对应的新账号与早先短信测试账号的 ID 不同。联调前检查了当前账号：健康记录为空、没有自定义标签；你已选择此手机号做删除验收。
- 已完成一次真实短信登录、公网身份核验。已写入临时药品、就诊及照片、提醒、打卡、血压、临期状态和同步历史；昵称已改为「删除联调专用账号」。标签样本步骤曾因测试脚本使用了错误路由而中止，现已修正，修正后尚未重新执行。
- 没有请求本轮删除验证码，没有提交永久删除，测试账号和临时数据仍保留。
- 独立原生 App 已建立真实加密 SQLite 与照片缓存；清理前证据通过，清理后验证未进行。主 App 没有被该独立沙盒覆盖。
- 后端 136 项单元测试、96 项 HTTP 测试、8 项隔离 PostgreSQL 删除测试、15 项部署流程隔离测试通过。47 项其他数据库测试按默认配置跳过。

## 1. 进入项目，打开 Docker Desktop

```sh
cd "/Users/yuanxiaoyang/个人/code/medicine-api"
docker ps
ssh -i "$HOME/.ssh/id_ed25519_vultr" root@139.180.212.148 'cat /opt/medicine-api/release.env; docker ps --filter name=medicine-api --format "{{.Names}} {{.Status}}"'
```

预期：本机 Docker 正常；服务器版本仍为上面的旧版本，API 与数据库 healthy。若版本已经改变，先停止：后面的增量脚本固定针对本次旧版本与候选版本，不可用于别的发布。

## 2. 只读复核配置

```sh
node deploy/account-deletion-live.mjs preflight
```

预期：`supabase-admin-key.ok=true`、`supabase-storage.bucketCount=0`、Phone 开启。部署前 `deletionTablesReady=false`，旧容器 `adminKeyPresent=false` 都是正常的当前状态。

`previous-test-account-login` 可能显示 `invalid_credentials`，因为旧密码已失效；后续用本轮短信会话，不需要重设密码。`previous-test-account-lookup` 现在显示临时记录数量不为零也是预期，不应再宣称账号为空。

如果需要重新确认服务端环境文件配置，可以执行：

```sh
node deploy/configure-account-deletion.mjs
```

预期：`configured=true, changed=false, restartPerformed=false`。命令只更新同一管理密钥，不重启；不要上传整份本地 `.env`。

## 3. 选择一种发布方式，只执行一种

### 方式 A：原有标准发布路径

这是经过 15 项隔离流程测试的路径，会重新上传完整镜像包，当前网络下可能较慢，不会从 157 MiB 自动续传。

```sh
bash deploy/update.sh --upload-only 20261108-account-management-b-01
```

预期依次出现：发布包校验全部 `OK` → Uploading release → Backing up / applying migrations → API healthy → `Update succeeded` → 本地数据库备份路径。

### 方式 B：本次专用增量传输路径

本机试验已证明解压后的归档只有约 0.4 MiB 差异，可明显减少上传。本脚本已准备并做语法检查，但之前的执行申请被拒绝，因此**没有完成过真实端到端执行**。愿意采用这条路径时，先阅读 `deploy/resume-account-deployment.mjs`。

先确认准备好的完整解压归档仍在：

```sh
ls -lh /private/tmp/account-upload-delta/current.tar
```

预期：约 300 MiB。如果文件不存在，手动重建：

```sh
mkdir -p /private/tmp/account-upload-delta
gzip -dc deploy/artifacts/20261108-account-management-b-01/images.tar.gz > /private/tmp/account-upload-delta/current.tar
```

然后执行：

```sh
node deploy/resume-account-deployment.mjs
```

该命令固定针对本次候选版本：复用服务器上一版归档作为 rsync 基础 → 用相同缓存镜像中的 gzip 在两端确定性压缩 → 核对完整镜像 SHA-256 与发布包 → 调用既有 `update-server.sh` → 下载备份。它不跳过数据库备份或迁移核验。

预期：`complete-release-package-verified`，随后 `Update complete`，最后 `deployment-complete`。若任何步骤失败，不要同时启动方式 A 或另一份方式 B。停止并按文末排查。

## 4. 部署后检查公网与数据库

Mac：

```sh
curl -fsS https://api.uk-io.com/health
curl -sS -o /dev/null -w '%{http_code}\n' https://api.uk-io.com/users/me
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://api.uk-io.com/users/me/deletion-code
```

预期分别为 `{"status":"ok"}`、`401`、`401`。未登录请求不能访问业务或发送删除验证码。

连接服务器：

```sh
ssh -i "$HOME/.ssh/id_ed25519_vultr" root@139.180.212.148
```

服务器终端执行：

```sh
cat /opt/medicine-api/release.env
docker ps --filter name=medicine-api --format '{{.Names}} {{.Status}}'
docker exec medicine-api node --input-type=module -e 'console.log(JSON.stringify({adminKeyConfigured:!!process.env.SUPABASE_SERVICE_ROLE_KEY}))'
docker exec medicine-api-postgres psql -U postgres -d medicine -c "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = '20261108010000_account_deletion';"
docker exec medicine-api-postgres psql -U postgres -d medicine -c "SELECT to_regclass('public.account_deletion_tasks'), to_regclass('public.account_deletion_receipts'), to_regclass('public.account_deletion_challenges');"
exit
```

预期：版本为 `20261108-account-management-b-01`，API healthy，`adminKeyConfigured=true`；迁移记录 `finished_at` 非空、`rolled_back_at` 为空；三张删除流程表均存在。

不要直接 `cat api.env`，上面的检查不会显示密钥。

## 5. 完成临时数据准备

回到 Mac / medicine-api 目录：

```sh
node deploy/account-deletion-exercise.mjs seed
```

预期最后有 `live-business-fixture-coverage` 和 `report.ok=true`，覆盖 14 类业务及关联表。该命令复用已保存的 UUID/同步操作号，能重放本次未完成的样本；不会另选账号。

会话与操作凭据保存在 `/private/tmp/qfj-account-deletion-live.json`（600 权限）。**不要删除该文件，也不要改动已有样本的 UUID、requestedAt 和同步命令日期**：重放要求这些字段保持一致。2026-11-09 可以继续使用本轮 11 月 8 日的历史记录；如果未来另起全新验收，应单独准备新样本。

如果出现 `TEST_SESSION_REFRESH_FAILED refresh_token_already_used`，先在 Mac 请求一条新的登录短信。此命令核对已有状态中的账号 ID、手机号、业务账号 active 状态和 Supabase 身份，不要求清空已有样本，不创建新账号，也不提交删除：

```sh
node deploy/account-deletion-live.mjs relogin-code
```

预期：`stage=relogin-code`、`ok=true`、`phoneSuffix=5090`、`progressPreserved=true`。手机收到验证码后，在同一 Mac 终端执行（不要在 App 中核验这条验证码）：

```sh
read -rs "account_login_otp?请输入刚获取的登录验证码："
printf '\n'
node deploy/account-deletion-live.mjs login-verify "$account_login_otp"
unset account_login_otp
```

预期：`real-sms-login.ok=true`、`businessStatus=200`。然后重跑 `node deploy/account-deletion-exercise.mjs seed`。上面 `read` 的写法适用于 Mac 默认 zsh。这里只更新登录会话，保留原有样本和其他账号验收基线。重新登录入口是本机脚本更新，无需重新发布 API。

注意：不要再使用 `login-code` 模式去申请这一步的验证码。它要求账号为空，而当前账号已经有本轮临时样本，会按设计拒绝。

## 6. 保持独立原生 App 在前台

在 iPhone 17 模拟器打开「账号真实联调」。预期显示 `LIVE_NATIVE_DATA_READY`。

Mac：

```sh
cd "/Users/yuanxiaoyang/个人/code/medicine-app"
node scripts/check-account-live.cjs before
```

预期：`ok=true`、`databaseKeyPresent=true`、`photoDirectoryPresent=true`、`authPresent=true`，`databaseFileCount` 至少 1，`sessionInjectionFilePresent=false`。本轮已经核验过一次，当时数据库及附属文件共 3 个。

现有独立 App 沙盒仍在时，不要重新注入第 5 步的新脚本会话。脚本和原生 App 应各用独立登录会话，否则刷新令牌可能被另一端先使用。

仅当独立 App 被卸载或临时沙盒路径失效、确实需要重建时执行：

```sh
node scripts/build-account-live.cjs
node scripts/prepare-account-live.cjs
```

预期：打包成功，`installed=true`、`sessionSeeded=true`。关闭后重开独立联调 App，再核对 `before`。它使用单独 bundle id，不覆盖主 App；依赖已存在的 `/private/tmp/qfj-auth-build/.../MediTrace.app` 原生构建，不能用于商店发布。

重建过程会把当前脚本会话注入原生 App。完成后，必须再按第 5 步 `relogin-code` → `login-verify` 为脚本建立一份新的独立会话，再继续后续命令；不要把这份新会话再次注入 App。

## 7. 获取新的删除验证码

```sh
cd "/Users/yuanxiaoyang/个人/code/medicine-api"
node deploy/account-deletion-exercise.mjs deletion-code
```

预期：手机收到一条新的删除流程短信；`real-deletion-sms-sent-and-cooldown-enforced.ok=true`。脚本同时验证立即重发返回 429，且获取验证码不会创建删除任务。

使用这条新短信，不要使用前面的登录验证码。重新发送至少等待 60 秒；验证码业务有效期 5 分钟。

## 8. 明确的不可逆步骤：删除已选专用账号

确认尾号 5090 仍仅用于这次测试后，Mac 默认 zsh 执行：

```sh
read -rs "account_deletion_otp?请输入刚收到的删除验证码："
printf '\n'
node deploy/account-deletion-exercise.mjs delete "$account_deletion_otp"
unset account_deletion_otp
```

**这条命令会永久删除该账号、全部云端业务数据和 Supabase Auth 身份，不设恢复期。** 它会先用明确错误的验证码检查拒绝且不创建任务，再用你输入的验证码正式提交。

预期依次包含：

```text
real-wrong-otp-rejected-without-deleting
real-deletion-accepted-202
old-session-business-access-denied
old-session-late-attachment-denied
real-deletion-task-completed
all-fourteen-business-and-related-tables-erased-other-accounts-identical
temporary-account-task-and-challenge-erased
real-supabase-auth-hard-delete-confirmed
other-device-deletion-status-confirmed
wrong-task-capability-rejected
```

所有检查均为 `ok=true`，最终 `report.ok=true`。如果别的账号在此期间正常修改记录，摘要比较也可能失败，需要核对差异，不能单凭比较失败断言误删。

如果提交后网络中断或命令报错，不要重新点击删除或重跑 `delete`。只查询已经保存的任务：

```sh
node deploy/account-deletion-exercise.mjs verify
```

预期最终确认完成。只要仍是 `processing` 或验证失败，就保留状态文件，继续查询/排查，不将它当成删除成功。

## 9. 核对原生设备清理

保持「账号真实联调」在前台并联网，等待约 30 秒以上。它作为另一设备，通过服务端状态确认删除后应清理自己的本地数据，最终显示 `LIVE_SIGNED_OUT`。

```sh
cd "/Users/yuanxiaoyang/个人/code/medicine-app"
node scripts/check-account-live.cjs after
```

预期：

```json
{
  "databaseKeyPresent": false,
  "photoDirectoryPresent": false,
  "authPresent": false,
  "accountCachePresent": false,
  "pendingMarkerPresent": false,
  "databaseFileCount": 0,
  "ok": true
}
```

如果 `live-account-after.json` 不存在，说明原生清理尚未确认完成，不是「已经删除」。先看 App 的状态/错误并继续联网重试。离线设备只有下次联网确认后才能清理。

## 10. 编译正式客户端

后端与上面真实验收通过后，在 medicine-app 执行：

```sh
cd "/Users/yuanxiaoyang/个人/code/medicine-app"
yarn typecheck
yarn test --runInBand
EXPO_PUBLIC_LOCAL_TEST_AUTH=false EXPO_PUBLIC_LOCAL_TEST_STANDALONE=false ./node_modules/.bin/expo run:ios --configuration Release --no-bundler --device "iPhone 17"
```

预期类型检查与测试通过，正式 App Release 构建安装到指定模拟器，API 地址为 `https://api.uk-io.com`。不要使用 `ios:offline`，它会启用离线测试模式。

此命令是模拟器安装，不是 App Store/TestFlight 发布；商店发布还需独立的签名、归档与上传流程。本轮尚未做商店发布。

## 11. 失败时查什么

服务器终端：

```sh
docker logs --tail 100 medicine-api
docker exec medicine-api-postgres psql -U postgres -d medicine -c "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 3;"
ls -lh /var/backups/medicine-deploy/
```

- `DELETION_UNAVAILABLE`：检查新容器是否读取管理密钥，不是把 key 写到客户端。
- 验证码 429：等 60 秒；错误/过期：重新发送，不绕过短信校验。
- 任务处理中：等待后台每 30 秒重试，保留任务查询文件。
- 发布脚本在尝试迁移后失败：可能按设计停住 API。保留备份与日志，先查迁移及容器错误；不要盲目恢复旧数据库或强行回滚。
- 新迁移已经落地后，旧版本回滚可能被兼容性检查拒绝，这是保护措施，不要绕过。
- 若提示本机更新锁存在，先确认无更新进程。不要直接删除活动锁。

真实联调报告在 `/private/tmp/account-deletion-exercise-*.json`，原生证据在 `/private/tmp/account-native-proof-*.json`。登录会话与任务凭据文件含敏感信息，不要贴到聊天、提交到 Git 或公开分享。

数据库备份成功后应存在：

```text
/Users/yuanxiaoyang/个人/code/.deployment-backups/medicine/pre-20261108-account-management-b-01.dump
```

最后完成标准：新版本 healthy + 新迁移完成 + 真实 Supabase Auth 查无该测试账号 + 14 类业务关联数据清理验证通过 + 其他账号摘要不变 + 原生 after.ok=true。当前还未达到这些部署/删除完成条件。
