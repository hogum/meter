# 电表采集与用电看板

基于 Cloudflare Workers、D1 和 ECharts 的轻量用电监测平台。定时采集电表读数，按住户展示历史用电、余额及状态推测，并通过企业微信群机器人发送业务提醒。

## 功能

- 账号与密码登录，JWT Cookie 会话，按账号绑定的电表隔离数据。
- 定时采集、失败重试、主键去重，以及采集失败记录展示。
- 功率与余额曲线、预设或自定义区间统计、充值估算和余额预计可用时间。
- 基于用电增量推测有人或无人，历史看板与实时通知分别处理。
- 有人、无人、低余额及充值群通知，按房间配置接收地址。
- 厂商手动上报、历史数据 TXT 导入和导出，以及手动历史数据清理。

有人状态属于启发式推测；余额预计可用时间和充值金额属于估算。当前没有开放注册、同比环比或峰谷分析，Webhook 失败不自动补发。

## 技术与目录

后端使用 Workers 原生能力，不依赖第三方运行时 npm 包；D1 保存 users、data、status 三张业务表。看板数据由服务端注入 HTML，浏览器通过 CDN 加载 ECharts 绘图。

```text
.
├── src/                Worker 入口、路由、采集、统计、鉴权与通知
├── public/             看板页面
├── db/
│   ├── init.sql        新数据库建表
│   └── seed-users.sql  可选演示账号
├── wrangler.jsonc      部署配置、数据库绑定和采集计划
└── README.md
```

本目录可单独作为 GitHub 仓库根目录。以下命令均在本 README 所在目录执行，需要 Node.js、npm 和 Cloudflare 账号；Wrangler 通过 npx 调用，无需单独安装。

## 发布前准备

部署前配置运行时变量 `SOURCE_URL` 和 `METERS`。`METERS` 可以填写 JSON 文本，例如 `{"12345678":"A101"}`。将 `JWT_SECRET` 设为 Secret，使用手动上报时也需配置 `UPLOAD_TOKEN`。D1 绑定在 `wrangler.jsonc` 中配置。

## 更新现有云端项目

当前 Worker 名为 meter，配置绑定已有的 meter D1 数据库。更新代码时保留数据库绑定，无须重新建库、导入本地数据或运行初始化 SQL。

安装 Node.js 与 npm 后登录 Cloudflare，再部署：

```sh
npx wrangler login
npx wrangler deploy
```

已有可用登录或 API Token 时按现有鉴权方式使用即可。部署会上传后端与静态页面，并应用配置中的绑定及每两分钟一次的采集计划；数据库中的业务记录由 D1 独立保存。

配置当前设置 workers_dev: false，访问应以 Cloudflare 控制台中已启用的域名或路由为准，部署返回地址不一定表示 workers.dev 入口已开放。

## 配置项

| 配置 | 用途 |
| --- | --- |
| name | Worker 名，当前为 meter |
| d1_databases | DB 绑定、数据库名称与 ID，更新现有项目时沿用现有值 |
| assets | public/ 静态目录及 ASSETS 绑定 |
| triggers.crons | 定时采集计划，当前每两分钟 |
| METERS | 表号到房间号的映射，供采集和上报共同使用 |
| SOURCE_URL | 定时采集使用的上游设备详情地址 |
| RECHARGE_URL | 充值页面地址，跳转时自动带上当前电表的 `no` 参数。未配置时隐藏按钮 |
| JWT_SECRET | JWT 会话签名密钥 |
| UPLOAD_TOKEN | /api 上报和历史导入凭证 |
| WH_<房间号> | 对应房间的企业微信群机器人地址，未配置则不推送 |

`keep_vars: true` 会保留控制台设置的普通变量。`METERS` 决定采集对象，`users` 表决定账号登录授权。

## 获取企业微信 Webhook 地址

1. 打开企业微信电脑端，在需要接收通知的群中进入“管理聊天信息”。
2. 选择“消息推送”→“自定义消息推送”（旧版入口可能显示“群机器人”）。
3. 填写名称等信息，创建后复制页面提供的完整 Webhook 地址；已有推送可由创建者查看详情获取。
4. 在 Cloudflare Worker 的运行时 Variables and Secrets 中添加对应房间的变量，例如 `WH_A101`，值填刚复制的完整地址。

每个房间按 `WH_<房间号>` 配置；未配置的房间仍会采集和展示数据，但不发送群通知。实际地址不要提交到 GitHub。

