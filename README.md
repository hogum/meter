# 电表采集与用电看板

基于 Cloudflare Workers、D1 和 ECharts 的轻量用电监测平台。定时采集电表读数，按住户展示历史用电、余额及状态推测，并通过企业微信群机器人发送业务提醒。

## 功能

- 账号与密码登录，JWT Cookie 会话，按账号绑定的电表隔离数据。
- 定时采集、失败重试、主键去重，以及采集失败记录展示。
- 功率与余额曲线、预设或自定义区间统计、充值估算和余额预计可用时间。
- 基于自适应房间基线（`status.base_line`，点击“近 7 天”自动计算最优功率阈值与判定窗口）推测有人或无人，历史看板与实时通知共用同一套状态机。
- 有人、无人、低余额及充值群通知，按房间配置接收地址。
- 厂商手动上报、历史数据 TXT 和 JSONL 导入、TXT 导出，以及手动历史数据清理。

有人状态属于启发式推测；余额预计可用时间和充值金额属于估算。当前没有开放注册、同比环比或峰谷分析，Webhook 失败不自动补发。

## 技术与目录

后端使用 Workers 原生能力，不依赖第三方运行时 npm 包；D1 保存 users、data、status 三张业务表。看板数据由服务端注入 HTML，浏览器通过 CDN 加载 ECharts 绘图。

```text
.
├── src/                Worker 入口、路由、采集、统计、鉴权与通知
├── public/             看板页面
├── db/
│   ├── init.sql        新数据库建表
│   ├── seed-users.sql  可选演示账号
│   └── 20261108.sql    存量 status 表升级脚本
├── wrangler.jsonc      部署配置、数据库绑定和采集计划
└── README.md
```

本目录可单独作为 GitHub 仓库根目录。以下命令均在本 README 所在目录执行，需要 Node.js、npm 和 Cloudflare 账号；Wrangler 通过 npx 调用，无需单独安装。

## 核心机制与技术细节

### 1. 状态表结构与原文去重压缩
- **前后半段拆分存储**：厂商上游 JSON 在 `,"areaId":` 之后的部分（设备型号、区域、单价等）长期不变。入库时 `data.raw` 仅保存前半段变化字段，后半段存入 `status.tail`；仅当 `tail` 变化时 `status` 表才 `INSERT` 新行，否则原地 `UPDATE` 最新状态行，导出时按时间区间拼接还原完整原文。
- **`status` 关键字段**：
  - `broke`：低余额标记（`0` = 余额正常，`1` = 低于预警线）。
  - `base_line`：`"Ww/Mm"` 格式的房间基线配置（如 `17w/36m`、`100w/21m`，缺失时回退默认 `12w/15m`），代表基线功率阈值 `W` 瓦与无人回落判定窗口 `M` 分钟。
  - `last_kwh`：最近一次成功采样的累计电量读数，实时采集时直接结合 `last_online_time` 计算增量，无需读取 `data` 表。
  - `delta` 按 `8 + 等级 + 8 × (连续热水器主步数 + 5 × 距上次普通正增量的秒数)` 编码，主步数上限为 4，秒数上限为 86400。等级 `0–5` 依次为静默、活动、热水器主步、热水器尾步、基线内正增量和待确认短静默。仍兼容旧版直接存储的等级。历史看板展示静默、活动、热水器三类。
  - 有人时 `duration` 累计静默秒数，无人待确认时累计活动秒数。

### 2. 跨采样有效功率与有人/无人状态机
- **量化跨度折算**。电表最小分辨率为 `0.01 kWh`（10 Wh）。上一采样是普通正增量时，跳字跨度 `span` 取本步间隔，否则把 `delta` 中保存的距上次普通正增量时间加到本步间隔。有效功率为 `effW = d × 3600000 / span`。
- **热水器脉冲确认**。主步阈值以 182 秒内 `0.09 kWh` 为基准，间隔更长时按比例放大。紧跟主步、增量低于主步阈值的正增量记为尾步。连续 4 个主步才确认有人并清零静默计时。短脉冲及尾步维持原状态，短脉冲首步为已有的静默计时最多回拨 364 秒。
- **低底噪唤醒（`baseW <= 40W`）**。无人时要求 `effW > max(1.4 × baseW, 20W)`，累计 300 秒确认。单步 `0.01 kWh` 在 `span <= 915s` 且 `span < min(36000 / baseW, winSec)` 时可直接确认，前一步为基线内正增量或热水器尾步时仍需累计。有人的活动维持阈值为 `baseW`。
- **高底噪唤醒（`baseW > 40W`）**。无人时超过 `baseW` 的首步最多计入 182 秒，后续活动按本步实际间隔累计，达到 540 秒确认。确认期间距上次普通正增量少于 `36000 / baseW` 秒的短静默保留待确认状态，活动计时保持原值。低底噪房间的短静默门槛为 `36000 / max(1.4 × baseW, 20W)` 秒，静默间隔计入待确认时长。
- **离家回落与断档容忍**。有人时，基线内采样累计静默达到 `winSec = M × 60` 秒即回落为无人。间隔超过 15 分钟且不超过 45 分钟时，整段平均功率不高于 `baseW` 可继续计入静默。超出该容忍条件或读数回退时，实时状态保留有人或无人值并重置计时，历史区间进入未知状态。

