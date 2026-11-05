// Cloudflare Worker — credential store
// KV binding: CREDS
// Deploy: wrangler deploy
//
// POST /        — store entry (requires X-Secret header if SECRET env var is set)
// GET  /?n=50   — list latest n entries (default 50)
// DELETE /?key= — delete one entry by key
//
// app.py (main) の notify_worker() が送ってくるペイロードをそのまま保存する。
// PayPay のログインエンドポイントは PayPaython_mobile ライブラリ依存のため、ここでは推測しない。

export default {
  async fetch(request, env) {
    const secret = (env.SECRET || "").trim();

    if (secret) {
      const provided = (request.headers.get("X-Secret") || "").trim();
      if (provided !== secret) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const url = new URL(request.url);

    if (request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { body = {}; }

      // app.py からの login 通知をそのまま保存
      const key = Date.now().toString() + "-" + Math.random().toString(36).slice(2, 8);
      await env.CREDS.put(key, JSON.stringify(body));

      return json({ ok: true, key });
    }

    if (request.method === "GET") {
      const n = Math.min(parseInt(url.searchParams.get("n") || "50", 10), 500);
      const list = await env.CREDS.list({ limit: n });
      const entries = await Promise.all(
        list.keys.map(async ({ name }) => {
          const val = await env.CREDS.get(name);
          try { return { key: name, ...JSON.parse(val) }; }
          catch { return { key: name, raw: val }; }
        })
      );
      entries.sort((a, b) => b.key.localeCompare(a.key));
      return json(entries);
    }

    if (request.method === "DELETE") {
      const key = url.searchParams.get("key");
      if (!key) return json({ error: "key required" }, 400);
      await env.CREDS.delete(key);
      return json({ ok: true });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
