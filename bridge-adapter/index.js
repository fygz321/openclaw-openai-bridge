/**
 * OpenClaw HTTP Bridge → OpenAI SSE 适配层
 * 监听 18790，把 LobeChat 的 /v1/chat/completions 请求桥接到 HTTP Bridge
 */

const http = require("http");
const crypto = require("crypto");

const BRIDGE_URL = "http://127.0.0.1:18789/httpbridge/inbound";
const BRIDGE_TOKEN = "bridge-secret-2024";
const PORT = 18790;
const TIMEOUT_MS = 120_000;

// conversationId -> { res, timer }
const pending = new Map();

function makeConversationId(messages) {
  // 用前几条消息内容生成稳定的 conversationId，保持上下文连续
  const key = messages
    .slice(0, 3)
    .map((m) => `${m.role}:${String(m.content).slice(0, 40)}`)
    .join("|");
  return crypto.createHash("md5").update(key).digest("hex").slice(0, 16);
}

function sendSSEChunk(res, content) {
  const delta = JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "openclaw-agent",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  res.write(`data: ${delta}\n\n`);
}

function sendSSEDone(res) {
  const done = JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "openclaw-agent",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  res.write(`data: ${done}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function postToBridge(conversationId, text, callbackUrl) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      conversationId,
      text,
      callbackUrl,
    });
    const url = new URL(BRIDGE_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode === 202) resolve();
        else reject(new Error(`Bridge returned ${res.statusCode}`));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── 回调端点（Bridge → 适配层）──
  if (req.method === "POST" && url.pathname === "/callback") {
    const body = await readBody(req);
    res.statusCode = 200;
    res.end("ok");

    const entry = pending.get(body.conversationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(body.conversationId);

    const text = body.text || "";
    sendSSEChunk(entry.res, text);
    sendSSEDone(entry.res);
    return;
  }

  // ── 模型列表 ──
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "openclaw-agent", object: "model", created: 0, owned_by: "openclaw" }],
      })
    );
    return;
  }

  // ── Chat Completions ──
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      res.statusCode = 400;
      res.end("invalid json");
      return;
    }

    const messages = payload.messages || [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser ? String(lastUser.content) : "";

    if (!text) {
      res.statusCode = 400;
      res.end("no user message");
      return;
    }

    const conversationId = makeConversationId(messages);
    const callbackUrl = `http://127.0.0.1:${PORT}/callback`;

    // 设置 SSE 响应头
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.statusCode = 200;

    // 超时保护
    const timer = setTimeout(() => {
      pending.delete(conversationId);
      sendSSEChunk(res, "[timeout: no response from agent]");
      sendSSEDone(res);
    }, TIMEOUT_MS);

    pending.set(conversationId, { res, timer });

    try {
      await postToBridge(conversationId, text, callbackUrl);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(conversationId);
      sendSSEChunk(res, `[bridge error: ${err.message}]`);
      sendSSEDone(res);
    }
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Bridge adapter listening on :${PORT}`);
});