[企业微信官方消息推送配置说明](https://developer.work.weixin.qq.com/document/path/99110) · [腾讯云获取步骤图解](https://cloud.tencent.com/document/product/1759/128391)

## GitHub 自动部署

把本目录的内容上传为 GitHub 仓库后，在 Cloudflare 控制台选择现有 meter Worker，进入 Settings → Build，连接仓库并选择生产分支。使用 Workers Builds 即可，无需额外编写 GitHub Actions。

| 设置 | 值 |
| --- | --- |
| 根目录 | 仓库根目录，保留默认值 |
| 构建命令 | 留空 |
| 部署命令 | npx wrangler deploy |

控制台 Worker 名须与 wrangler.jsonc 中的 name 一致。以后推送生产分支即可触发构建部署。若上传的是包含 code/ 的整个项目仓库，则将根目录设为 code。

Webhook 地址应在 Worker 的运行时 Variables and Secrets 中设置，不是仅供构建阶段使用的环境变量。GitHub 仓库中只保留对应的配置说明。

官方说明：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 仅部署到全新账号或空数据库时

先创建新 D1，并把返回的数据库 ID 写入 wrangler.jsonc，绑定名保持 DB；同时设置自己的变量和可用域名。

```sh
npx wrangler d1 create meter
npx wrangler d1 execute meter --remote --file db/init.sql
```

init.sql 只创建 users、data、status 三张表。需要在本地试用演示账号时，先初始化本地数据库，再导入账号：

```sh
npx wrangler d1 execute meter --local --file db/init.sql
npx wrangler d1 execute meter --local --file db/seed-users.sql
```

`seed-users.sql` 提供一个本地演示账号。账号和密码都输入 `demo`，绑定的示例表号为 `12345678`。账号中的英文字母不区分大小写，已有同名账号保持不变。

管理员可在 `users.pw` 填入加盐的 PBKDF2 哈希或临时明文密码。明文密码首次验证成功后会替换为随机加盐的哈希，再建立登录会话。`pbkdf2-sha256$` 前缀保留给哈希格式。首次登录前，明文可被有权读取数据库的人看到，也可能进入数据库备份。

最后执行部署命令，后续数据由定时采集或厂商上报写入。

## 可选本地预览

把 `example.env` 复制为同目录下的 `.env`，填入采集地址、表号映射和本地登录用的签名密钥。

```sh
npx wrangler dev
```

本地状态与云端数据分离。当前工作区已清理本地数据库，新生成的本地环境需要单独初始化表、账号与样本；不会自动下载云端数据。

## 上游采集接口

Worker 对 `SOURCE_URL` 发起 GET 请求，并通过查询参数 `SerialNo` 传入 `METERS` 中的表号，例如 `GET /device-detail?SerialNo=12345678`。上游应返回 HTTP 200 和如下 JSON，示例中的数据均为虚构。

```json
{
  "success": true,
  "response": {
    "serialNo": "12345678",
    "houseName": "A101",
    "lastOnlineTime": "2026-11-17 12:00:00",
    "readNumber": 1234.56,
    "residualAmount": 78.9,
    "valveStateName": "合闸"
  }
}
```

- `serialNo` 是表号字符串，应与请求的 `SerialNo` 一致。房间名优先取 `houseName`，为空时取 `userName`。
- `lastOnlineTime` 是这条读数的采样时间，使用东八区的 `YYYY-MM-DD HH:mm:ss` 格式。
- `readNumber` 是累计电量（kWh），`residualAmount` 是剩余电费（元），两者使用 JSON 数字。
- `valveStateName` 若为 `null`，这条采样会被跳过。

## 请求入口

| 方法与路径 | 说明 |
| --- | --- |
| GET / | 登录页或当前住户看板 |
| POST /login、POST /logout | 登录与退出 |
| GET /export | 导出当前账号绑定电表的成功记录 |
| GET /recharge | 登录后跳转到配置的充值页面 |
| GET /api?act=up&tk=xxx | 打开 TXT 历史数据上传页 |
| POST /api?act=up&tk=xxx | 提交实时读数或导入 TXT 历史数据 |
| GET /clean | 登录后手动删除当前电表 90 天前的采样，保留账号及状态；无页面按钮，不自动执行 |

GET 和 POST 都通过查询参数 `tk` 校验 `UPLOAD_TOKEN`。实时上报在 POST 表单中提交 `no`（表号）、`kwh`（累计读数）和 `balance`（余额）。可选的 `room` 必须与 `METERS` 映射匹配。服务端使用接收时间，跨秒重复请求由调用端控制。

```sh
curl -d 'no=12345678&kwh=1234.56&balance=78.9' 'https://example.com/api?act=up&tk=xxx'
```

历史导入使用上传页，也可直接用 `multipart/form-data` 提交 `file` 字段。文件为 `/export` 导出的 UTF-8 TXT（最大 16 MiB），支持厂商 JSON 和以 `manual` 开头的 CSV。导入保留原采样时间，同一电表同一时间的成功记录会跳过，失败记录可补齐。页面显示写入和跳过条数。导入静默补齐历史，实时状态和通知由后续采集或上报推进。

导出 TXT 包含厂商成功采样的 JSON 原文和手动上报的 CSV 记录。
