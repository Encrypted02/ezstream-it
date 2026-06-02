const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the EZStream IT virtual assistant. You help visitors of the EZStream IT website get quick answers about services, pricing, and booking.

EZStream IT is a freelance IT services business run by James. In-person service is available locally (ask the visitor where they're located and tell them to use the contact form to confirm coverage). Remote sessions are available worldwide.

## Services & Pricing (labor only unless noted)

**Gaming PC Build** — $100–$200
- Labor only, parts sourced separately. Includes assembly, OS install, drivers, and benchmark testing.

**Camera Setup** — $75–$150
- Varies by number of cameras. Includes app setup and remote viewing configuration.

**TV Setup** — from $50
- Smart TV configuration, app installs, and streaming account setup.

**Stremio Setup** — from $40
- Full addon install with Real-Debrid pre-configured. Remote or in-person.

**Phone Setup** — $40–$75
- New device setup, data transfer, app config, and backup solutions.

**Laptop Setup** — $50–$100
- Out-of-box config, software installs, security setup, and data migration.

**Virus Removal** — $60–$100
- Full scan, malware removal, browser cleanup, and security hardening.

**Network Setup** — $75–$150
- Router config, WiFi optimization, and mesh network setup.

**Security Audit** — $50–$100
- Password manager setup, 2FA config, and privacy hardening across devices.

**Website Design & Build** — Custom Quote
- Portfolio sites, business pages, and landing pages. Contact for a free quote.

## Bundles (book multiple services for a discount — exact savings given in the quote)
- **Gaming Bundle**: Gaming PC Build + Network Setup + Stremio Setup
- **Smart Home Bundle**: Camera Setup + TV Setup + Network Setup
- **Security Bundle**: Virus Removal + Security Audit & 2FA + Network Hardening

## Booking & Contact
- Book via the Book Now section or the contact form on the website
- Free 15-minute consultation available
- Response time is under 24 hours; text & WhatsApp friendly
- Payment: Cash App, Zelle, Venmo, Cash

## Your Role
- Answer questions about services, pricing, booking, and service area
- Be friendly, helpful, and concise
- All prices are labor only unless noted, and final quotes depend on the specific setup
- If asked something you don't know (like real-time availability or exact bundle savings), tell them to use the Book Now button or contact form
- Keep responses short — 1-3 sentences max unless listing services
- Never make up information not listed above`;

// ── Abuse guards ──────────────────────────────────────────────
// This endpoint is public and spends money on every call, so we gate it.
// Hosts allowed to call the function. Override/extend via ALLOWED_ORIGINS (comma-separated).
const ALLOWED_HOSTS = (process.env.ALLOWED_ORIGINS || "ezstream-it.netlify.app")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
  .concat(["localhost", "127.0.0.1"]);

const MAX_MESSAGES = 20;        // hard cap on history length accepted
const MAX_MSG_CHARS = 2000;     // hard cap on a single message's length
const RATE_LIMIT = 15;          // max requests per IP...
const RATE_WINDOW_MS = 60_000;  // ...per this window

// In-memory sliding window. Persists across warm invocations of the same
// container — not bulletproof, but stops trivial scripted abuse cheaply.
const hits = new Map(); // ip -> number[] (timestamps)

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // crude memory cap
  return recent.length > RATE_LIMIT;
}

function hostOf(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Only allow calls from our own pages (blocks drive-by curl/script abuse).
  const h = event.headers || {};
  const origin = hostOf(h.origin || h.Origin || "");
  const referer = hostOf(h.referer || h.Referer || "");
  const okOrigin = ALLOWED_HOSTS.some((a) => origin === a || referer === a);
  if (!okOrigin) {
    return { statusCode: 403, body: "Forbidden" };
  }

  // Per-IP rate limit.
  const ip =
    h["x-nf-client-connection-ip"] ||
    (h["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown";
  if (rateLimited(ip)) {
    return { statusCode: 429, body: JSON.stringify({ error: "Too many messages — please slow down." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  let { messages } = body;
  if (!messages || !Array.isArray(messages)) {
    return { statusCode: 400, body: "Missing messages" };
  }

  // Validate + bound the input before it ever reaches the API.
  messages = messages.slice(-10); // keep last 10 messages for context
  if (messages.length > MAX_MESSAGES) {
    return { statusCode: 400, body: "Too many messages" };
  }
  for (const m of messages) {
    if (
      !m ||
      (m.role !== "user" && m.role !== "assistant") ||
      typeof m.content !== "string" ||
      m.content.length === 0 ||
      m.content.length > MAX_MSG_CHARS
    ) {
      return { statusCode: 400, body: "Invalid message format" };
    }
  }

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      // Cache the static system prompt — ~90% cheaper input on repeat turns within the 5-min TTL.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: response.content[0].text,
      }),
    };
  } catch (err) {
    console.error("Anthropic error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "AI service error. Please try again." }),
    };
  }
};