### 3. 近 7 天基线自动寻优
- 查看预设“近 7 天”时，`computeOptimalBaseline` 将热水器主步和尾步的增量视为零，按 2 小时滑窗、30 分钟步长统计平均功率，每个有效窗口至少覆盖 90 分钟。功率下界为 `minBaseW = max(12, ceil(P15 × 1.25))`，其中 `P15` 为窗口平均功率的第 15 百分位。
- 候选功率来自下界和 2 至 16 个采样间隔对应的 `0.01 kWh` 量化阈值。每个候选功率搭配 15、21、24、30、36 分钟窗口回放。两次状态翻转之间不足 45 分钟计为一个短片段。15 至 45 分钟内因平均功率超基线而中断的有效读数间隔计入断档秒数。
- 按 `短片段数 × 10 + (翻转次数 + 断档秒数 / 182) × 1.2 + 窗口分钟数 × 0.35 + (候选功率 - minBaseW) × 0.1` 选最低分。基线发生变化时才回写最新状态，样本不足时沿用已有基线。

### 4. 历史看板回溯校准与 20 分钟平滑曲线对齐
- 看板功率曲线使用 `20 分钟`（`1200s`）滑动窗口平滑 `0.01 kWh` 量化锯齿，仅用于视觉展示。
- 历史序列在采样断档或读数回退后进入未知状态，直到重新确认活动，或基线内的采样达到无人判定窗口。
- 历史分析（`src/modules/history-occupancy.js`）复用 `stepOccupancy`。段首将连续的待确认活动采样回填为有人，段尾在最后一次活动或热水器采样后最多保留 370 秒，再截去剩余静默期。

## 发布前准备

部署前配置运行时变量 `SOURCE_URL` 和 `METERS`。`METERS` 可以填写 JSON 文本，例如 `{"12345678":"A101"}`。将 `JWT_SECRET` 设为 Secret，使用手动上报时也需配置 `UPLOAD_TOKEN`。D1 绑定在 `wrangler.jsonc` 中配置。

## 更新现有云端项目

当前 Worker 名为 meter，配置绑定已有的 meter D1 数据库。常规更新代码时保留数据库绑定，无须重新建库、导入本地数据或运行初始化 SQL；若涉及表结构变更，按文末“重大更新日志”执行对应迁移脚本（例如 `npx wrangler d1 execute meter --remote --file db/20261108.sql`）。

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
- `lastOnlineTime` 使用东八区的 `YYYY-MM-DD HH:mm:ss` 格式，最多超前当前时间 300 秒。
- `readNumber` 是累计电量（kWh），须为有限非负数字。`residualAmount` 是剩余电费（元），使用 JSON 数字。
- `valveStateName` 若为 `null`，这条采样会被跳过。

## 请求入口

| 方法与路径 | 说明 |
| --- | --- |
| GET / | 登录页或当前住户看板 |
| POST /login、POST /logout | 登录与退出 |
| GET /export | 导出当前账号绑定电表的成功记录 |
| GET /recharge | 登录后跳转到配置的充值页面 |
| GET /api?act=up&tk=xxx | 打开历史数据上传页 |
| POST /api?act=up&tk=xxx | 提交实时读数或导入 TXT、JSONL 历史数据 |
| GET /clean | 登录后手动删除当前电表 90 天前的采样，保留账号及状态；无页面按钮，不自动执行 |

GET 和 POST 都通过查询参数 `tk` 校验 `UPLOAD_TOKEN`。实时上报在 POST 表单中提交 `no`（表号）、`kwh`（累计读数）和 `balance`（余额）。可选的 `room` 必须与 `METERS` 映射匹配。服务端使用接收时间，跨秒重复请求由调用端控制。

```sh
curl -d 'no=12345678&kwh=1234.56&balance=78.9' 'https://example.com/api?act=up&tk=xxx'
```

历史导入使用上传页，也可直接用 `multipart/form-data` 提交 `file` 字段。文件使用 UTF-8 编码，最大 16 MiB。

- TXT 可直接上传 `/export` 的导出文件，其中包含厂商 JSON 和以 `manual` 开头的 CSV。
- JSONL 每行一个厂商成功响应对象，例如 `{"success":true,"response":{"serialNo":"12345678","lastOnlineTime":"2026-11-06 12:00:00","readNumber":1234.56,"residualAmount":78.9}}`。

导入保留原采样时间，同一电表同一时间的成功记录会跳过，失败记录可补齐。页面显示写入和跳过条数。导入静默补齐历史，实时状态和通知由后续采集或上报推进。

导出 TXT 包含厂商成功采样的 JSON 原文和手动上报的 CSV 记录。

## 重大更新日志

- **2026-11-08**：重构有人/无人判定状态机并统一历史看板与实时通知逻辑。`status` 表将 `low_balance` 改名为 `broke`，`delta` 改存单步状态码，保留 `last_kwh` 并新增 `base_line`（点击“近 7 天”自动计算房间最优基线功率与窗口）和 `duration`（状态持续秒数）。从旧版升级时需执行一次表迁移：
  ```sh
  npx wrangler d1 execute meter --remote --file db/20261108.sql
  ```
- **2026-11-05**：`/api?act=up` 新增 TXT 与 JSONL 历史数据文件导入及上传页面，支持直接回灌 `/export` 导出文件或厂商响应流。
- **2026-10-31**：项目初始发布，支持多表定时采集、D1 存储、ECharts 用电与余额看板及企业微信群机器人通知。
