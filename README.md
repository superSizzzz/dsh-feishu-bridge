# dsh-feishu-bridge 🐋 大肥鲸

DeepSeek Harness 的双向飞书桥：dsh 干活时把**阶段结论**推到飞书，你在飞书**直接对话**就能指挥 dsh，收尾时自动推一份含**改动清单**的工作汇报。

插件代号 `dsh-feishu-bridge`。

---

## 安装

两条路选一条。装完都别忘了最后一步：**在飞书里给机器人发一句话**，它就认识你了。

### 方式一：交给 AI Agent（推荐）

把下面整段直接发给你的 dsh agent，它会自己装完并把结果报给你：

```text
帮我安装 dsh-feishu-bridge 插件（飞书 ↔ dsh 双向桥）。

仓库地址：https://github.com/superSizzzz/dsh-feishu-bridge

1. 用这一条命令装进 web profile：
     dsh plugin --profile web add github:superSizzzz/dsh-feishu-bridge
   它会把参数转发给 pnpm，从 GitHub 拉取并安装，同时自动把插件的 bundle 层
   登记进 profile —— 所以**不用 clone 仓库、也不用手改任何 patch 文件**。
2. 检查前置条件：lark-cli 已安装，且 `lark-cli --profile dsh-bridge whoami`
   能返回 appId。如果这个 profile 还不存在，先停下来告诉我 ——
   建飞书应用需要我自己在浏览器里操作。
3. 重启 dsh 让新插件生效。
4. 报告三件事：插件有没有加载成功（看 ~/.dsh/dsh-feishu-bridge/boot.log）、
   设置页里有没有出现「飞书桥」一栏、我接下来要在飞书做什么。
```

### 方式二：人工安装

#### 1. 装 lark-cli 并建一个飞书机器人

```bash
npm i -g @larksuite/cli

# 浏览器引导建应用；应用名、机器人名随意，下面假设叫「大肥鲸」
lark-cli config init --new --name dsh-bridge
```

在开放平台为这个应用开通权限与事件订阅：

- 权限：`im:message`、`im:message:send_as_bot`（必须）；要用卡片按钮再加 `im:message:readonly`
- 事件订阅（**长连接模式**）：`im.message.receive_v1`（必须）、`card.action.trigger`（可选，用按钮才需要）

#### 2. 挂上插件

```bash
# 从 npm 装（发布之后）
dsh plugin --profile web add dsh-feishu-bridge

# 从本地 checkout 装
dsh plugin --profile web add link:/path/to/dsh-feishu-bridge

# 或者直接从 GitHub 装
dsh plugin --profile web add github:superSizzzz/dsh-feishu-bridge
```

`dsh plugin` 会把参数转发给 pnpm 装依赖，**并自动把插件的 bundle 层登记进 profile**
（它读的是插件 `package.json` 里的 `dsh.bundle`），所以插件是**自动挂载**的 ——
你不需要手改任何 patch 文件。装完重启 dsh 即可。

> **为什么要用包名而不是 `file:///` 路径**：这个插件同时提供服务端与客户端两半
> （客户端那半就是设置页里的配置界面），而 `dsh-client-modules` 是**按包名扫描**
> Loader 条目、读 `dsh.client` + `exports["./client"]` 的 —— `file:///` 形式不会被识别。

重启 dsh（**新增插件必须重启**，热重载只对已存在条目的配置变更生效）。

#### 3. 让它认识你（不用填 open_id）

在飞书里搜到你的机器人，**发任意一句话**。插件会从事件里自动抓取你的 open_id 并记住，然后回一句「好，我记住你了」。

> 飞书的 open_id 是**按应用维度**隔离的，所以不能从别处抄 —— 自动认领是最省事也最不会错的方式。

#### 4. 搞定

现在可以：直接发消息跟 dsh 说话、发 `/help` 看指令、发 `/chat` 进闲聊模式。

---

## 配置

有两个入口，读写的是同一份配置，改哪个都一样。

### 入口一：dsh 设置页（推荐）

打开 dsh 的**设置**，左侧导航里有一栏 **「飞书桥」**。里面能改：

| 项 | 说明 |
|---|---|
| **飞书机器人** | 这个桥用哪个飞书应用：填 lark-cli 的 profile 名，或直接填 bot 的 app id（`cli_xxx`，profile 名默认就是它）。换它等于换一个 bot，见下方说明 |
| **绑定的人** | 你的 open_id。留空 = 解绑，下一个给机器人发消息的人会被自动认领 |
| **闲聊模型** | `/chat` 用哪个 provider / model；留空则沿用 dsh 的默认模型 |

