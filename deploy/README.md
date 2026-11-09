# 千方记后端部署

入口 `https://api.uk-io.com`，链路为 Cloudflare → 现有 Nginx → `127.0.0.1:3100`。API 与迁移镜像自带 Node 24，复用现有 PostgreSQL 18 容器。

## 后续一键更新（推荐）

先打开 Docker Desktop。修改完后端后，在项目根目录执行：

```sh
yarn server:update
```

也可以在 Finder 双击项目根目录的 `更新后端.command`。完成前请保持电脑联网，不关闭终端。

脚本自动生成唯一版本号，按锁文件安装本地依赖、生成 Prisma Client、运行静态检查与本地测试，在本机构建 Linux amd64 镜像，再上传服务器。服务端先检查旧迁移是否被修改、磁盘空间与包校验，再加载镜像、保存旧版本配置、暂停 API 写入、备份数据库、执行迁移、启动新版本，最后验证数据库健康、公网 HTTPS 和未登录请求 401。默认不跑需要独立 PostgreSQL 测试库的集成测试。

更新完成后会把迁移前数据库备份下载到本机 `../.deployment-backups/medicine/pre-版本号.dump`，文件权限 600。备份下载失败时会明确提示“服务器更新成功、备份下载失败”；此时不要重新发布相同版本，单独补下载即可。完整备份恢复测试仍需独立执行。

服务器 `api.env` 中已有的配置会保留；普通后端更新不改 DNS、Nginx、数据库容器和其他服务。新增必填环境变量时，先在服务器 `/opt/medicine-api/api.env` 配置，再更新。不要把本机 `.env` 上传服务器。数据库结构变更必须提供新的 `prisma/migrations/*/migration.sql`；已上线迁移文件不允许修改或删除。

普通代码更新失败且没有尝试新迁移时，自动恢复旧镜像与配置。如果已尝试新迁移，失败后暂停 API、保留数据库现状并打印迁移前备份和旧配置位置，避免盲目恢复导致用户数据丢失。此时需人工判断结构与数据的恢复方式。更新期间会有短暂维护时间，不提供零停机保证。

上传中断时，可使用已经构建完成的新格式发布包重试：

```sh
bash deploy/update.sh --upload-only 终端显示的版本号
```

需要手动指定新版本号时：

```sh
bash deploy/update.sh --release 20261107-01
```

同一个版本号不能覆盖发布。构建中断留下的目录也不会被覆盖；重新构建请换新版本号。旧镜像、发布包和迁移前备份保留，脚本不会全局清理 Docker；磁盘不足会在停服前停止更新。可以通过 `MEDICINE_SSH_TARGET`、`MEDICINE_SSH_KEY` 覆盖默认服务器与私钥位置。

## 首次安装：手动构建与发布

在 medicine-api 根目录执行，版本号必须唯一；已上线版本不要覆盖：

```sh
bash deploy/build.sh 20261106-01
ssh -i ~/.ssh/id_ed25519_vultr root@139.180.212.148 'install -d -m 700 /opt/medicine-api/releases/20261106-01'
scp -i ~/.ssh/id_ed25519_vultr deploy/artifacts/20261106-01/* root@139.180.212.148:/opt/medicine-api/releases/20261106-01/
ssh -i ~/.ssh/id_ed25519_vultr root@139.180.212.148 'bash /opt/medicine-api/releases/20261106-01/install.sh 20261106-01'
```

发布包含当前工作区的未提交代码。镜像上下文采用允许清单，排除环境文件、私钥、测试凭据和旧构建产物。Linux amd64 镜像在本机构建；服务器验证 SHA-256 后备份、迁移、启动、等待健康，再启用 Nginx。

服务器 `/opt/medicine-api/api.env` 权限 600，仅保存必要运行变量。DATABASE_URL 从 `/opt/medicine-db/.env` 读取，不在终端打印；`public.env` 仅包含 Supabase URL 与公开的 Publishable Key。

## 域名与客户端

Cloudflare 添加 A 记录 `api` → `139.180.212.148`，开启代理，TTL 自动，使用 Full (strict)。现有 Cloudflare Origin CA 证书覆盖该域名，需通过 Cloudflare 访问，浏览器不直接信任源站证书。

SSL、缓存、验证规则的调整限定为 `api.uk-io.com`。API 响应应保持 `Cache-Control: private, no-store`，原生请求不能被交互式浏览器挑战拦截。

App `.env` 与 `.env.local` 使用 `EXPO_PUBLIC_API_URL=https://api.uk-io.com`。重启 Expo 后重新加载 App；修改环境文件不会更新已安装的独立构建，独立构建需重新打包。

## 运维

### Supabase 短信 Hook（阿里云号码认证）

`POST https://api.uk-io.com/hooks/supabase/send-sms` 使用 Standard Webhooks 原始请求体验签，不接受用户 Token 代替签名。Supabase 生成和校验 OTP，服务器仅转发 OTP 到 `dypnsapi.aliyuncs.com` 的 `SendSmsVerifyCode`。模板沿用 `code`、`min` 变量，`min=5`、`ValidTime=300`、`Interval=60`；应确认现有模板和 Supabase 验证码有效期的显示一致，不在此功能中修改认证配置。

默认 `SMS_HOOK_ENABLED=false`，未配置密钥不影响原 API。先部署新版，再通过 SSH 在服务器交互填写（所有输入隐藏，不粘贴到聊天或命令行参数）：

