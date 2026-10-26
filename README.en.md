# dsh-wechat-channel

Bidirectional **WeChat** channel for [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/): send instructions from a WeChat private chat to an existing DSH session, and receive text, images, audio, video, and files back when the agent finishes.

中文说明见 [README.md](./README.md) · 本机安装教程见 [`安装与使用教程.md`](./安装与使用教程.md) · Source: [`iris-mei614/dsh-wechat-channel`](https://github.com/iris-mei614/dsh-wechat-channel)

- Uses Tencent’s official **iLink Bot API** (`getupdates` long-poll + `sendmessage`).
- Protocol details via [`wechat-ilink-client`](https://www.npmjs.com/package/wechat-ilink-client) (MIT).
- Cordis plugin shape: `export const name / inject / Config / apply(ctx, config)`.
- Does **not** modify DSH core; talks only through public `agents`, `sessionQuery`, `tools`, and `credentials`.

### Quick start

1. Install the plugin and restart DSH (see Install).
2. Ask the agent to `call wechat_login`, then scan the QR.
3. Send any WeChat message to the bot to activate (`context_token`).
4. Chat normally; `/help` lists commands.

## Features

| Area | Behavior |
|---|---|
| Inbound | Long-poll text (+ voice STT); images/files saved to `wechat-inbox/` and handed to DSH; media-only holds briefly for a following caption; local commands |
| Outbound | Chunked text; image / video / voice / file; rate limit + retries |
| First-run | Setup phases `need-login` → `need-first-message` → `need-session` → `ready` |
| Progress | After hand-off, optional “still working” pings every N minutes (default 3) |
| Login | QR via `wechat_login`, terminal QR, and a local **Web login page** |
| Agent tools | `wechat_send`, `wechat_status`, `wechat_login` |
| Safety | Single chat only; owner binding; credential redaction; media root checks |

**Not supported:** group chats; cold-start proactive messages without a prior inbound `context_token`; bypassing WeChat’s 24h window.

> [!IMPORTANT]
> **Usage rules (reduce ban / abuse-risk)**
>
> This plugin uses Tencent’s official iLink Bot API and **cannot guarantee** accounts will never be restricted. Follow WeChat’s rules, and at minimum:
>
> - **Serve only your bound account** — no mass messaging, harassment, or marketing blasts
> - **Keep the default rate limit** (~10 messages/minute) — don’t crank it up for aggressive sending
> - **Don’t try to bypass the 24-hour window** or push before the chat is activated
> - **Don’t send prohibited content**

## Requirements

- DeepSeek Harness **0.2.1-rc.2+** (public plugin APIs)
- Node.js **22.19+** or **24.x**
- WeChat **8.0.70+** with ClawBot / bot plugin entry enabled for the account
- Network access to `*.weixin.qq.com` and `*.cdn.weixin.qq.com`

## Install

### From npm (recommended, after publish)

```bash
dsh plugin --profile web add dsh-wechat-channel
# or: npx @deepseek-ai/dsh plugin --profile web add dsh-wechat-channel
dsh web   # restart required
```

Or in DSH: **Settings → Plugins → Add plugin** → `dsh-wechat-channel`.

With the `dsh-plugin` keyword on npm, the [DSH marketplace](https://dshmp.com/) usually indexes the package within about a day.

### From source (development)

```bash
git clone https://github.com/iris-mei614/dsh-wechat-channel.git
cd dsh-wechat-channel
npm install && npm run build
dsh plugin --profile web add "$(pwd)"
dsh web
```

Confirm:

```bash
dsh --profile web --dump-config | grep -A6 wechat
```

## First-run journey

1. Ask the agent: *call wechat_login* — or rely on `autoLogin`.
2. Open the QR URL, the terminal QR, or the **Web login page** at `http://127.0.0.1:19876/`.
3. Scan and confirm in WeChat.
4. Send any message to the bot (e.g. `你好`) to obtain `context_token`.
5. With defaults, the first ordinary text auto-creates a DSH session and replies with a short welcome + “processing” ack.

Check `/status` or `wechat_status` for `setupPhase` / `nextAction`.

## Minimal config

In the profile `cordis.patch.yml` (schema-validated via exported `Config`):

```yaml
- id: wechat-channel
  config:
    defaultSessionId: ''
    botTokenRef: WECHAT_ILINK_BOT_TOKEN
    sendStartAck: true
    sendProgressUpdates: true
    progressIntervalMs: 180000
    enableLoginPage: true
    loginPagePort: 19876
```

Important knobs:

| Field | Default | Meaning |
|---|---|---|
| `sendStartAck` | `true` | Reply “processing…” after a successful hand-off |
| `sendProgressUpdates` | `true` | Periodic progress while the turn runs |
| `progressIntervalMs` | `180000` | Progress interval (3 minutes) |
| `enableLoginPage` | `true` | Local Web QR page on `127.0.0.1` |
| `autoCreateSessionOnFirstMessage` | `true` | Auto `/new` when unbound |
| `windowHours` | `20` | Proactive-send safety window |

## WeChat commands

`/help` `/new` `/list` `/switch` `/bind` `/status` `/stop` `/steer`  
Chinese aliases: `/帮助` `/新建` `/列表` `/切换` `/绑定` `/状态` `/停止` `/介入`

Ordinary text is delivered with `followup`. Long tasks get progress pings until `turn/end`, then the completion summary (and `present` files).

## Develop & test

```bash
npm run typecheck
npm test
npm run smoke
npm run check
```

Layout:

```
src/
  index.ts              # Cordis entry (name / inject / Config / apply)
  config.ts             # Schemastery Config + resolveConfig
  channel/              # WechatChannel split (commands, types, orchestrator)
  progress.ts           # Long-turn progress tracker
  login-page.ts         # Localhost Web QR page
  agent/bridge.ts       # DSH agents / sessionQuery adapter
  ilink/                # Protocol transport + media
```

## License

MIT. See [LICENSE](./LICENSE).
