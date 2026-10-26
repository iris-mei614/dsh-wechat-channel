# dsh-wechat-channel

DeepSeek Harness（DSH）的**微信双向通道**插件：在微信单聊里给 Bot 发指令，驱动一个已有的 DSH 会话；DSH 完成任务后，把文字、图片、音频、视频和文件发回微信。

English: [`README.en.md`](./README.en.md) · 本机快速教程：[`安装与使用教程.md`](./安装与使用教程.md) · 源码：[`iris-mei614/dsh-wechat-channel`](https://github.com/iris-mei614/dsh-wechat-channel)

- 只用腾讯官方 **iLink Bot API**（`getupdates` 长轮询 + `sendmessage`）。
- 协议细节使用 [`wechat-ilink-client`](https://www.npmjs.com/package/wechat-ilink-client)（MIT）。
- 不依赖任何社区微信插件，不修改 DSH 核心代码。
- 插件以 Cordis 形态运行：`export const name / inject / Config / apply(ctx, config)`（`Config` 为 Schemastery schema，可在 DSH 插件配置里编辑）。

### 30 秒上手

1. 安装插件并重启 DSH（见下方「安装」）。
2. 对 Agent 说：`调用 wechat_login`，扫码确认。
3. 在微信给 Bot 发任意一句（如「你好」）激活；默认会自动建会话。
4. 之后直接发文字 / 图片即可；发 `/help` 看命令。

---

## 1. 能力与边界

### 已实现

| 能力 | 说明 |
|---|---|
| 入站文本 | `getupdates` 长轮询，35 秒超时；文本与语音转写文本都会投递给 DSH |
| 入站媒体 | 图片/视频/文件下载到会话 `wechat-inbox/`，路径交给 Agent；有 `attachments` 时写入 DSH 附件；纯图片会短暂等待下一条文字配文再一并投递 |
| 出站文本 | `sendmessage`，强制携带入站消息下发的 `context_token` |
| 出站媒体 | 图片、视频、音频、其他文件；文件路径受工作区/`mediaRoots` 限制 |
| 会话绑定 | `defaultSessionId` 配置、`/bind`、`/new`、`/list`、`/switch`；微信新建会话用首条消息命名为 `[微信会话] …` |
| 会话控制 | `/status`、`/stop`、`/steer`、`/clear`、`/model`、`/retry` |
| 任务完成通知 | 监听 DSH `session/event` 的 `turn/end`，回传最终文本与 `present` 文件 |
| 长任务进度 | 默认每 3 分钟向微信发送「仍在处理…」，尽量附带当前步骤（读文件/跑命令等） |
| Web 扫码页 | 登录时在 `http://127.0.0.1:19876/` 打开本地扫码页；登录后也显示健康状态 |
| 24 小时窗口降级 | 超过 20 小时不尝试主动推送，暂存摘要，下次入站补发 |
| 游标持久化 | `get_updates_buf` 原子落盘，重启从断点继续；消息 ID 去重 |
| 断线重连 | 指数退避（1s → 30s）；`errcode -14` 停止轮询并等待重新扫码 |
| 发送风控 | 滑动窗口限速（默认 10 条/分钟）、队列串行、最多 3 次递增重试 |
| 凭证安全 | Bot Token 走 DSH 凭据服务（`botTokenRef`），日志与错误信息统一脱敏 |
| 扫码登录 | 自动/手动获取二维码 URL，确认后写入 DSH 凭据 |
| Agent 工具 | `wechat_send`、`wechat_status`、`wechat_login` |

### 明确不做

- **群聊**：只处理单聊。带 `group_id` 的消息直接忽略。
- **主动冷启动**：用户从未给 Bot 发过消息时，没有 `context_token`，无法主动发第一条。
- **绕过 24 小时窗口**：这是微信服务端行为，插件只能降级为“下次补发”。
- **修改 DSH 核心**：全部通过公开的 `agents`、`sessionQuery`、`tools`、`credentials` 接口完成。

> [!IMPORTANT]
> **使用须知（请务必遵守，降低封号与风控风险）**
>
> 本插件走腾讯官方 iLink Bot API，**不能保证永不封号**；最终以微信平台规则为准。请务必：
>
> - **只服务自己绑定的账号**，别拿来群发、骚扰、营销轰炸
> - **保持默认限速**（约 10 条/分钟），别改得很高猛发
> - **别试图绕过 24 小时窗口**或未激活就硬推
> - **别发违规内容**

---

## 2. 环境要求

- DeepSeek Harness **0.2.1-rc.2**（本插件按该版本的公开接口实现并验证）。
- Node.js **22.19+ 或 24.x**。
- 微信 **8.0.70+**，且账号已被灰度到 **ClawBot / 机器人插件**入口（“我 → 设置 → 插件”）。这是腾讯账号侧的开通范围，插件无法绕过。
- 运行 DSH 的机器可以访问 `*.weixin.qq.com` 和 `*.cdn.weixin.qq.com`。

---

## 3. 安装

### 3.1 从 npm 一键安装（推荐，发布后）

```bash
# 任选其一：已安装 dsh CLI，或用 npx
dsh plugin --profile web add dsh-wechat-channel
# npx @deepseek-ai/dsh plugin --profile web add dsh-wechat-channel

dsh web   # 必须重启后插件才加载
```

也可在 DSH：**设置 → 插件 → 添加插件**，填写 `dsh-wechat-channel` 后安装并重启。

> npm 包上线并带有 `dsh-plugin` 关键词后，[DSH 插件市场](https://dshmp.com/)通常会在约一天内自动收录。

### 3.2 从本地 / GitHub 源码安装（开发用）

```bash
git clone https://github.com/iris-mei614/dsh-wechat-channel.git
cd dsh-wechat-channel
npm install
npm run build
dsh plugin --profile web add "$(pwd)"
dsh web
```

确认：

```bash
dsh --profile web --dump-config | grep -A5 wechat
```

安装后 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 会包含 `dsh-wechat-channel`，`cordis.patch.yml` 中会插入 `wechat-channel`。

### 3.3 卸载 / 重装

```bash
dsh plugin --profile web remove dsh-wechat-channel
dsh plugin --profile web add dsh-wechat-channel   # 或 add /path/to/dsh-wechat-channel
dsh web
```

重装后如果 Bot Token 仍有效，插件会直接恢复；如果已失效（例如 `errcode -14`），用 `wechat_login` 重新扫码，或删除 DSH 凭据中的 `WECHAT_ILINK_BOT_TOKEN` 后重启。

---

## 4. 首次使用（最短路径）

1. **安装并重启**（见第 3 节）。
2. **扫码**：对 Agent 说「调用 wechat_login」，或打开日志 / 本地扫码页 `http://127.0.0.1:19876/`。
3. **激活**：微信里给 Bot 发任意消息 → 拿到 `context_token`。
4. **开聊**：默认会自动新建并绑定 DSH 会话；也可发 `/new`。之后直接发文字、语音或图片（纯图片可再补一句说明）。
5. **看状态**：微信发 `/status`。

更细的扫码与排障见下方第 5 节与第 15 节，或 [`安装与使用教程.md`](./安装与使用教程.md)。

---

## 5. 扫码绑定流程

### 5.1 首次登录（推荐）

1. 启动 `dsh web`。
2. 在任意 DSH 会话里对 Agent 说：

   > 调用 wechat_login 给我微信登录二维码

3. Agent 调用 `wechat_login`，返回二维码 URL；插件同时把 URL 打印到日志，并写入：

   ```
   <stateDir>/login-qr.txt
   ```

4. 打开该 URL（它本身就是二维码内容/图片地址），用手机微信扫码并确认。
5. 登录成功后：
   - `bot_token` 写入 DSH 凭据，引用名为 `WECHAT_ILINK_BOT_TOKEN`（可用 `botTokenRef` 改）；
   - `accountId`、`baseUrl` 写入状态文件；
   - 长轮询自动开始；
   - 通道状态变为“已连接”。

### 5.2 自动登录

默认 `autoLogin: true`。插件启动时如果既没有 DSH 凭据、也没有同名环境变量，会自动请求二维码并打印 URL，然后等待扫码。适合“先启动、后扫码”的部署。

### 5.3 用环境变量提供 Token

如果不想用扫码写入凭据，也可以让 DSH 凭据服务解析环境变量：

```bash
export WECHAT_ILINK_BOT_TOKEN='...'
```

插件会通过 `ctx.credentials.resolve('WECHAT_ILINK_BOT_TOKEN')` 读取；读不到时才回退到进程环境变量。**不要把 Token 写进 YAML 或代码。**

### 4.4 首次激活通道（扫码 → 首条消息）

iLink 不允许 Bot 冷启动。完整首次路径是：

1. **扫码登录**（`wechat_login` / `autoLogin`）→ Bot Token 写入凭据，长轮询开始；
2. **微信发任意一条消息** → 插件拿到 `context_token`，通道才真正可回复；
3. **会话就绪** → 若已配置 `defaultSessionId` 则直接投递；否则默认**自动新建会话**（`autoCreateSessionOnFirstMessage`），并发送简短欢迎语。

用 `/status` 或 `wechat_status` 看 `就绪阶段` / `下一步`：

| 阶段 | 含义 | 你要做的事 |
|---|---|---|
| `need-login` | 还没有 Bot Token | 扫码或配置 `botTokenRef` |
| `need-first-message` | 已登录，但微信还没发过消息 | 在微信给 Bot 发「你好」 |
| `need-session` | 已激活，但未绑定 DSH 会话 | `/new` 或 `/bind`（默认会在首条文字时自动新建） |
| `ready` | 可以正常对话 | 直接发文字 |

---

## 6. 最小配置示例

写入 profile 的 `cordis.patch.yml`（或放在 `--patch` 覆盖层）：

```yaml
- id: wechat-channel
  config:
    # 必填项：绑定一个已存在的 DSH 会话 ID
    defaultSessionId: 'session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    # Bot Token 的 DSH 凭据引用名；值由扫码登录或环境变量提供
    botTokenRef: WECHAT_ILINK_BOT_TOKEN
    # 可选：首次入站时自动绑定此微信用户；留空则自动绑定第一个发消息的人
    ownerUserId: ''
    # 可选：/new 的默认工作目录；留空则沿用当前会话 cwd 或进程 cwd
    newSessionCwd: ''
    # 可选：状态目录；留空为 $DSH_HOME/wechat-channel
    stateDir: ''
```

完整配置见第 10 节。

---

## 7. 微信里的命令

命令由插件本地处理，不消耗模型额度。

| 命令 | 行为 |
|---|---|
| `/help` | 命令帮助 |
| `/new` | 新建 DSH 会话，并把 `activeSessionId` 指过去 |
| `/list` | 列出未归档、非子代理的会话，带运行状态与序号 |
| `/switch <序号\|ID>` | 切换到目标会话；序号来自最近一次 `/list` |
| `/bind <sessionId>` | 绑定一个已存在的会话，不新建 |
| `/status` | 连接状态、Bot、活跃会话、最近入站、待补发、队列、计数 |
| `/stop` | 向当前会话发送取消信号（`agent.cancel({kind:'user'})`） |
| `/steer <文本>` | 仅当当前会话 `running` 时，用 `steer` 模式介入当前任务 |

中文别名也支持：`/帮助`、`/新建`、`/列表`、`/切换`、`/状态`、`/停止`、`/绑定`、`/介入`。

普通文本（不以 `/` 开头）使用 `followup` 模式投递，创建独立的新 turn。

---

## 8. 会话投递语义

### 7.1 三种模式

| 模式 | 触发 | 语义 |
|---|---|---|
| `followup` | 普通文本 | 新建独立 turn；目标离线时先 `agents.resume` 再投递 |
| `steer` | `/steer <文本>`，且目标 `running` | 在下一个 step 边界介入当前工作 |
| `inject` | 当前版本保留给内部/后续扩展 | 不打断当前任务，静默补充上下文 |

### 7.2 离线会话恢复

目标不在 `ctx.agents` 注册表时，插件通过公开接口恢复：

```
sessionQuery.readSession(id)
  → 读取 header.cwd / header.agentPreset
  → agentPresets.resolve + agentPresets.mount（保持会话原有工具集）
  → agents.resume({ resumeSessionId, agentOptions, setup })
  → followup(message)
```

恢复得到的 handle 由插件持有，插件卸载时统一 `dispose()`。恢复失败会明确回微信，不会伪造“已收到”。

### 7.3 与 `dsh-agent-message` 的关系

需求中希望复用 `dsh-agent-message` 的 `send_agent_message`。实际核对结果：

- npm 上最新的 `dsh-agent-message@1.6.0` 声明 `engines.dsh: ">=0.1.1-rc.2 <0.2.0"`，peer 依赖也限定 `<0.2.0`；
- 本插件运行在 DSH **0.2.1-rc.2**，安装它会产生不兼容的 peer 范围。

因此本插件**没有把 `dsh-agent-message` 作为硬依赖**，而是在 `src/agent/bridge.ts` 中用 DSH 公开接口实现了同一套语义：

- `followup` / `steer` / `inject`；
- 离线自动 `resume`；
- 保留原会话的 Agent preset；
- 用 `UserMessage` + 自定义 `source.kind = 'wechat-channel'` 标记来源；
- 监听 `agent/inbox/claimed` 与 `session/event` 关联“哪个 turn 是微信触发的”。

如果未来 `dsh-agent-message` 发布支持 0.2.x 的版本，两者可以同时安装，互不冲突；本插件不调用它的工具，也不依赖它的服务。README 的验收步骤只依赖本插件自己的 `wechat_*` 工具。

---

## 9. 出站媒体

### 8.1 Agent 主动发送

Agent 可以随时调用：

```json
{
  "text": "图片和报告已生成。",
  "files": ["/path/to/chart.png", "/path/to/report.pdf"],
  "caption": "本次结果"
}
```

工具名：`wechat_send`。

### 8.2 任务完成自动回传

插件监听 `session/event`：

- `turn/start`：记录 turn；
- `agent/inbox/claimed`：如果被认领消息的 `source.kind === 'wechat-channel'`，标记该 turn 来自微信；
- `assistant/message`：收集最后一个非空文本；
- `deliverables/presented`：收集 `present` 工具声明的文件；
- `turn/end`：推送 `✅/⚠️ + 摘要`，随后逐个推送文件。

因此，让 Agent 用 `present` 工具交付图片/音频/视频/文件，任务结束后会自动出现在微信里；也可以直接调用 `wechat_send`。

### 8.3 类型与大小

| 类型 | 扩展名 | 发送方式 |
|---|---|---|
| 图片 | jpg/jpeg/png/gif/webp/bmp | iLink 图片消息 |
| 视频 | mp4/mov/m4v/webm/mkv | iLink 视频消息 |
| 音频 | mp3/wav/ogg | 优先 iLink 语音消息；失败降级为文件 |
| 其他 | 任意 | iLink 文件附件 |

- 插件默认单文件上限 **100 MiB**（`maxFileBytes`），与公开的 iLink/OpenClaw 媒体上限一致；实际服务端仍可能按类型拒绝，建议图片/音频控制在 20 MiB 内。
- 文本按 `textChunkChars`（默认 1800 字符）切分为多条，避免超长。
- 媒体路径必须是普通文件，并通过 `realpath` 做根目录包含检查；默认只允许当前会话 cwd、进程 cwd 和 `mediaRoots`，防止 Agent 把任意系统文件发出去。
- 媒体说明文字会作为**单独的文本消息**发送，因此和媒体本身一起计入每分钟发送上限。

---

## 10. 24 小时窗口与补发

微信服务端在用户超过 **24 小时**未与 Bot 互动时会丢弃 Bot 的主动消息。插件采用 **20 小时**安全窗口（`windowHours`）：

1. 每条入站消息都记录 `lastInboundAt`，并刷新该用户的 `context_token`；
2. 任务完成通知属于“主动推送”：
   - `now - lastInboundAt <= 20h` 且有 token：直接发送；
   - 否则：**不尝试发送**，写日志，把摘要和文件路径存入 `pendingNotices`；
3. 用户下次发消息时：
   - 先刷新 token 和时间戳；
   - 自动补发最多 3 条暂存摘要（带“补发 …”抬头），成功后从状态中删除；
   - 再处理本次消息。

验收第 7 条对应的日志示例：

```
距上次入站已超过 20 小时（或没有 context_token），不尝试主动发送；已暂存摘要，等待用户下次发消息补发。
```

---

## 11. 完整配置参考

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defaultSessionId` | string | `''` | 启动时绑定的已有会话 ID |
| `botTokenRef` | string | `WECHAT_ILINK_BOT_TOKEN` | DSH 凭据引用名 |
| `accountId` | string | `''` | 可选 Bot 账号 ID；通常由扫码返回 |
| `baseUrl` | string | `https://ilinkai.weixin.qq.com` | iLink API 根地址 |
| `cdnBaseUrl` | string | `https://novac2c.cdn.weixin.qq.com/c2c` | 媒体 CDN 根地址 |
| `botType` | string | `3` | 扫码登录 `bot_type` |
| `stateDir` | string | `$DSH_HOME/wechat-channel` | 状态目录（`state.json`、`login-qr.txt`） |
| `autoLogin` | boolean | `true` | 无 Token 时自动请求二维码 |
| `autoRelogin` | boolean | `false` | `errcode -14` 后自动重新请求二维码 |
| `ownerUserId` | string | `''` | 只接受该微信用户；留空则首个入站用户自动绑定 |
| `newSessionCwd` | string | `''` | `/new` 的工作目录 |
| `agentPreset` | string | `''` | 新建/恢复会话使用的 Agent preset；留空用会话原 preset 或默认 |
| `longPollTimeoutMs` | number | `35000` | 长轮询超时 |
| `windowHours` | number | `20` | 主动推送安全窗口（服务端硬限制 24h） |
| `windowWarnHours` | number | `2` | 窗口剩余不足该小时数时提醒用户回一句消息 |
| `rateLimitPerMinute` | number | `10` | 出站滑动窗口限速 |
| `maxSendAttempts` | number | `3` | 单条消息最大尝试次数 |
| `notifyOnTurnEnd` | boolean | `true` | 是否自动推送任务完成 |
| `notifyAllTurns` | boolean | `false` | 是否连非微信触发的 turn 也推送 |
| `sendStartAck` | boolean | `true` | 投递到 DSH 成功后先回微信“已收到，DSH 正在处理…”；投递失败会回错，微信推送失败会写入 DSH 会话通知 |
| `maxFileBytes` | number | `104857600` | 单文件上限（100 MiB） |
| `mediaRoots` | string[] | `[]` | 额外允许发送的目录 |
| `textChunkChars` | number | `1800` | 单条文本切分长度 |
| `queueLimit` | number | `100` | 出站队列上限 |
| `logMessageContent` | boolean | `false` | 是否在日志中打印消息预览（默认只打印长度） |
| `autoCreateSessionOnFirstMessage` | boolean | `true` | 无绑定会话时，首条普通文字自动 `/new` |
| `sendWelcomeOnActivate` | boolean | `true` | 首次入站激活时发送欢迎语 |
| `printQrInTerminal` | boolean | `true` | 尝试在终端渲染登录二维码（需 `qrcode-terminal`） |
| `sendProgressUpdates` | boolean | `true` | 长任务期间向微信发送进度 |
| `progressIntervalMs` | number | `180000` | 进度间隔（毫秒，默认 3 分钟） |
| `enableLoginPage` | boolean | `true` | 启动本地 Web 扫码页 |
| `loginPagePort` | number | `19876` | 扫码页端口；`0` 表示系统分配 |
| `enableInboundMedia` | boolean | `true` | 下载微信入站图片/文件并交给 DSH |
| `inboundMediaDir` | string | `wechat-inbox` | 入站媒体保存在会话 cwd 下的子目录 |
| `inboundMediaHoldMs` | number | `30000` | 纯媒体消息等待配文的毫秒数（`0` 关闭）；微信常把图和字分成两条 |
| `askCaptionOnMediaOnly` | boolean | `true` | 收到纯媒体时提示用户补充文字说明 |

---

## 12. 安全设计

> [!WARNING]
> 合规使用提醒见上文 **「使用须知」**：只服务绑定账号、保持默认限速、不绕过 24h 窗口、不发违规内容。

- **只服务绑定用户**：`ownerUserId` 为空时，第一个发消息的用户被持久化绑定；之后其他用户的消息直接忽略。
- **只处理单聊**：`group_id` 非空即忽略。
- **Token 不落日志**：`Redactor` 收集 Bot Token、`context_token`、二维码返回的 token，并对所有日志和错误信息做替换。
- **凭据不写 YAML/代码**：Bot Token 由 `ctx.credentials` 解析或写入。
- **状态文件权限**：`state.json` 使用原子写 + `0600`，目录 `0700`。其中包含 `context_token` 和会话绑定，仍应按敏感文件保护。
- **媒体根目录限制**：防止 Agent 通过 `wechat_send` 读取任意系统文件。
- **发送限速**：默认 10 条/分钟，串行队列，不提供群发/批量能力。
- **重试上限**：最多 3 次，间隔 1s/2s/4s，避免短时间触发风控。

---

## 13. 验收步骤

> 以下步骤按需求文档第 7 节逐条对应。未特别说明时，都在微信里对 Bot 单聊操作。

### 验收 1：文本往返

1. 配置 `defaultSessionId` 为一个已有会话，启动 DSH。
2. 在微信发送“你好”。
3. 预期：
   - DSH 会话收到“你好”并开始新 turn；
   - 任务结束后微信收到 `✅ …` 和最终回复；
   - `/status` 显示“已连接”、正确的活跃会话和计数。

### 验收 2：绑定、新建、列出、切换

1. 发送 `/bind <已有会话ID>` → 回复“已绑定会话…”。
2. 发送 `/new` → 回复新会话 ID，`activeSessionId` 切换。
3. 发送 `/list` → 至少列出原会话和新会话，带序号。
4. 发送 `/switch 1` → 切回原会话。
5. 再发一条普通消息，确认原会话收到。

### 验收 3：媒体回传

1. 让 Agent 生成一张图片（例如 `out/chart.png`）并调用 `present`，或直接调用 `wechat_send` 指定文件。
2. 任务结束后，微信中应出现图片；视频/音频/PDF 同理。
3. 若文件在会话 cwd 之外，把它加入 `mediaRoots`，否则会被安全策略拒绝。

### 验收 4：断网重连与游标

1. 正常收发几条消息，确认 `state.json` 中 `syncBuf` 非空。
2. 断开网络或让 iLink 请求失败。
3. 预期日志出现 `长轮询失败，…后重连`，随后自动恢复。
4. 重启 DSH，插件从 `syncBuf` 继续；重复消息由消息 ID 去重。

### 验收 5：日志不出现明文凭证

1. 正常使用后检查 DSH 日志。
2. `bot_token` 与 `context_token` 的值不应出现；只应看到“已加载 Bot 凭据”“收到消息：N 字符”等。
3. 打开 `state.json` 可见 `context_token`（这是协议必需缓存），因此该文件必须保持 `0600`，不要提交到仓库。

### 验收 6：卸载重装

```bash
dsh plugin --profile web remove dsh-wechat-channel
dsh plugin --profile web add dsh-wechat-channel
dsh web
```

若 Token 失效：调用 `wechat_login` 重新扫码；成功后无需改配置。

### 验收 7：超过 20 小时的降级

1. 让通道完成一次入站（获得 token）。
2. 模拟 21 小时未互动：停止 DSH，修改 `state.json` 的 `lastInboundAt` 为 `Date.now() - 21*3600*1000`，或直接等待。
3. 触发一个微信来源的任务完成。
4. 预期：日志写明“不尝试主动发送；已暂存摘要”，微信没有新消息。
5. 再在微信发一条消息 → 预期先收到“补发 … 的任务摘要”，再收到本次回复。

> 自动化测试已覆盖该路径：`test/channel.test.mjs` 的 “messages older than the 20 hour window …”。

---

## 14. 本地开发与验证

```bash
cd dsh-wechat-channel
npm install
npm run typecheck    # TypeScript
npm test             # 39 个测试：命令、状态、限速、媒体、桥接、通道、传输、插件入口
npm run smoke        # 无网络端到端冒烟：入站 → DSH 桥 → turn 完成 → 出站
npm run build
```

测试不访问真实微信，也不消耗模型额度：

- `test/unit.test.mjs`：文本切分、命令解析、配置、状态原子写、限速、媒体校验；
- `test/bridge.test.mjs`：live/offline 投递、preset 恢复、turn 事件、错误原因；
- `test/channel.test.mjs`：文本/命令/媒体/20h 补发/去重/重试/游标重启/脱敏/扫码/会话过期；
- `test/transport.test.mjs`：真实 `ApiClient` 对本地 HTTP mock 的请求体与 `context_token`；
- `test/audio.test.mjs`：WAV 解析与语音消息上传/发送报文；
- `test/media-upload.test.mjs`：`upload_full_url` / 旧 `upload_param` 两种上传协议；
- `test/tools.test.mjs`：`wechat_send` 使用调用方会话 cwd 校验文件；
- `test/plugin.test.mjs`：`apply()` 注册三个工具与生命周期。

---

## 15. 目录结构

```
dsh-wechat-channel/
├── src/
│   ├── index.ts            # Cordis 入口（name / inject / Config / apply）
│   ├── config.ts           # Schemastery Config + resolveConfig
│   ├── channel.ts          # 兼容导出
│   ├── channel/            # WechatChannel 拆分（编排 / 命令 / 类型）
│   ├── progress.ts         # 长任务进度推送
│   ├── login-page.ts       # 本地 Web 扫码页
│   ├── onboarding.ts       # 就绪阶段与引导文案
│   ├── tools.ts            # wechat_* 工具
│   ├── agent/bridge.ts     # DSH 适配
│   └── ilink/              # 协议与媒体
├── test/
├── README.md / README.en.md
└── cordis.patch.yml
```

---

## 16. 常见问题与排查

| 现象 | 处理 |
|---|---|
| 装完没反应 | 确认已**重启** `dsh web`；`dump-config` 里能看到 `wechat-channel` |
| 扫码后仍不能回 | 必须先在微信给 Bot 发一条消息拿 `context_token` |
| `errcode -14` | Token 过期，再跑 `wechat_login` 扫码 |
| 主动推送没到 | 是否超过约 20h 窗口；看 `/status` 待补发 |
| 发文件被拒 | 路径是否在 cwd / `mediaRoots`；是否超 `maxFileBytes` |

更细步骤见下方；完整本机教程见 [`安装与使用教程.md`](./安装与使用教程.md)。

### 16.1 扫码后微信没反应

- 确认微信版本 ≥ 8.0.70，且“设置 → 插件”里有机器人/ClawBot 入口；
- 确认扫码账号就是发消息的账号，与 `ownerUserId` 一致；
- 安装/重装后必须**重启** `dsh web`；
- 先给 Bot 发一条消息，拿到 `context_token`。

### 16.2 日志出现 `errcode -14`

Bot 会话过期。用 `wechat_login` 重新扫码；或设置 `autoRelogin: true` 让插件自动请求新二维码。`autoRelogin` 只负责生成二维码，仍需要人扫码。

### 16.3 主动推送没到

- 检查是否超过 20 小时窗口；
- 检查是否有 `context_token`；
- 检查 `/status` 的“待补发摘要”；
- 微信服务端可能直接丢弃，不会给插件明确回执。

### 16.4 文件被拒绝

- 默认只允许会话 cwd、进程 cwd、`mediaRoots`；
- 单文件默认 ≤ 100 MiB；
- 路径会 `realpath`，symlink 指向根目录外会被拒绝。

### 16.5 文件发送报 `getUploadUrl returned no upload_param`

这是 iLink 服务端从旧 `upload_param` 切换到 `upload_full_url` 导致的。插件 **0.1.1** 已同时支持两种返回：

- `upload_full_url`：直接 POST 到服务端返回的 CDN 全量 URL；
- `upload_param`：保留旧版 `cdnBaseUrl/upload?...` 路径。

更新后必须重新 `npm run build` 并重启 `dsh web`。如果待补发摘要中已有文件，下次微信入站会自动重试。

### 16.6 `dsh-agent-message` 装不上

它的 1.6.0 版本 peer 范围是 DSH `<0.2.0`，与本仓库的 `0.2.1-rc.2` 不匹配。本插件已内置等价投递逻辑，不需要安装它。

---

## 17. 许可

MIT。见 [LICENSE](./LICENSE)。