同时只读展示机器人名字、当前 app id、状态文件位置。保存即刻生效，不用重启。

**换 bot 需要注意**：改这一项会让入站连接重建，「绑定的人」**同时被清空**——
因为飞书的 open_id 是**按应用维度隔离**的，换了应用之后旧的 open_id 不再指向同一个人。
换完给新 bot 发一句话即可重新认领。留空则回到配置文件里的默认值。

### 入口二：浏览器直接打开

```
http://127.0.0.1:3080/feishu-bridge/config
```

同样的内容，独立页面形式。端口是 dsh web 的端口，改过 `--port` 就相应替换。

> **安全提示**：dsh 的 HTTP 服务默认只绑 `127.0.0.1`（且需要登录 token），所以这两个入口
> 都没有额外认证——能打开的人本来就能用这台机器上的 dsh。若你把 webServer 配成
> `0.0.0.0`，它们会随之暴露到网络上，那时请自行加反代与鉴权。

### 想改的开关不在这里？

`openPush` / `thinkPush` / `turnPush` / `promptSection` 这类行为开关留在**配置文件**里
（`~/.dsh/cordis.patch.yml`）—— 它们是装插件时定一次的东西，不占设置页。临时静默用飞书发 `/mute`。

---

## 它做什么

| 链路 | 方向 | 说明 |
|---|---|---|
| 出站 | dsh → 飞书 | 阶段结论卡（模型主动调 `feishu_notify`）+ turn 兜底卡 |
| 入站 | 飞书 → dsh | 你发的文本注入当前会话；`/` 开头按指令解析 |
| 提问桥 | 双向 | `ask_user_question` 的**网页优先、飞书兜底**（见下） |
| 汇报 | dsh → 飞书 | 收尾自动推「工作汇报」卡，含工作区、过程统计、改动清单 |

### 提问桥的优先级设计

**网页优先，网页没人接才走飞书**：

1. 桥接先调 `next()`，把问题让给 dsh 的 Web 通道（网页会正常弹窗）
2. 宽限期内（默认 8s）网页答了 → 直接用，飞书完全不打扰
3. 网页压根没开（`NO_PROVIDER`）→ 立刻发飞书卡，零延迟
4. 网页在但人不在电脑前 → 飞书发卡，两边竞速，谁先答用谁；网页先答时飞书卡会被改成「已在网页作答」

飞书侧长等（默认 5 分钟）到点不答也**不会**报错或卡死 agent，而是回落到继续等网页。

---

## 实际效果

飞书里收到的是卡片（不是纯文本）。以下是真实运行时抓下来的**结构**（正文由模型现写，所以每次都不一样；路径与内容已泛化）：

**阶段总结** —— 攒够内容才发，没干成什么就安静：

```text
┌────────────────────────────────────────────┐
│ 这一阶段干完了什么 · 第 12 轮               │
│ 大肥鲸来报                                  │
├────────────────────────────────────────────┤
│ 在哪干活   ~/projects/my-app                │
│ 会话       #A3F2　修图片上传链路 · turn 12   │
├────────────────────────────────────────────┤
│ 图片链路三个 bug 都定位到了：数据其实在      │
│ data.messages 而不是 items；资源键是嵌在     │
│ 文本里的 [Image: img_v3_...]；--type 是必需  │
│ 参数但 help 里没列出来。下载那步已实测通过。  │
└────────────────────────────────────────────┘
```

**工作汇报** —— 收尾自动发，正文 + 完整改动清单：

```text
┌────────────────────────────────────────────┐
│ 工作汇报                                    │
│ 大肥鲸汇报                                  │
├────────────────────────────────────────────┤
│ 工作区   ~/projects/my-app                  │
│ 会话     #A3F2　修图片上传链路                │
│ 过程     17:35 → 17:50 · 6 turn · 216 次工具调用│
├────────────────────────────────────────────┤
│ 这轮把图片上传链路跑通了。路径记错了、资源键  │
│ 藏在文本里、参数是必需但文档没写 —— 三个问题  │
│ 都修完并实测过下载那一步。                   │
│                                            │
│ 这轮动的文件（2 文件  +111 −0）              │
│   src/upload.ts           +58 −0            │
│   src/types.ts            +53 −0            │
└────────────────────────────────────────────┘
```

