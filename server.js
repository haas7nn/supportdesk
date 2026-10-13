// SupportDesk server. No dependencies, only Node built ins.
// Flow: an employee chats with the AI first, and if the AI cannot solve it, a ticket is created for the IT team.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.MODEL || "claude-haiku-5-5";
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PUBLIC_DIR = path.join(__dirname, "public");
const TICKETS_FILE = path.join(__dirname, "tickets.json");
const KNOWLEDGE = JSON.parse(fs.readFileSync(path.join(__dirname, "knowledge.json"), "utf8"));

const AI_TIMEOUT_MS = 15000; // if the AI is slower than this, use the keyword answer instead
const NOT_FOUND_TEXT = "I could not find a fix for that, so I will create a ticket for the IT team.";
const ESCALATE_TAG = "[ESCALATE]";
const MAX_BODY = 20000;
const MAX_MESSAGES = 20;

const SYSTEM_PROMPT = [
  "You are the first line IT help assistant for staff, in a student project that imitates an NBB internal helpdesk. Say so if asked whether you are the real NBB system.",
  "Answer only using the help articles below. Give simple steps a non technical person can follow, and keep answers short and friendly. Write plain text only, no markdown, no asterisks, no bullet symbols, and number steps like 1. 2. 3. on separate lines.",
  "Never ask for or accept passwords. If the user shares one, tell them not to.",
  "If the problem is not in the articles, the steps did not work, the user says it is urgent, or the user asks for a person, reply with one short sentence saying you are creating a ticket for the IT team, and end your reply with " + ESCALATE_TAG + ".",
  "",
  "Help articles:",
  ...KNOWLEDGE.map((k) => "- " + k.topic + ": " + k.answer),
].join("\n");

// ---------- tickets (a JSON file keeps it simple and easy to explain) ----------

