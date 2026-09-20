/**
 * Linq iMessage -> web research agent.
 *
 * Two execution tiers:
 *   research  - browserbase.search() + browserbase.fetch() read public pages in
 *               parallel, then one synthesis call produces structured results.
 *               No browser session. Handles most requests.
 *   browser   - a real Stagehand/Browserbase session driven by an
 *               observe -> decide -> act loop, for tasks that need interaction.
 *
 * Results are rendered per task-type playbook and texted back via Linq v3.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import axios from "axios";
import express from "express";
// NOTE: two zod copies exist - this one (app) and stagehand's own. extract()
// converts the schema with its copy and parses the result with ours. Verified
// working; if a future npm update breaks it, build schemas from stagehand's zod.
import { z } from "zod";
import { Stagehand, browserbase } from "@browserbasehq/stagehand";
import Browserbase from "@browserbasehq/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const ARTIFACT_DIR = path.join(PUBLIC_DIR, "runs");

const {
  OPENAI_API_KEY,
  // Stagehand form - the "provider/" prefix is required by its schema.
  OPENAI_MODEL = "openai/gpt-5.5",
  // Bare form for direct chat-completions calls.
  OPENAI_MODEL_REASONING = "gpt-5.5",
  LINQ_API_KEY,
  LINQ_PHONE_NUMBER,
  LINQ_API_URL = "https://api.linqapp.com/api/partner/v3/messages",
  LINQ_WEBHOOK_SECRET,
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  PUBLIC_BASE_URL,
  PORT = 3000,
  TASK_TIMEOUT_MS = 180000,
  RESEARCH_BUDGET_MS = 90000,
  BROWSER_CONCURRENCY = 2,
  RESEARCH_FETCH_CONCURRENCY = 5,
  MAX_BROWSER_STEPS = 8,
  ARTIFACT_TTL_MS = 3600000,
  RATE_LIMIT_PER_HOUR = 8,
  TURN_LIMIT_PER_HOUR = 30,
  MEMORY_MAX_TURNS = 12,
  MEMORY_TTL_MS = 21600000,
  MEMORY_MAX_SENDERS = 500,
  MEMORY_TURN_CHARS = 600,
  CLARIFY_TTL_MS = 900000,
  ROUTER_TIMEOUT_MS = 20000,
  CHAT_MAX_CHARS = 1200,
  // Every ack is a billable outbound message. "slow" sends one only where the
  // wait warrants it; "never" collapses every exchange to a single send.
  ACK_MODE = "slow",
  // Residential proxies for browser sessions. Costs proxy bandwidth, but
  // without it many public pages serve a login wall to a datacenter IP.
  BROWSER_PROXIES = "true",
  DEBUG_TOKEN,
} = process.env;

const TASK_TIMEOUT = Number(TASK_TIMEOUT_MS);
const RESEARCH_BUDGET = Number(RESEARCH_BUDGET_MS);
const MAX_STEPS = Number(MAX_BROWSER_STEPS);
const ARTIFACT_TTL = Number(ARTIFACT_TTL_MS);

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

/**
 * Cooperative time budget. withTimeout only stops *waiting* on a promise - the
 * underlying Browserbase session keeps running and billing. Phases check a
 * Deadline between steps so they can stop doing more work.
 */
