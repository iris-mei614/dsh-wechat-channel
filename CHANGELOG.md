# Changelog

## 0.2.0

- **Rename.** Package / Cordis plugin identity is now `dsh-wechat-channel`
  (plugin id `wechat-channel`). Default credential ref remains
  `WECHAT_ILINK_BOT_TOKEN` so existing DSH credentials keep working. Default
  state directory is now `$DSH_HOME/wechat-channel` (copy from `wechat-ilink`
  if you need the old cursor / context_token).


## 0.1.8

- **WeChat session titles.** Sessions created from WeChat (`/new`, `/clear`,
  auto-create) are named on the first followup as
  `[微信会话] <first-message summary>` via DSH `sessionTitle.rename`.

## 0.1.7

- **Richer progress.** Long-turn pings can include a current-step summary
  (tool activity from session events), e.g. reading a file or running a command.
- **Retry.** Failed WeChat→DSH delivers can be retried with `/retry` or bare
  `重试`.
- **Shortcuts.** `/clear` starts a fresh session (keeps the old one);
  `/model` shows/attempts to switch the default model.
- **Friendlier session copy** for `/list` `/switch` `/bind` `/help`.
- **Window expiry reminder** when proactive window remaining drops below
  `windowWarnHours` (default 2h).
- **Health in `/status` and the login page:** poll health, last inbound/poll,
  pending notices, queue size.

## 0.1.6

- **Media caption hold.** WeChat often delivers an image and the following text
  as two separate messages. Pure-media inbound is now held briefly
  (`inboundMediaHoldMs`, default 30s) so a caption can merge into one DSH turn.
  Optional prompt via `askCaptionOnMediaOnly`; send `开始` / `分析` to flush
  immediately; timeout falls back to a default analyze prompt.

## 0.1.5

- **Inbound media.** WeChat images, videos, files (and raw voice bytes) are
  downloaded, saved under `<session-cwd>/wechat-inbox/`, and handed to DSH with
  a path summary. When `ctx.attachments` is available, images/files are also
  admitted as durable attachment content blocks.
- Config: `enableInboundMedia` (default true), `inboundMediaDir` (default
  `wechat-inbox`). Media-only messages create a turn; size limited by
  `maxFileBytes`.

## 0.1.4

- **Long-turn progress.** While a WeChat-originated turn is running, the channel
  periodically sends `仍在处理，已进行 …` (default every 3 minutes;
  `sendProgressUpdates` / `progressIntervalMs`).
- **Config schema.** Export Schemastery `Config` so Cordis / the DSH Plugins UI
  can validate and edit settings (`schemastery` dependency).
- **Web login page.** Optional localhost page (`enableLoginPage`, default port
  `19876`) shows the QR and live setup status for browser scanning.
- **Channel split.** Move orchestration into `src/channel/` (`wechat-channel`,
  `command-runtime`, `types`) plus `progress.ts` / `login-page.ts`.
- **English README.** Add `README.en.md`.

## 0.1.3

- **Processing feedback.** `sendStartAck` now defaults to `true`: after a WeChat
  message is successfully handed to DSH, the user gets
  `已收到，DSH 正在处理，请稍候…`. Delivery failures are replied to WeChat; WeChat
  outbound failures (window deferral, push errors, `wechat_send`) also post a
  `[微信通道]` notice into the live DSH session.
- **First-run journey polish (扫码 → 首条消息).** The channel now exposes an
  explicit setup phase: `need-login` → `need-first-message` → `need-session` →
  `ready`, surfaced in `/status` and `wechat_status` with a concrete next action.
- `wechat_login` guidance lists the three activation steps; after a successful
  scan the logs tell the user to send any WeChat message to obtain
  `context_token`.
- Optional terminal QR rendering via `qrcode-terminal` (`printQrInTerminal`,
  default on).
- Default `autoCreateSessionOnFirstMessage: true` — the first ordinary WeChat
  text creates and binds a DSH session when none is configured.
- Default `sendWelcomeOnActivate: true` — the first inbound activation sends a
  short welcome (and skips the redundant start-ack when welcome already says
  the message is being processed).

## 0.1.2

- Require the DSH `credentials` service in `inject` and retry token resolution
  for up to 5 seconds at startup. This prevents a race where the channel loaded
  before the credential provider settled, fell back to a fresh QR login, and
  never started long-polling even though a valid token was on disk.
- No protocol or command changes.

## 0.1.1

- **Fix media uploads for the current iLink service.** `getUploadUrl` now
  returns `upload_full_url` (with the encrypted query already embedded) instead
  of the legacy `upload_param`. The old client failed every image/video/file
  send with `getUploadUrl returned no upload_param`. Both response shapes are
  now supported.
- Validate `upload_full_url` against official WeChat/CDN hosts before POSTing.
- **Fix `wechat_send` file-root validation.** The tool now uses the *calling*
  DSH session's cwd, not the WeChat-bound session's cwd, so files produced in
  another session are no longer rejected as "outside the workspace".
- Add regression tests for both upload protocols and caller-session roots.

## 0.1.0

- Initial release: iLink long-poll, commands, session binding, text/media
  outbound, turn-end notifications, 24-hour window fallback, cursor
  persistence, reconnect, rate limiting, credential storage and QR login.