function readTickets() {
  try {
    return JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveTickets(list) {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(list, null, 2));
}

// ---------- the answer engine ----------

// The chat box shows plain text, so remove any markdown the AI adds anyway.
function plain(text) {
  return text.replace(/\*\*|__|`/g, "").replace(/^\s*[*#>]+\s+/gm, "").replace(/[ \t]+\n/g, "\n").trim();
}

// Used when there is no API key, so the demo still works. Picks the article with the most keyword hits.
function keywordAnswer(text) {
  const words = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const item of KNOWLEDGE) {
    const score = item.keywords.filter((k) => words.includes(k)).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  if (!best) {
    return { reply: NOT_FOUND_TEXT, escalate: true };
  }
  return { reply: best.answer, escalate: false };
}

async function aiAnswer(messages, system = SYSTEM_PROMPT) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system, messages }),
  });
  if (!res.ok) throw new Error("AI request failed with status " + res.status);
  const data = await res.json();
  const raw = (data.content || []).map((c) => c.text || "").join("").trim();
  const escalate = raw.includes(ESCALATE_TAG);
  return { reply: plain(raw.replace(ESCALATE_TAG, "")), escalate };
}

// Google Gemini. It calls the assistant "model" instead of "assistant".
async function geminiAnswer(messages, system = SYSTEM_PROMPT) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent";
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 400 },
    }),
  });
  if (!res.ok) throw new Error("Gemini request failed with status " + res.status);
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const raw = parts.map((p) => p.text || "").join("").trim();
  if (!raw) throw new Error("Gemini returned an empty answer");
  return { reply: plain(raw.replace(ESCALATE_TAG, "")), escalate: raw.includes(ESCALATE_TAG) };
}

// Groq uses the common chat format, where the instructions go in as a "system" message.
// A 404 means the model name is wrong, so print the names this key can use.
async function listGroqModels() {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      headers: { authorization: "Bearer " + GROQ_KEY },
    });
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id).filter((id) => !/whisper|guard|tts|orpheus/i.test(id));
    console.error("Model " + GROQ_MODEL + " was not found. Chat models available to you:\n  " + ids.join("\n  "));
    console.error("Run again with GROQ_MODEL=<one of these> in front of node server.js");
  } catch (err) {
    console.error("Could not list models: " + err.message);
  }
}

async function groqAnswer(messages, system = SYSTEM_PROMPT) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: { "content-type": "application/json", authorization: "Bearer " + GROQ_KEY },
    body: JSON.stringify({
      model: GROQ_MODEL,
      // The gpt-oss models think first, and the thinking counts toward the limit, so allow more room.
      max_tokens: 1500,
      ...(GROQ_MODEL.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!res.ok) {
    if (res.status === 404) await listGroqModels();
    throw new Error("Groq request failed with status " + res.status);
  }
  const data = await res.json();
  const raw = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
  if (!raw) throw new Error("Groq returned an empty answer");
  return { reply: plain(raw.replace(ESCALATE_TAG, "")), escalate: raw.includes(ESCALATE_TAG) };
}

const AI_ON = Boolean(GEMINI_KEY || GROQ_KEY || API_KEY);

function callAI(messages, system) {
  if (GEMINI_KEY) return geminiAnswer(messages, system);
  if (GROQ_KEY) return groqAnswer(messages, system);
  return aiAnswer(messages, system);
}

async function answer(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!AI_ON) return keywordAnswer(lastUser.content);
  try {
    return await callAI(messages, SYSTEM_PROMPT);
  } catch (err) {
    console.error(err.message);
    // If the AI is down, fall back so the employee is never stuck.
    return keywordAnswer(lastUser.content);
  }
}

// ---------- ticket summary ----------

const SUMMARY_PROMPT = [
  "You write a short handoff note for an IT support team, from a chat between an employee and a help assistant.",
  "Use exactly these three lines and nothing else:",
  "Problem: what is wrong, in one sentence.",
  "Tried: the fixes the assistant suggested, in one sentence. If none, say none.",
  "Result: what the employee said happened, or that the problem is still open.",
  "Plain text only, under 70 words, never include passwords.",
].join("\n");

// Used when the AI is off or fails. Plain and always available.
function fallbackSummary(transcript) {
  const firstUser = transcript.find((m) => m.role === "user");
  const lastBot = [...transcript].reverse().find((m) => m.role === "assistant" && m.content !== NOT_FOUND_TEXT);
  return [
    "Problem: " + (firstUser ? firstUser.content.slice(0, 200) : "not stated"),
    "Tried: " + (lastBot ? lastBot.content.slice(0, 250) : "none"),
    "Result: still open, the assistant could not solve it.",
  ].join("\n");
}

async function summarize(transcript) {
  if (!AI_ON || transcript.length === 0) return fallbackSummary(transcript);
  const text = transcript.map((m) => (m.role === "user" ? "Employee: " : "Assistant: ") + m.content).join("\n");
  try {
    const out = await callAI([{ role: "user", content: text }], SUMMARY_PROMPT);
    return out.reply.slice(0, 600) || fallbackSummary(transcript);
  } catch (err) {
    console.error("Summary failed, using the plain one: " + err.message);
    return fallbackSummary(transcript);
  }
}

// ---------- helpers ----------

function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out = input
    .slice(-MAX_MESSAGES)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
  // The API needs the first message to be from the user and the last one too.
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad json"));
      }
    });
  });
}

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  const urlPath = req.url.split("?")[0];
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // Block anything that tries to climb out of the public folder.
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- protection ----------

// The IT team page and the ticket list ask for a password (HTTP Basic, the browser shows its own box).
// With no ADMIN_PASSWORD set, they only open from the same computer, which keeps local testing easy.
function isAdmin(req) {
  if (!ADMIN_PASSWORD) {
    const a = req.socket.remoteAddress || "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6), "base64").toString("utf8");
  const password = given.slice(given.indexOf(":") + 1);
  const a = crypto.createHash("sha256").update(password).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function askForPassword(res) {
  res.writeHead(401, { "www-authenticate": 'Basic realm="IT team"', "content-type": "text/plain" });
  res.end("Password needed.");
}

// Simple limit per visitor, kept in memory. Stops one person using up the free AI quota.
const hits = new Map();
function tooMany(req, bucket, max, windowMs) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const key = bucket + ":" + (forwarded || req.socket.remoteAddress);
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

// ---------- routes ----------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") {
      if (tooMany(req, "chat", 20, 60 * 1000)) return sendJson(res, 429, { error: "Too many messages, please wait a minute." });
      const body = await readBody(req);
      const messages = cleanMessages(body.messages);
      if (!messages) return sendJson(res, 400, { error: "Send at least one user message." });
      return sendJson(res, 200, await answer(messages));
    }

    if (req.method === "POST" && req.url === "/api/ticket") {
      if (tooMany(req, "ticket", 5, 60 * 60 * 1000)) return sendJson(res, 429, { error: "Too many tickets, please try later." });
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const contact = String(body.contact || "").trim().slice(0, 120);
      const place = String(body.place || "").trim().slice(0, 120);
      if (!name || !contact) return sendJson(res, 400, { error: "Name and contact are required." });
      const transcript = (Array.isArray(body.transcript) ? body.transcript : [])
        .slice(-MAX_MESSAGES)
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 1000) }));
      const tickets = readTickets();
      const ticket = {
        id: "T" + String(tickets.length + 1).padStart(4, "0"),
        createdAt: new Date().toISOString(),
        status: "open",
        name,
        contact,
        place,
        summary: await summarize(transcript),
        transcript,
      };
      tickets.push(ticket);
      saveTickets(tickets);
      return sendJson(res, 201, { id: ticket.id });
    }

    if (req.method === "GET" && req.url === "/api/tickets") {
      if (!isAdmin(req)) return askForPassword(res);
      return sendJson(res, 200, readTickets().reverse());
    }

    if (req.method === "GET" && req.url.split("?")[0] === "/agent.html" && !isAdmin(req)) return askForPassword(res);
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405).end("Method not allowed");
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log("SupportDesk running at http://localhost:" + PORT);
  console.log(ADMIN_PASSWORD ? "IT team page needs the admin password" : "No ADMIN_PASSWORD set, IT team page only opens on this computer");
  if (GEMINI_KEY) console.log("AI mode on, Gemini model " + GEMINI_MODEL);
  else if (GROQ_KEY) console.log("AI mode on, Groq model " + GROQ_MODEL);
  else if (API_KEY) console.log("AI mode on, Claude model " + MODEL);
  else console.log("No API key set, using the built in keyword answers");
});
