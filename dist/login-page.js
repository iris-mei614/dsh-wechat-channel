import { createServer } from 'node:http';
import { formatDuration, formatTimestamp } from './text.js';
/**
 * Tiny localhost page for QR login. Avoids a full DSH Web client slot package
 * while still giving operators a browser-scannable surface for demos.
 */
export class LoginPageServer {
    getSnapshot;
    server;
    port = 0;
    url = '';
    constructor(getSnapshot) {
        this.getSnapshot = getSnapshot;
    }
    get address() {
        return this.url;
    }
    get running() {
        return this.server !== undefined;
    }
    async start(preferredPort) {
        if (this.server !== undefined)
            return this.url;
        const port = preferredPort > 0 ? preferredPort : 0;
        this.server = createServer((req, res) => this.handle(req, res));
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                this.server?.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                this.server?.off('error', onError);
                resolve();
            };
            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(port, '127.0.0.1');
        });
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
            await this.stop();
            throw new Error('登录页服务器未能绑定端口');
        }
        this.port = address.port;
        this.url = `http://127.0.0.1:${this.port}/`;
        return this.url;
    }
    async stop() {
        const server = this.server;
        this.server = undefined;
        this.port = 0;
        this.url = '';
        if (server === undefined)
            return;
        await new Promise((resolve) => {
            server.close(() => resolve());
            // Force-close lingering keep-alive sockets so unload is prompt.
            server.closeAllConnections?.();
        });
    }
    handle(req, res) {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/api/status') {
            this.json(res, this.getSnapshot());
            return;
        }
        if (path === '/' || path === '/index.html') {
            this.html(res, renderLoginHtml(this.getSnapshot()));
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }
    json(res, body) {
        res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        });
        res.end(JSON.stringify(body));
    }
    html(res, body) {
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
        });
        res.end(body);
    }
}
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function healthLines(snapshot) {
    const rows = [];
    if (snapshot.health)
        rows.push(`健康：${snapshot.health}`);
    if (typeof snapshot.lastPollAt === 'number' && snapshot.lastPollAt > 0) {
        rows.push(`最近轮询：${formatTimestamp(snapshot.lastPollAt)}`);
    }
    if (typeof snapshot.lastInboundAt === 'number' && snapshot.lastInboundAt > 0) {
        rows.push(`最近入站：${formatTimestamp(snapshot.lastInboundAt)}`);
    }
    if (typeof snapshot.windowRemainingMs === 'number') {
        rows.push(`推送窗口剩余：${formatDuration(snapshot.windowRemainingMs)}`);
    }
    if (typeof snapshot.pendingNotices === 'number') {
        rows.push(`待补发：${snapshot.pendingNotices}`);
    }
    if (typeof snapshot.queueSize === 'number') {
        rows.push(`出站队列：${snapshot.queueSize}`);
    }
    return rows.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
}
export function renderLoginHtml(snapshot) {
    const qr = snapshot.qrUrl ?? '';
    const qrBlock = qr === ''
        ? '<p class="hint">当前没有待扫描的二维码。若已登录，可关闭本页。</p>'
        : [
            `<p class="hint">用手机微信扫描下方二维码，确认后回到微信给 Bot 发任意一条消息完成激活。</p>`,
            `<div class="qr"><img alt="WeChat login QR" src="${escapeHtml(qr)}" /></div>`,
            `<p class="link"><a href="${escapeHtml(qr)}" target="_blank" rel="noreferrer">打不开图片时点这里打开链接</a></p>`,
        ].join('\n');
    const healthBlock = `<ul class="health" id="health">${healthLines(snapshot)}</ul>`;
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DSH 微信扫码登录</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1220; color: #e8eefc; }
    main { width: min(420px, 92vw); padding: 28px 24px 32px; border-radius: 16px; background: #121a2b; box-shadow: 0 20px 50px rgba(0,0,0,.35); }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    .status { margin: 0 0 12px; color: #9db0d0; font-size: .95rem; line-height: 1.45; }
    .health { margin: 0 0 16px; padding-left: 1.1rem; color: #9db0d0; font-size: .88rem; line-height: 1.55; }
    .hint { margin: 0 0 16px; line-height: 1.5; }
    .qr { display: grid; place-items: center; padding: 16px; border-radius: 12px; background: #fff; }
    .qr img { width: min(280px, 70vw); height: auto; }
    .link { margin: 14px 0 0; font-size: .85rem; word-break: break-all; }
    a { color: #8cb4ff; }
    .ok { color: #7dffa6; }
    .bad { color: #ffb4a8; }
  </style>
</head>
<body>
  <main>
    <h1>微信 iLink 扫码登录</h1>
    <p class="status" id="status">${escapeHtml(snapshot.setupLabel)} — ${escapeHtml(snapshot.nextAction)}</p>
    ${healthBlock}
    <div id="qr">${qrBlock}</div>
  </main>
  <script>
    function healthHtml(data) {
      const rows = [];
      if (data.health) rows.push('健康：' + data.health);
      if (data.lastPollAt) rows.push('最近轮询：' + new Date(data.lastPollAt).toLocaleString());
      if (data.lastInboundAt) rows.push('最近入站：' + new Date(data.lastInboundAt).toLocaleString());
      if (typeof data.windowRemainingMs === 'number') {
        const mins = Math.max(0, Math.round(data.windowRemainingMs / 60000));
        rows.push('推送窗口剩余：约 ' + mins + ' 分钟');
      }
      if (typeof data.pendingNotices === 'number') rows.push('待补发：' + data.pendingNotices);
      if (typeof data.queueSize === 'number') rows.push('出站队列：' + data.queueSize);
      return rows.map((line) => '<li>' + line.replace(/</g, '&lt;') + '</li>').join('');
    }
    async function refresh() {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        const data = await res.json();
        const status = document.getElementById('status');
        const health = document.getElementById('health');
        const qr = document.getElementById('qr');
        if (status) status.textContent = (data.setupLabel || data.status || '') + ' — ' + (data.nextAction || '');
        if (health) {
          health.innerHTML = healthHtml(data);
          health.className = 'health' + (data.pollHealthy === false ? ' bad' : data.pollHealthy ? ' ok' : '');
        }
        if (data.connected) {
          if (status) { status.className = 'status ok'; status.textContent = '已登录。请在微信给 Bot 发任意消息以激活，然后可关闭本页。'; }
          if (qr) qr.innerHTML = '<p class="hint ok">登录成功。本页会继续显示健康状态。</p>';
          return;
        }
        if (qr && data.qrUrl) {
          qr.innerHTML = '<p class="hint">用手机微信扫描下方二维码，确认后回到微信给 Bot 发任意一条消息完成激活。</p>'
            + '<div class="qr"><img alt="WeChat login QR" src="' + data.qrUrl.replace(/"/g, '&quot;') + '" /></div>'
            + '<p class="link"><a href="' + data.qrUrl.replace(/"/g, '&quot;') + '" target="_blank" rel="noreferrer">打不开图片时点这里打开链接</a></p>';
        }
      } catch (_) {}
    }
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}
//# sourceMappingURL=login-page.js.map