class Deadline {
  constructor(ms) {
    this.expiresAt = Date.now() + ms;
  }
  remaining() {
    return Math.max(0, this.expiresAt - Date.now());
  }
  expired() {
    return this.remaining() <= 0;
  }
  assert(label) {
    if (this.expired()) throw new Error(`${label}: out of time`);
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Counting semaphore - bounds how many Browserbase sessions run at once. */
function semaphore(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  const acquire = () =>
    active < max
      ? ((active += 1), Promise.resolve())
      : new Promise((resolve) => waiting.push(() => ((active += 1), resolve())));
  const run = async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
  run.active = () => active;
  run.waiting = () => waiting.length;
  return run;
}

const browserSlot = semaphore(Number(BROWSER_CONCURRENCY));

/** Bounded parallel map. Never rejects - one bad URL must not sink the batch. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One task at a time per sender, so a single number cannot fan out into
 * many concurrent sessions. The map entry is deleted when the chain drains,
 * otherwise it is a slow leak keyed by phone number.
 */
const senderQueues = new Map();
function enqueueForSender(sender, fn) {
  const tail = (senderQueues.get(sender) ?? Promise.resolve()).then(fn, fn);
  senderQueues.set(sender, tail);
  tail.finally(() => {
    if (senderQueues.get(sender) === tail) senderQueues.delete(sender);
  });
  return tail;
}

/** Sliding-window rate limit. Requests cost real money, so cap them. */
const rateWindows = new Map();
function checkRateLimit(sender, bucket = "task", limit = Number(RATE_LIMIT_PER_HOUR)) {
  // Two budgets, because the costs differ by orders of magnitude: a task is a
  // Browserbase session plus fetches plus synthesis, a chat turn is two short
  // completions. Charging "thanks" against the research budget is what makes
  // the agent feel stingy for no saving.
  const key = `${bucket}:${sender}`;
  const now = Date.now();
  const hits = (rateWindows.get(key) ?? []).filter((t) => now - t < 3600000);
  if (hits.length >= limit) {
    const retryMin = Math.ceil((3600000 - (now - hits[0])) / 60000);
    rateWindows.set(key, hits);
    return { ok: false, retryMin, limit };
  }
  hits.push(now);
  rateWindows.set(key, hits);
  return { ok: true, remaining: limit - hits.length };
}

/**
 * OpenAI strict structured-output mode rejects most JSON-Schema validation
 * keywords. Strip them, but keep `description` - that is how the schema steers
 * the model. Cardinality goes in the prompt and is enforced with .slice().
 */
const STRICT_UNSUPPORTED = new Set([
  "minItems", "maxItems", "minLength", "maxLength", "pattern", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "default", "$schema", "minProperties", "maxProperties",
]);

function stripUnsupported(node) {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRICT_UNSUPPORTED.has(key)) continue;
    out[key] = stripUnsupported(value);
  }
  // strict mode also demands every property be required and no extras.
  if (out.type === "object" && out.properties) {
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

function toStrictJsonSchema(schema) {
  return stripUnsupported(z.toJSONSchema(schema, { io: "output" }));
}

/**
 * Clamp without ending mid-word, and preferably not mid-sentence.
 *
 * A model asked for one line often writes two, and cutting the second one open
 * reads worse than not having it: "shows 687 followers and 801 following. The
 * profile name shown is…" invites a follow-up question about a fact that was
 * never going to arrive. If a sentence ends in the last part of the budget,
 * stop there and drop the trailing "…" - the text is then complete, not cut.
 */
function clamp(s, n) {
  const str = String(s ?? "");
  if (str.length <= n) return str;
  const cut = str.slice(0, n - 1);

  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > n * 0.5) return cut.slice(0, sentence + 1);

  const space = cut.lastIndexOf(" ");
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The corpus is markdown, so models echo markdown syntax into string fields.
 * Strip it rather than hoping the prompt holds.
 */
function stripMarkdown(s) {
  return String(s ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The same, but for prose. stripMarkdown collapses all whitespace, which is
 * right for a product name on one line and wrong for a chat reply, where it
 * would run every paragraph together.
 */
function stripMarkdownSoft(s) {
  return String(s ?? "")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1 $2")
    .replace(/[*_`#>]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

/**
 * Anything texted here has already passed through Apple and Linq before it
 * arrives, so this cannot make a secret safe. What it can do is stop this app
 * adding three more copies - stdout, the conversation store, and the prompt
 * sent to OpenAI - and stop the agent ever echoing one back.
 *
 * This matches the shape of someone *announcing* a credential, which is the
 * shape that actually occurs, rather than trying to recognise a bare token.
 * The real protection is that the agent never asks, so the shape never arises.
 */
const SECRET_RE = new RegExp(
  [
    // "password: hunter2", "my pin = 1234", "otp is 998211".
    //
    // The separator is required. It was optional, which meant the pattern fired
    // on any mention of the word at all - "I forgot my password again", "a good
    // password manager", "pin that to the board", "the secret to good bread" -
    // and answered each of them with a refusal to accept credentials. A filter
    // that rejects ordinary sentences is worse than none: it teaches people the
    // agent is broken, and they stop trusting the one refusal that matters.
    String.raw`\b(?:pass(?:word|code)?|pwd|passphrase|pin|otp|2fa|mfa|one[- ]time (?:code|password)|verification code|security code|auth code|cvv|ssn|api[- ]?key|access[- ]?token)\b\s*(?:is|are|=|:)\s+\S{3,}`,
    // "user@example.com / hunter2" - an inline credential pair.
    String.raw`\b[\w.+-]+@[\w.-]+\s*[/|]\s*\S{6,}`,
    // Literal token shapes. "secret" and "bearer" used to be in the word list
    // above and had to come out - "the secret is patience" is ordinary English
    // and the word carries no signal on its own. A token that was pasted in
    // carries the signal in its prefix instead, which prose never produces.
    String.raw`\b(?:sk-[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9+/=_-]{16,}|bb_(?:live|test)_[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
  ].join("|"),
  "gi",
);

/** Used to catch a clarifying question that drifted into asking for a secret. */
const SECRET_ASK_RE =
  /\b(pass(word|code)|pwd|passphrase|pin|otp|2fa|mfa|one[- ]time code|verification code|security code|login (details|info|credentials)|credentials|cvv)\b/i;

function redactSecrets(text) {
  const raw = String(text ?? "");
  SECRET_RE.lastIndex = 0;
  const redacted = raw.replace(SECRET_RE, "[redacted]");
  return { text: redacted, hadSecret: redacted !== raw };
}

/* ------------------------------------------------------------------ */
/* LLM helper                                                          */
/* ------------------------------------------------------------------ */

class ResearchThinError extends Error {}

/**
 * Request body shared by every chat-completions call.
 *
 * gpt-5 and o-series reject an explicit temperature ("only the default (1) is
 * supported"), so it is only sent for models that accept it. That rule lives
 * here alone - having two call sites disagree about it is how a whole class of
 * 400s gets introduced later.
 */
function chatBody(model, messages) {
  const modelId = (model ?? OPENAI_MODEL_REASONING).replace(/^openai\//, "");
  return {
    model: modelId,
    messages,
    ...(/^(gpt-5|o\d)/.test(modelId) ? {} : { temperature: 0 }),
  };
}

/**
 * A plain-text completion over a real message list.
 *
 * llmJSON takes a single user string, which is right for a one-shot
 * classification and wrong for a conversation: flattening prior turns into one
 * blob discards the assistant/user structure, which is most of what having
 * history buys.
 */
async function llmText({ system, messages, model, deadline, maxTokens = 600 }) {
  const { data } = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      ...chatBody(model, [{ role: "system", content: system }, ...messages]),
      max_completion_tokens: maxTokens,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: Math.max(10000, Math.min(60000, deadline.remaining())),
    },
  );
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * One structured-output call. Uses strict json_schema, falls back to
 * json_object for endpoints that do not support it, and repairs once on a
 * schema-validation failure.
 */
async function llmJSON({ system, user, schema, schemaName, model, deadline, maxRepair = 1 }) {
  const jsonSchema = toStrictJsonSchema(schema);
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const post = (body) =>
    axios.post("https://api.openai.com/v1/chat/completions", body, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: Math.max(15000, Math.min(90000, deadline.remaining())),
    });

  const base = chatBody(model, messages);

  let raw;
  try {
    const { data } = await post({
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema: jsonSchema },
      },
    });
    raw = data.choices[0].message.content;
  } catch (err) {
    const detail = err.response?.data?.error?.message ?? "";
    if (!/json_schema|response_format|strict/i.test(detail)) throw err;
    // Endpoint does not do strict schemas - inline the schema instead.
    console.warn("[llm] json_schema unsupported, falling back to json_object");
    const { data } = await post({
      ...base,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${system}\n\nReply with JSON matching exactly this schema:\n${JSON.stringify(jsonSchema)}` },
        { role: "user", content: user },
      ],
    });
    raw = data.choices[0].message.content;
  }

  for (let attempt = 0; ; attempt += 1) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const result = parsed ? schema.safeParse(parsed) : { success: false, error: new Error("not JSON") };
    if (result.success) return result.data;
    if (attempt >= maxRepair || deadline.expired()) {
      throw new Error(`${schemaName} did not validate: ${result.error?.message?.slice(0, 200)}`);
    }
    const { data } = await post({
      ...base,
      response_format: { type: "json_object" },
      messages: [
        ...messages,
        { role: "assistant", content: raw },
        { role: "user", content: `That did not match the schema: ${String(result.error?.message).slice(0, 500)}. Reply again with valid JSON only.` },
      ],
    });
    raw = data.choices[0].message.content;
  }
}

/* ------------------------------------------------------------------ */
/* Webhook signature verification (Standard Webhooks)                  */
/* ------------------------------------------------------------------ */

const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Linq signs webhooks per the Standard Webhooks spec: HMAC-SHA256 over
 * "{webhook-id}.{webhook-timestamp}.{raw body}", keyed by the base64-decoded
 * secret, sent as "v1,<base64>" (possibly several, space separated).
 *
 * The endpoint is publicly reachable, so without this anyone who learns the
 * URL could make the agent burn Browserbase sessions and text strangers.
 */
function verifyWebhookSignature(req) {
  if (!LINQ_WEBHOOK_SECRET) return { ok: true, skipped: true };

  const id = req.get("webhook-id");
  const timestamp = req.get("webhook-timestamp");
  const header = req.get("webhook-signature");
  if (!id || !timestamp || !header) {
    return { ok: false, reason: "missing webhook-id/timestamp/signature header" };
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp outside ${SIGNATURE_TOLERANCE_SECONDS}s tolerance` };
  }

  if (!req.rawBody) {
    // Diagnostic: a body express.json() declined to parse leaves rawBody unset,
    // which would look like a signature mismatch on a perfectly valid webhook.
    return { ok: false, reason: `raw body unavailable (content-type: ${req.get("content-type")})` };
  }

  const key = Buffer.from(LINQ_WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64");
  const hmac = crypto.createHmac("sha256", key);
  // Feed the raw bytes, not a re-serialized object: any key reordering or
  // whitespace change from JSON.parse -> JSON.stringify breaks the digest.
  hmac.update(`${id}.${timestamp}.`);
  hmac.update(req.rawBody);
  const expected = hmac.digest();

  const provided = header
    .split(" ")
    .map((entry) => entry.split(","))
    .filter(([version, value]) => version === "v1" && value)
    .map(([, value]) => Buffer.from(value, "base64"));

  const matched = provided.some(
    (sig) => sig.length === expected.length && crypto.timingSafeEqual(sig, expected),
  );
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/* ------------------------------------------------------------------ */
/* Linq outbound                                                       */
/* ------------------------------------------------------------------ */

/**
 * Send a message back over iMessage. `parts` follows Linq's v3 shape:
 * [{ type: "text", value }] and/or [{ type: "media", url }].
 */
async function sendLinq(to, parts) {
  if (!to) {
    console.warn("[linq] no recipient, skipping send:", JSON.stringify(parts));
    return null;
  }
  try {
    const { data } = await axios.post(
      LINQ_API_URL,
      { to: [to], message: { parts } },
      {
        headers: {
          Authorization: `Bearer ${LINQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      },
    );
    console.log(`[linq] -> ${to}`, parts.map((p) => p.type).join("+"));
    return data;
  } catch (err) {
    const detail = err.response
      ? `${err.response.status} ${JSON.stringify(err.response.data)}`
      : err.message;
    console.error(`[linq] send failed: ${detail}`);
    return null;
  }
}

const sendText = (to, value) => sendLinq(to, [{ type: "text", value }]);

const WATCH_CHECK_INTERVAL_MS = Number(process.env.WATCH_CHECK_INTERVAL_MS ?? 900000);
const WATCH_REQUEST_RE = /\b(?:track|watch|notify me when|alert me when|back in stock)\b/i;
const WATCH_REMOVE_RE = /\b(?:stop|cancel|remove)\b.*\b(?:tracking|watching|alerts?)\b/i;
const productWatches = new Map();

function parseWatchRequest(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return null;

  const urlMatch = clean.match(/https?:\/\/[^\s]+/i);
  const url = urlMatch ? urlMatch[0].replace(/[),.;]+$/, "") : null;

  let name = clean
    .replace(/https?:\/\/[^\s]+/gi, "")
    .replace(/\b(?:track|watch|notify me when|alert me when|back in stock|please|thanks|stop|cancel|remove|tracking|watching|alert)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!name && url) name = "tracked product";
  if (!name) return null;

  return {
    name: clamp(name, 120),
    url: url ?? null,
  };
}

async function checkProductAvailability(url) {
  if (!url) return { state: "unknown", title: "Product page", summary: "No URL provided." };

  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      responseType: "text",
      validateStatus: () => true,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ProductWatch/1.0)" },
    });
    const html = String(data ?? "");
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = stripMarkdownSoft(titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim() || "Product page";
    const normalized = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase();

    const inStockSignals = /(in stock|available now|add to cart|buy now|ready to ship|ships today|currently available)/i;
    const outOfStockSignals = /(sold out|out of stock|currently unavailable|temporarily unavailable|unavailable|backorder|not available)/i;

    const state = inStockSignals.test(normalized) && !outOfStockSignals.test(normalized)
      ? "in_stock"
      : outOfStockSignals.test(normalized)
        ? "out_of_stock"
        : "unknown";

    return {
      state,
      title: clamp(title, 140),
      summary: clamp(stripMarkdownSoft(title), 180),
    };
  } catch (err) {
    return {
      state: "unknown",
      title: "Product page",
      summary: `Could not check page: ${clamp(err.message ?? "unknown error", 120)}`,
    };
  }
}

function ensureSenderWatches(sender) {
  if (!productWatches.has(sender)) productWatches.set(sender, []);
  return productWatches.get(sender);
}

async function handleWatchRequest(senderNumber, messageText, send = sendLinq) {
  const parsed = parseWatchRequest(messageText);
  if (WATCH_REMOVE_RE.test(messageText)) {
    const list = ensureSenderWatches(senderNumber);
    const filtered = list.filter((watch) => watch.name.toLowerCase().includes(String(parsed?.name ?? "").toLowerCase()) || watch.url === parsed?.url);
    const removed = list.length - filtered.length;
    if (removed > 0) {
      productWatches.set(senderNumber, filtered);
      const note = `Stopped tracking ${removed} item${removed === 1 ? "" : "s"}.`;
      await send(senderNumber, [{ type: "text", value: note }]);
      return { mode: "watch_remove", removed };
    }
    await send(senderNumber, [{ type: "text", value: "I wasn't tracking anything matching that request." }]);
    return { mode: "watch_remove", removed: 0 };
  }

  if (!parsed || (!parsed.url && !parsed.name)) {
    await send(senderNumber, [{ type: "text", value: "To track a product, send a product link or name. Example: 'track https://example.com/product' or 'notify me when Noise Cancelling Headphones are back in stock'." }]);
    return { mode: "watch_missing" };
  }

  const list = ensureSenderWatches(senderNumber);
  const existing = list.find((watch) => watch.url === parsed.url || watch.name.toLowerCase() === parsed.name.toLowerCase());

  if (existing) {
    existing.lastKnownState = existing.lastKnownState ?? "unknown";
    await send(senderNumber, [{ type: "text", value: `I’m already tracking "${existing.name}". I’ll text you when its status changes.` }]);
    return { mode: "watch_existing", watch: existing };
  }

  const watch = {
    id: crypto.randomUUID(),
    senderNumber,
    name: parsed.name,
    url: parsed.url || `https://www.google.com/search?q=${encodeURIComponent(parsed.name)}`,
    createdAt: Date.now(),
    lastKnownState: "unknown",
    lastAlertAt: 0,
  };

  list.push(watch);
  productWatches.set(senderNumber, list);

  const status = await checkProductAvailability(watch.url);
  watch.lastKnownState = status.state;

  await send(senderNumber, [{
    type: "text",
    value: `Tracking "${watch.name}". I’ll text you when it comes back in stock or its status changes.\n\nCurrent status: ${status.state === "in_stock" ? "in stock" : status.state === "out_of_stock" ? "out of stock" : "unknown"}`,
  }]);

  return { mode: "watch_create", watch };
}

async function scanProductWatches() {
  if (!productWatches.size) return;
  for (const [senderNumber, watches] of productWatches.entries()) {
    for (const watch of watches) {
      try {
        const status = await checkProductAvailability(watch.url);
        const wasInStock = watch.lastKnownState === "in_stock";
        const isInStock = status.state === "in_stock";

        if (!wasInStock && isInStock && Date.now() - watch.lastAlertAt > 600000) {
          watch.lastKnownState = "in_stock";
          watch.lastAlertAt = Date.now();
          await sendText(senderNumber, `Your tracked item is back in stock:\n\n${watch.name}\n${watch.url}`);
          continue;
        }

        if (status.state !== "unknown") {
          watch.lastKnownState = status.state;
        }
      } catch (err) {
        console.warn(`[watch] failed for ${watch.name}: ${err.message}`);
      }
    }
  }
}

setInterval(() => {
  scanProductWatches();
}, WATCH_CHECK_INTERVAL_MS).unref();

app.get("/debug/watches", (req, res) => {
  if (!DEBUG_TOKEN || req.get("x-debug-token") !== DEBUG_TOKEN) {
    return res.status(404).json({ error: "not found" });
  }
  const entries = [...productWatches.entries()].map(([sender, watches]) => ({ sender, watches }));
  res.json({ ok: true, watchers: entries });
});

app.post("/api/watch", async (req, res) => {
  const sender = String(req.body?.to ?? req.body?.sender ?? req.body?.number ?? "");
  const text = String(req.body?.text ?? req.body?.message ?? "");
  if (!sender || !text) {
    return res.status(400).json({ error: "sender and text are required" });
  }

  const created = await handleWatchRequest(sender, text, async (to, parts) => {
    await sendLinq(to, parts);
    return { ok: true };
  });
  res.json({ ok: true, created });
});