```sh
python3 /opt/medicine-api/configure-sms.py
```

脚本逐项读取现有 `SEND_SMS_HOOK_SECRET`（Auth Hooks 页面完整 `v1,whsec_…` 值）、`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME` 和 `ALIYUN_SMS_TEMPLATE_CODE`。原阿里云 Secret 不可从 Supabase Secrets 页面恢复；使用你保存的原值。脚本在隔离容器中验证配置、以 600 权限保存环境备份并原子更新 `/opt/medicine-api/api.env`，启用 Hook 后重建 API 容器；启动失败恢复原配置。更新脚本会在停服之前检查新镜像环境配置。

启用后无签名请求应返回 `401`，禁用时 `503`；有效请求成功返回 `200 {}`，供应商失败/3.5 秒超时返回 `502`。错误响应为 `{error:{http_code,message}}`，不包含供应商原始消息。请求失败不自动重试，超时不代表短信一定未发送。同一实例最多缓存 1000 个在途/成功请求；相同 webhook-id 和相同原始请求体合并并发发送，成功缓存五分钟，进程重启和容量淘汰后不保证去重。

先验证 `/health=200`、`/users/me=401` 及无签名 Hook=401，再将 Supabase Authentication → Hooks → Send SMS 的 Endpoint 改为上述新地址，保留原 Secret。用测试手机完成实际收码、Supabase 核验，查看 `sms_accepted`/`sms_failed` 的耗时、错误码和供应商 RequestId。不得把原始 Hook 请求体、短信或密钥写入日志。端到端 Hook 必须在五秒内完成；服务器连通性测试不等于短信验收。

旧地址为 `https://xzstdkjjbpwnzdfursff.supabase.co/functions/v1/send-sms`，保留旧云函数。若新链路失败，先恢复旧 Endpoint，再按现有发布流程回滚；旧链路此前也超时，恢复旧配置不保证恢复发送。密钥配置备份路径由脚本打印，权限 600；不通过普通 `cat` 将其输出。

在服务器执行：

```sh
cd /opt/medicine-api
docker compose --env-file release.env ps
docker compose --env-file release.env logs --tail 100 api
docker compose --env-file release.env restart api
curl -fsS https://api.uk-io.com/health
systemctl status medicine-api-backup.timer
systemctl start medicine-api-backup.service
ls -lh /var/backups/medicine/
```

容器以非 root 用户运行，内存上限 256 MB、Node 堆上限 128 MB、CPU 上限 0.5 核，异常退出自动重启；日志上限 3 × 10 MB。API 和数据库仅监听服务器回环地址，现有 3000 端口服务保留。

`GET /health` 无需登录，实际查询数据库；成功返回 200 与 `{"status":"ok"}`，失败返回 503 与 `{"status":"unavailable"}`，不暴露内部连接信息。

## 备份与恢复

每天北京时间 02:30 后五分钟内备份数据库，保留最近 7 份，目录 `/var/backups/medicine` 权限 700、文件权限 600。定时器错过执行后会补跑。上线前数据库与 Nginx 配置另存 `/var/backups/medicine-deploy`。

备份采用 PostgreSQL 18 `pg_dump -Fc`，完成后验证归档目录。部署后下载一份到本机 `/Users/yuanxiaoyang/个人/code/.deployment-backups/medicine`，在独立 `_test` 数据库完整恢复验证。每日服务器备份不等于每日异地备份，后续需补充异地自动同步。

业务库恢复必须先停 API、备份当前库，再核对目标归档并单独执行。不要把测试恢复命令用于生产库。

## 回滚

使用一键更新后，会保存旧镜像及该版本的 Compose、环境配置和迁移清单。在 Mac 项目根目录执行：

```sh
yarn server:rollback
# 或指定保留的版本
bash deploy/update.sh --rollback 20261106-01
```

也可登录服务器执行：

```sh
bash /opt/medicine-api/rollback.sh
# 或选择一个已经上传的兼容版本
bash /opt/medicine-api/rollback.sh 20261106-01
```

首次部署没有旧 API 版本。一键更新会在第一次更新前保存首发版本状态，因此首发版本也能成为后续回滚目标。回滚前会再次备份数据库，并核对当前迁移与目标快照一致；有结构差异时拒绝自动回滚。脚本只切换镜像和对应配置，不逆向修改数据库；回滚启动失败会尝试恢复原版本。不兼容迁移需人工确认兼容性或停服后单独恢复数据库。

发布和回滚互斥执行；若本机意外断电留下 `deploy/.update-lock`，先确认没有更新任务运行，再手动移除该锁目录。

脚本流程的隔离测试（不联网、不操作真实 Docker 或服务器）：

```sh
python3 -m unittest discover -s deploy -p 'test_update.py' -v
```

## 验收边界

`node deploy/smoke.mjs exercise` 使用本机临时测试凭据验证密码登录、初始化、药品读写、同步幂等、最大 8 MB 附件及 5 并发快照请求；`verify` 在重启后核验并清理临时药品。凭据从 `/private/tmp` 读取，不包含在镜像中，报告不输出密码或令牌。

约 1 GB 的服务器按个人、低并发试用验收。Supabase Email Provider 和 Token 900 秒目标的复核结果记入部署报告；容量、长期可用性和终端验收不能由冒烟测试代替。