**提问卡** —— 选项渲染成列表 + 可点按钮：

```text
┌────────────────────────────────────────────┐
│ 需要你定一下                                │
├────────────────────────────────────────────┤
│ 方案 A 和方案 B 都能达成目标，你倾向哪个？   │
│                                            │
│  1. 方案 A —— 改动小，但要多装一个依赖       │
│  2. 方案 B —— 零依赖，但要多写约 100 行      │
│                                            │
│  [ 方案 A ]   [ 方案 B ]                    │
└────────────────────────────────────────────┘
```

---

## 权限、外部服务与兼容性

装之前值得知道它会碰什么。

| 项 | 说明 |
|---|---|
| **飞书权限** | `im:message`、`im:message:send_as_bot`（必需，收发消息）；`im:message:readonly`（可选，仅卡片按钮需要） |
| **飞书事件订阅** | `im.message.receive_v1`（必需，长连接模式）；`card.action.trigger`（可选，用按钮才需要）。**长连接不需要公网地址或开放端口** |
| **外部服务** | ① 飞书开放平台（消息收发，经 lark-cli）；② 你在 dsh 里配置的模型 provider —— 所有推给你的文案（开工报告、阶段总结、工作汇报、闲聊）都由模型生成，因此**会话内容会随这些请求发往该 provider** |
| **本地落盘** | `$DSH_HOME/dsh-feishu-bridge/state.json` 存绑定的 open_id、会话短码与标题、闲聊历史；`boot.log` 存启动自检记录。两者都在本机，不上传 |
| **网络监听** | **不新开任何端口**。配置页只是复用 dsh 已有的 HTTP 服务注册一条路由（`/feishu-bridge/config`） |
| **出站连接** | 仅飞书与你的模型 provider |
| **数据边界** | 这个插件不收集、不上报任何遥测；仓库里没有任何统计代码 |
| **平台** | Windows / macOS / Linux（需要 Node ≥ 22 与 [lark-cli](https://www.npmjs.com/package/@larksuite/cli)） |
| **dsh 版本** | `>= 0.1.7-rc.2` |
| **人类可读的输出频率** | 默认在「开工 / 有阶段成果 / 收尾」三个时刻出声；`/mute`、`turnPush: off`、`enabled: false` 三级可关 |

> **权限为什么会要这些**：`im:message` 是读消息（收你的指令），`im:message:send_as_bot` 是以机器人身份发消息（汇报）。除此之外它不申请通讯录、云文档、日历等任何权限。open_id 是按应用维度隔离的，所以插件只可能看到「给这个机器人发过消息的人」。

---

## 多实例与热重载

同一台机器同时跑多个 profile 时，入站消息由 pid 锁
（`$DSH_HOME/dsh-feishu-bridge/inbox.lock`）选出唯一消费者 —— 其余实例只做本地
会话的播报与汇报，不会重复回执。

只想在某个 profile 生效时，把 mount 段放进该 profile 的 `cordis.patch.yml` 即可；
**两边不要同时挂**，否则会加载两份。

> **新增插件条目必须重启 dsh**。profile 的 `patchReload: live` 只对已加载条目的
> 配置变更生效，新增 `insert` 条目不会被热重载捡起来；改插件源码同理。

---

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `profile` | `dsh-bridge` | lark-cli profile 名，**绝不与其他用途的 bot 共用** |
| `userId` | `''` | 投递目标 open_id。**可以留空** —— 第一条消息会自动认领 |
| `cliEntry` | `''` | run.js 绝对路径，留空自动探测 |
| `progressPush` | `true` | 是否响应 `feishu_notify` |
| `promptSection` | `true` | 把「飞书播报」约定注入系统提示（阶段性成果的主路径） |
| `openPush` | `true` | 收到输入后先推一条「打算怎么干」的开工报告 |
| `thinkPush` | `false` | 是否把模型的每段思考都推过来（默认关，太碎） |
| `turnPush` | `judge` | 每轮策略：`judge` 模型判断有无成果 / `always` / `changes` / `off` |
| `summaryPush` | `true` | 是否推工作汇报 |
| `throttleMs` | `20000` | 同会话推送最小间隔；窗口内改为就地更新卡片 |
| `questionGraceMs` | `8000` | 留给网页 answerer 的宽限期 |
| `questionTimeoutMs` | `300000` | 飞书侧最长等待 |
| `writerEnabled` | `true` | 汇报正文是否交给模型现写（关掉则用极简兜底句） |
| `writerProvider` | `''` | 写文案用的 provider；留空沿用各会话自己的模型 |
| `writerModel` | `''` | 同上，model |
| `persona` | 内置「一起工作的女高中生 / 好朋友」人设 | **飞书侧文案口吻**：收尾汇报、`/polish`、`feishu_notify` 写的文字都套这个口吻；留空则回到中性口吻。网页会话里 dsh 的说话方式不受影响 |
| `statePath` | `''` | 状态文件，默认 `$DSH_HOME/dsh-feishu-bridge/state.json` |

---

## 飞书侧指令

| 指令 | 行为 |
|---|---|
| `/stop` | 中止当前会话正在跑的 turn |
| `/status` | 当前绑定的会话、工作区、轮次、待答问题数 |
| `/list` | 列出记录过的会话（短码 + 标题 + 工作区 + 状态） |
| `/use <短码>` | 切换默认投递目标 |
| `/polish` | 让 dsh 用模型重写一版更好读的工作汇报 |
| `/mute` | 这一段先不用汇报（静默本会话的自动推送） |
| `/unmute` | 恢复汇报 |
| `/chat` | 切到闲聊模式（消息不进 dsh） |
| `/work` | 切回工作模式 |
| `/mode` | 看看现在是什么模式 |
| `/forget` | 把闲聊记录抹掉 |
| `/config` | 看/改闲聊用的模型覆盖项 |
| `/help` | 指令帮助 |

不用加指令的场景：**直接发文本 = 投给当前会话**；出现提问卡时直接回复即作答（回选项编号或点按钮都行）。

### 汇报的三种性质

分开看，它们不是一回事：

| 时机 | 性质 | 说话 |
|---|---|---|
| 收到你的输入 | **固定动作**，每次必发 | 准备开工：打算怎么干 |
| 每轮结束 | **模型判断**（`turnPush: judge`） | 有成果才推，没有就安静 |
| 工作收尾 | 固定动作 | 工作汇报：整件事干了什么 + 改了什么 |

**开工报告**是约定好的仪式，跟判断无关。

**阶段性成果**走两层：

1. **主路径 · 系统提示注入**（`promptSection`）：会话一开始就把「你有 `feishu_notify`、
   判断标准是什么、什么时候该推」写进系统提示，模型在思考完自己决定要不要发。
   这样它不用等到需要用时才发现有这个工具。
2. **兜底 · 每轮判断**（`turnPush: judge`）：万一它钻进任务忘了，插件在轮次结束时
   主动拿素材问一次「有没有值得打断你的成果」。没成果只回 `NONE`，你不受打扰。
   同一个 turn 里模型已经主动播报过时，这一步会跳过，不会推两次。

每段思考（`thinkPush`）默认关：太碎，且多数不是成果。

想临时安静某一段，飞书发 `/mute`，恢复发 `/unmute`；`enabled: false` 则整个关掉。

---

### 会话标识：短码 + 标题

卡片上「会话」那一行长这样：`#9BDR　修飞书桥的图片链路`。两者职责不同，都保留：

- **短码**（`#9BDR`）是路由用的稳定身份，`/use` 靠它切换目标，不随标题变化。
- **标题**是给人一眼认出「这是哪件事」的。优先取 dsh 的标题服务
  （`ctx.sessionTitle`，挂了的话能拿到 LLM 生成的智能标题）；
  该服务没挂载时，退回「首条用户消息截 24 字」。

标题在首条用户消息进来时解析一次并存进 `state.json`，所以 `/status`、`/list`
和所有卡片都能用，重启也不丢。

> 想启用 dsh 的智能标题，把 `@deepseek-ai/dsh-session-title` 挂到 profile 里
> （它要求显式给三个上限：`fallbackMaxWords` / `fallbackMaxBytes` / `maxTitleBytes`）。
> 不挂也能用，只是标题退化成首句话的截断。

---

## 闲聊模式

飞书发 `/chat` 就切到闲聊模式——这时候发什么都**不会进 dsh**，就是一段普通对话，
跟用 DeepSeek 客户端聊天一样。发 `/work` 切回来干活。

实现上有三点取舍：

- **复用 dsh 的模型服务**（`ctx.llm`），不自己接 HTTP。provider 路由和凭据都由 dsh 管，
  所以「API Key 默认用 dsh 的」是天然的——插件不持有任何密钥。
- **但完全不碰会话**：没有 agent、没有 session、没有工具。聊过的内容不会出现在
  dsh 的历史里，也不会被汇报进飞书卡片，两边干干净净。
- **历史自己存**（`state.json`），重启后在 `/chat` 里接着聊，上下文不丢；发 `/forget` 清空。

模式本身**刻意不持久化**——重启回到工作模式，免得忘了切回来、把要干的活当闲聊聊掉。

闲聊用哪个模型：默认跟随 dsh 的部署默认模型（你在 dsh 设置页里选的那个）。
想给闲聊单独指定，用 `/config chatModel deepseek-flash` 这类指令覆盖，`reset` 恢复。

> **关于模型提供商和 API Key**：dsh 自带设置页已经管了所有 provider 的凭据，
> 插件不需要再做一个重复的配置页面。闲聊直接复用那套配置。

---

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 飞书没反应 | 看 `$DSH_HOME/dsh-feishu-bridge/boot.log`：没有 `apply() entered` 说明插件没加载（多半要重启 dsh） |
| 日志报 `身份校验失败` | `lark-cli --profile dsh-bridge whoami` 确认 bot 身份可用 |
| 卡片按钮点了没反应 | 开放平台没订阅 `card.action.trigger`，按 CLI 给的扫码链接订阅 |
| 消息注入了但 dsh 没动 | 该会话可能已结束；发 `/status` 看绑定情况，或先在 dsh 里开一轮 |
| 提示 `subscription already exists` | 之前有残留服务端订阅，`lark-cli --profile dsh-bridge event stop` 后重启 dsh |

---

## 开发说明（踩过的坑，别再踩）

1. **dsh 直载 TS 走 Node 的 strip-only 模式**，不支持 TypeScript **参数属性**
   （`constructor(private readonly x: T)`）→ 必须显式声明字段再赋值，否则插件加载静默失败。
2. **CLI 要走原生二进制，别走 `scripts/run.js`**：run.js 只是转发脚本，内部用
   `execFileSync(bin, args, { stdio: 'inherit' })` 调原生二进制，**且不带 `windowsHide`**。
   在终端里跑（web profile）父子共用同一个控制台看不出问题；换成没有控制台的宿主
   （**Electron 桌面版**），那个子进程只能自己新建控制台 —— 表现就是「每发一条消息
   闪一个黑窗」，两条长连接还各占一个常驻窗口。
   做法：优先解析 `bin/lark-cli.exe` 直接 spawn，并**始终带 `windowsHide: true`**。
   另外 `lark-cli.ps1` 的包装层会把正常 stderr 变成 `NativeCommandError`，
   且 Windows PowerShell 5.1 会吞掉 JSON 双引号 —— 用 argv 数组调用，别拼命令行字符串。
3. **事件流子进程只能靠关 stdin 或 SIGTERM 结束**，`kill -9` 会泄漏服务端订阅。
4. **`event consume` 输出的 `content` 已被预解码成纯文本**，不要再 `fromjson`。
5. **飞书 open_id 是应用维度的**，换应用就要重新取一次。
6. bot 自己发的消息不会回流到 `im.message.receive_v1`，不存在自激回声。

---

## 文件结构

```
src/
├── index.ts       插件入口：配置、装配、指令路由、生命周期
├── config.ts      schemastery 配置 schema
├── config-page.ts 配置面板（本地 HTML 表单，无构建）
├── lark-cli.ts    CLI 适配层（唯一与 lark-cli 接触处）
├── inbox.ts       事件流消费（入站消息 / 卡片回调共用）
├── questions.ts   提问桥（网页优先 + 飞书兜底）
├── reporter.ts    改动追踪 + 收尾汇报
├── outbox.ts      节流 / 幂等 / 就地更新
├── render.ts      Card 2.0 卡片渲染
├── registry.ts    状态持久化（会话映射、待答问题）
├── tools.ts       模型工具：feishu_notify / feishu_summary
└── types.ts       共享类型
tools/
├── send-card.mjs  M0 冒烟脚本，也是 CLI 调用方式的范式
└── card-m0.json   测试卡片素材
```
