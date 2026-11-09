<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## 用户系统：Supabase 手机号认证

App 直接使用 Supabase Auth 完成手机号密码注册、短信确认、密码登录及当前设备退出。NestJS 不保存密码或签发登录令牌；原 /auth/register、/auth/login、/auth/logout 已移除。

后端配置 SUPABASE_URL、SUPABASE_PUBLISHABLE_KEY 和原有 DATABASE_URL。自动从固定项目 JWKS 获取 ES256 公钥，验证签名、issuer、audience、有效期、UUID、角色、session_id、非匿名身份及 password 或 otp AMR。缺少这两种方式的会话返回 AUTH_METHOD_UNSUPPORTED；单独 token_refresh、recovery 或 OAuth 不授予业务访问。首次初始化仍核对 Auth 端已确认手机号，已有账号继续校验手机号一致性和 active 状态；公钥/身份查询暂不可用返回 503。短信登录复用现有 SMS Hook，无数据库迁移。应先更新后端再上线客户端。无需手动提供 JWT 公钥或 Supabase 私密密钥。

所有业务请求先幂等初始化用户和默认字典：首次通过 Auth getUser 确认手机号，事务内使用同一用户锁创建 users 与 user_dictionaries。已有昵称、自定义标签和空数组不会被登录覆盖。业务 users.id 等于 Supabase UUID；继续使用现有用户上下文隔离药箱、就诊、提醒、血压、附件及同步数据。

GET /users/me 返回 { id, phone, nickname, avatarUrl, status }；PATCH /users/me 仅接受 nickname。字典与 protocolVersion 2 同步接口保持原有结构。

### 结构迁移

运行 npm run prisma:generate、npm run prisma:migrate，再构建并启动 API。迁移 20261106010000_supabase_phone_auth 要求 users 为空；旧数据清理必须另行执行，结构迁移不隐式删数据、不做手机号身份合并。旧账号密码激活脚本已移除。

配置 Supabase Phone、短信确认及短信服务商；关闭未使用的 Email Provider，目标 Access Token 期限为 900 秒。本次真实项目联调观察到期限仍为 3600 秒，控制台配置尚需调整。认证系统支持多设备登录，退出当前设备不影响其他设备。JWT 已签发后可能有效到到期。

完整客户端状态及离线边界见 [用户系统实施说明](../medicine-app/doc/Supabase%20Auth登录与会话管理方案.md)。

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

健康提醒的真实 PostgreSQL 集成测试默认跳过。需要验证迁移、事务回滚、外键及并发时，显式指定一个数据库名以 `_test` 结尾的独立测试库：

```powershell
$env:REMINDERS_TEST_DATABASE_URL = 'postgresql://user:password@localhost:5432/medicine_test'
npm run test:e2e -- test/reminders.postgres.e2e-spec.ts
```

该测试在随机 schema 中依次执行迁移，结束后清理该 schema，不使用业务 `DATABASE_URL`。

## Deployment

本项目自有服务器的打包、发布、域名、备份与回滚见 [部署操作说明](deploy/README.md)。

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

To add it to this project:

```bash
$ npm install @nestjs/observe
```

Then follow the [setup guide](https://docs.nestjs.com/observability/overview) - it takes a single import and an app key.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
