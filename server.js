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
const knowledge = require("./knowledge");
const UPLOAD_DIR = path.join(__dirname, "uploads");

const AI_TIMEOUT_MS = 15000; // if the AI is slower than this, use the keyword answer instead
const ESCALATE_TAG = "[ESCALATE]";
const MAX_BODY = 20000;
const MAX_IMAGE_BODY = 700000; // a screenshot sent as text, about 500 KB of picture
const MAX_MESSAGES = 20;

function systemPrompt() {
  return [
  "You are the first line IT help assistant for staff, in a student project that imitates an NBB internal helpdesk. Say so if asked whether you are the real NBB system.",
  "Write plain text only, no markdown, no asterisks, no bullet symbols. Number steps like 1. 2. 3. on separate lines. Keep answers short, calm and friendly.",
  "Never ask for or accept passwords. If the user shares one, tell them not to.",
  "How to help:",
  "1. If a help article below fits, use it.",
  "2. If no article fits, still try to help. Give 2 or 3 safe general steps for common office problems, such as closing and reopening the app, signing out and back in, checking the internet or VPN, updating the app, or restarting the computer. Then ask them to tell you if it worked.",
  "3. Do not pass the problem on at the first message. Pass it on only when the employee asks for a person, says your steps did not work, reports a security problem (a suspicious email, a lost device, a hacked account), or the fix needs IT to act (new software, new access rights, broken hardware).",
  "4. Greetings and thanks get a normal friendly reply. Never pass those on.",
  "5. If the employee is rude or frustrated, stay polite, do not argue, and offer the next step or the next fix.",
  "6. Reply in the language the employee writes in, English or Arabic.",
  "7. Answer only the latest message. Earlier messages are history, so do not repeat what you said before.",
  "When you do pass it on, reply with one short sentence saying you are creating a ticket for the IT team, and end your reply with " + ESCALATE_TAG + ".",
  "",
  "Help articles:",
  ...knowledge.promptList(),
].join("\n");
}

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

// Every message the bot writes by itself comes in English and Arabic. It picks by the employee's own words.
const TEXT = {
  notFound: ["I could not find a fix for that, so I will create a ticket for the IT team.", "لم أجد حلاً لهذه المشكلة، لذلك سأنشئ تذكرة لفريق تقنية المعلومات."],
  handover: ["Of course, I am forwarding you to the IT team. Please leave your details below, and a team member will reply here or contact you.", "بكل سرور، سأحوّلك إلى فريق تقنية المعلومات. اترك بياناتك في الأسفل وسيرد عليك أحد أفراد الفريق هنا أو يتواصل معك."],
  fixed: ["Great, I am glad it is fixed. Write here any time you need help.", "ممتاز، يسعدني أن المشكلة حُلّت. اكتب هنا في أي وقت تحتاج فيه مساعدة."],
  notFixed: ["Sorry about that. Please leave your details below, and the IT team will help you.", "نعتذر عن ذلك. اترك بياناتك في الأسفل وسيساعدك فريق تقنية المعلومات."],
  image: ["Thanks, your screenshot is saved for the IT team. Please also tell me in words what is wrong, and I will try to help.", "شكراً، تم حفظ لقطة الشاشة لفريق تقنية المعلومات. أخبرني أيضاً بالكلمات ما المشكلة وسأحاول المساعدة."],
};
const pick = (key, hint) => TEXT[key][knowledge.isArabic(hint || "") ? 1 : 0];
const recentText = (conv) => conv.messages.filter((m) => m.role === "user").slice(-3).map((m) => m.content).join(" ");

const URGENT = /\b(urgent|urgently|asap|emergency|critical|immediately|right now)\b|\b(everyone|everybody|whole (team|department|floor|branch)|all of us|nobody|no one)\b.{0,30}\b(can'?t|cannot|unable|down|not working)\b|(عاجل|ضروري|الجميع|الكل)/i;

// When someone asks for a person, we do not leave that to the AI. The server spots it and hands over at once.
const WANTS_HUMAN = new RegExp(
  [
    "\\b(human(?! resources)|real person|live agent|real agent|technician|support staff)\\b",
    "\\b(talk|speak|chat|connect|transfer|forward|pass|escalate|get|give)\\b.{0,30}\\b(person|people|agent|someone|somebody|it team|it support|it guy|staff|colleague|member)\\b",
    "\\b(i|we)\\b.{0,12}\\b(want|need|prefer)\\b.{0,25}\\b(person|agent|human(?! resources)|someone|somebody|it team)\\b",
    "(موظف|بشري|شخص حقيقي|اتكلم مع|أتحدث مع|اكلم|فريق الدعم)",
  ].join("|"),
  "i"
);

// The chat box shows plain text, so remove any markdown the AI adds anyway.
function plain(text) {
  return text.replace(/\*\*|__|`/g, "").replace(/^\s*[*#>]+\s+/gm, "").replace(/[ \t]+\n/g, "\n").trim();
}

async function aiAnswer(messages, system = systemPrompt()) {
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
async function geminiAnswer(messages, system = systemPrompt()) {
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

async function groqAnswer(messages, system = systemPrompt()) {
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
  // Messages from the same side are merged for the AI, but keyword matching only needs the newest line.
  const newest = lastUser.content.split("\n").pop();
  if (!AI_ON) return knowledge.keywordAnswer(newest, pick("notFound", newest));
  try {
    return await callAI(messages, systemPrompt());
  } catch (err) {
    console.error(err.message);
    // If the AI is down, fall back so the employee is never stuck.
    return knowledge.keywordAnswer(newest, pick("notFound", newest));
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

const isBotNotice = (content) => Object.values(TEXT).some((pair) => pair.includes(content));

// Used when the AI is off or fails. Plain and always available.
function fallbackSummary(transcript) {
  const firstUser = transcript.find((m) => m.role === "user");
  const lastBot = [...transcript].reverse().find((m) => m.role === "assistant" && !isBotNotice(m.content));
  return [
    "Problem: " + (firstUser ? firstUser.content.slice(0, 200) : "not stated"),
    "Tried: " + (lastBot ? lastBot.content.slice(0, 250) : "none"),
    "Result: still open, the assistant could not solve it.",
  ].join("\n");
}

async function summarize(transcript) {
  if (!AI_ON || transcript.length === 0) return fallbackSummary(transcript);
  const text = transcript.filter((m) => m.role !== "system").map((m) => (m.role === "user" ? "Employee: " : m.role === "agent" ? "IT team: " : "Assistant: ") + m.content).join("\n");
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

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
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

// ---------- live conversations ----------
// Every chat is stored on the server, so the IT team can read it, take over from the bot and reply.
// Roles: user (employee), assistant (bot), agent (IT team member), system (notes like "joined the chat").

const CONV_FILE = path.join(__dirname, "conversations.json");
const MAX_CONVERSATIONS = 300;
const MAX_CONV_MESSAGES = 100;
const conversations = new Map();

try {
  for (const c of JSON.parse(fs.readFileSync(CONV_FILE, "utf8"))) conversations.set(c.id, c);
} catch {
  // first run, nothing saved yet
}

let saveTimer = null;
function saveConversations() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(CONV_FILE, JSON.stringify([...conversations.values()]), (err) => {
      if (err) console.error("Could not save conversations: " + err.message);
    });
  }, 300);
}

function newConversation() {
  const conv = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode: "bot", // bot or human
    needsHuman: false,
    everEscalated: false, // stays true even after hand back, used for the numbers on the Stats tab
    tookOver: false,
    outcome: "", // "solved" or "not_solved", from the Did that fix it buttons
    priority: "normal", // normal or urgent
    topic: "",
    name: "",
    ticketId: "",
    messages: [],
  };
  conversations.set(conv.id, conv);
  if (conversations.size > MAX_CONVERSATIONS) {
    const oldest = [...conversations.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    conversations.delete(oldest.id);
  }
  return conv;
}

function addMessage(conv, role, content, extra) {
  conv.messages.push({ role, content: String(content).slice(0, 1000), at: Date.now(), ...extra });
  conv.updatedAt = Date.now();
  saveConversations();
}

// What the AI should see: the IT team counts as the assistant side, system notes are left out.
function forAI(conv) {
  // The "I am creating a ticket" lines are left out, otherwise the AI copies them again and again.
  const mapped = [];
  for (const m of conv.messages) {
    if (m.role === "system" || m.esc) continue;
    const role = m.role === "user" ? "user" : "assistant";
    const last = mapped[mapped.length - 1];
    if (last && last.role === role) last.content += "\n" + m.content;
    else mapped.push({ role, content: m.content });
  }
  return cleanMessages(mapped.slice(-MAX_MESSAGES));
}

function publicView(conv, since) {
  return {
    mode: conv.mode,
    needsHuman: conv.needsHuman,
    ticketId: conv.ticketId,
    count: conv.messages.length,
    priority: conv.priority,
    messages: conv.messages.slice(since).map((m, k) => ({ i: since + k, role: m.role, content: m.content, at: m.at, ask: Boolean(m.fb && !m.fbDone), img: m.img || "" })),
  };
}

function flagForPerson(conv) {
  conv.needsHuman = true;
  conv.everEscalated = true;
}

function requireJson(req) {
  return String(req.headers["content-type"] || "").startsWith("application/json");
}

// ---------- numbers for the Stats tab ----------

function buildStats(range) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const from = range === "today" ? startOfDay.getTime() : range === "week" ? Date.now() - 7 * 86400000 : 0;
  const chats = [...conversations.values()].filter((c) => c.createdAt >= from && c.messages.some((m) => m.role === "user"));
  const tickets = readTickets().filter((t) => new Date(t.createdAt).getTime() >= from);

  // Every chat lands in exactly one group: needed a person, solved by the bot, or no answer given yet.
  const needed = chats.filter((c) => c.everEscalated).length;
  const solved = chats.filter((c) => !c.everEscalated && c.outcome === "solved").length;
  const topics = {};
  for (const c of chats) {
    const t = c.topic || "Other";
    topics[t] = (topics[t] || 0) + 1;
  }
  return {
    range,
    chats: chats.length,
    solvedByBot: solved,
    neededPerson: needed,
    noAnswerYet: chats.length - solved - needed,
    solveRate: solved + needed ? Math.round((solved / (solved + needed)) * 100) : null,
    takenOver: chats.filter((c) => c.tookOver).length,
    urgent: chats.filter((c) => c.priority === "urgent").length,
    tickets: { total: tickets.length, open: tickets.filter((t) => t.status !== "solved").length, solved: tickets.filter((t) => t.status === "solved").length },
    topTopics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([topic, count]) => ({ topic, count })),
  };
}

// ---------- routes ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0);

    // employee sends a message
    if (req.method === "POST" && pathname === "/api/chat") {
      if (tooMany(req, "chat", 30, 60 * 1000)) return sendJson(res, 429, { error: "Too many messages, please wait a minute." });
      const body = await readBody(req);
      const text = String(body.text || "").trim().slice(0, 1000);
      if (!text) return sendJson(res, 400, { error: "Write a message first." });
      let conv = conversations.get(String(body.id || ""));
      if (!conv) conv = newConversation();
      if (conv.messages.length >= MAX_CONV_MESSAGES) {
        return sendJson(res, 400, { error: "This chat is full. Please send a ticket to the IT team." });
      }
      addMessage(conv, "user", text);
      if (URGENT.test(text)) conv.priority = "urgent";
      if (!conv.topic && !knowledge.isGreeting(text)) conv.topic = knowledge.topicFor(text);
      // When a person has taken over, the bot stays quiet.
      if (conv.mode === "bot" && WANTS_HUMAN.test(text)) {
        addMessage(conv, "assistant", pick("handover", text), { esc: true });
        flagForPerson(conv);
      } else if (conv.mode === "bot") {
        const result = await answer(forAI(conv));
        // A real fix gets the "Did that fix it?" buttons, a greeting or a hand over does not.
        const asksFeedback = !result.escalate && !knowledge.isGreeting(text);
        addMessage(conv, "assistant", result.reply, result.escalate ? { esc: true } : asksFeedback ? { fb: true } : undefined);
        if (result.escalate) flagForPerson(conv);
      }
      return sendJson(res, 200, { id: conv.id, ...publicView(conv, conv.messages.length) });
    }

    // employee page asks for anything new
    const poll = pathname.match(/^\/api\/chat\/([\w-]+)$/);
    if (req.method === "GET" && poll) {
      if (tooMany(req, "poll", 120, 60 * 1000)) return sendJson(res, 429, { error: "Slow down." });
      const conv = conversations.get(poll[1]);
      if (!conv) return sendJson(res, 404, { error: "Chat not found." });
      return sendJson(res, 200, publicView(conv, since));
    }

    // employee presses Yes or No on "Did that fix it?"
    const feedback = pathname.match(/^\/api\/chat\/([\w-]+)\/feedback$/);
    if (req.method === "POST" && feedback) {
      if (tooMany(req, "poll", 120, 60 * 1000)) return sendJson(res, 429, { error: "Slow down." });
      const conv = conversations.get(feedback[1]);
      if (!conv) return sendJson(res, 404, { error: "Chat not found." });
      const body = await readBody(req);
      const m = conv.messages[Number(body.index)];
      if (!m || m.role !== "assistant" || !m.fb || m.fbDone) return sendJson(res, 400, { error: "That was already answered." });
      const helped = body.helped === true;
      m.fbDone = helped ? "yes" : "no";
      if (helped) {
        conv.outcome = "solved";
        conv.needsHuman = false;
        addMessage(conv, "assistant", pick("fixed", recentText(conv)));
      } else {
        conv.outcome = "not_solved";
        addMessage(conv, "assistant", pick("notFixed", recentText(conv)), { esc: true });
        flagForPerson(conv);
      }
      return sendJson(res, 200, publicView(conv, since));
    }

    // employee attaches a screenshot (the page shrinks it to a small JPEG first)
    const image = pathname.match(/^\/api\/chat\/([\w-]+)\/image$/);
    if (req.method === "POST" && image) {
      if (tooMany(req, "image", 8, 10 * 60 * 1000)) return sendJson(res, 429, { error: "Too many screenshots, please wait." });
      const conv = conversations.get(image[1]);
      if (!conv) return sendJson(res, 404, { error: "Chat not found." });
      const body = await readBody(req, MAX_IMAGE_BODY);
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ""));
      if (!match) return sendJson(res, 400, { error: "Only JPEG screenshots can be sent." });
      const bytes = Buffer.from(match[1], "base64");
      const isJpeg = bytes.length > 100 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!isJpeg || bytes.length > 500000) return sendJson(res, 400, { error: "That picture is not valid or is too big." });
      if (conv.messages.filter((m) => m.img).length >= 5) return sendJson(res, 400, { error: "Up to 5 screenshots per chat." });
      if (conv.messages.length >= MAX_CONV_MESSAGES - 1) return sendJson(res, 400, { error: "This chat is full. Please send a ticket to the IT team." });
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const name = crypto.randomUUID() + ".jpg";
      fs.writeFileSync(path.join(UPLOAD_DIR, name), bytes);
      addMessage(conv, "user", "Screenshot", { img: "/uploads/" + name });
      if (conv.mode === "bot") addMessage(conv, "assistant", pick("image", recentText(conv)));
      return sendJson(res, 200, publicView(conv, since));
    }

    // pictures are served by their long random name, nobody can guess one
    const upload = pathname.match(/^\/uploads\/([0-9a-f-]{36}\.jpg)$/);
    if (req.method === "GET" && upload) {
      return fs.readFile(path.join(UPLOAD_DIR, upload[1]), (err, data) => {
        if (err) return res.writeHead(404).end("Not found");
        res.writeHead(200, { "content-type": "image/jpeg", "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" });
        res.end(data);
      });
    }

    // employee checks a ticket, with the ticket number and the contact they gave
    if (req.method === "POST" && pathname === "/api/ticket-status") {
      if (tooMany(req, "status", 10, 60 * 1000)) return sendJson(res, 429, { error: "Too many tries, please wait a minute." });
      const body = await readBody(req);
      const id = String(body.id || "").trim().toLowerCase();
      const contact = String(body.contact || "").trim().toLowerCase();
      const ticket = readTickets().find((t) => t.id.toLowerCase() === id && t.contact.trim().toLowerCase() === contact);
      // The same answer for a wrong number and a wrong contact, so nobody can look up other people's tickets.
      if (!ticket) return sendJson(res, 404, { error: "No ticket found with those details." });
      return sendJson(res, 200, { id: ticket.id, status: ticket.status || "open", createdAt: ticket.createdAt, solvedAt: ticket.solvedAt || "" });
    }

    // employee sends the ticket form
    if (req.method === "POST" && pathname === "/api/ticket") {
      if (tooMany(req, "ticket", 5, 60 * 60 * 1000)) return sendJson(res, 429, { error: "Too many tickets, please try later." });
      const body = await readBody(req);
      const conv = conversations.get(String(body.id || ""));
      if (!conv) return sendJson(res, 400, { error: "Start a chat first." });
      if (conv.ticketId) return sendJson(res, 200, { id: conv.ticketId });
      const name = String(body.name || "").trim().slice(0, 80);
      const contact = String(body.contact || "").trim().slice(0, 120);
      const place = String(body.place || "").trim().slice(0, 120);
      if (!name || !contact) return sendJson(res, 400, { error: "Name and contact are required." });
      const transcript = conv.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
      const tickets = readTickets();
      const ticket = {
        id: "T" + String(tickets.length + 1).padStart(4, "0"),
        createdAt: new Date().toISOString(),
        status: "open",
        name,
        contact,
        place,
        priority: conv.priority,
        conversationId: conv.id,
        summary: await summarize(transcript),
        transcript,
      };
      tickets.push(ticket);
      saveTickets(tickets);
      conv.ticketId = ticket.id;
      conv.name = name;
      flagForPerson(conv);
      conv.updatedAt = Date.now();
      saveConversations();
      return sendJson(res, 201, { id: ticket.id });
    }

    // everything below is for the IT team only
    if (pathname.startsWith("/api/tickets") || pathname.startsWith("/api/conversations") || pathname === "/api/stats" || pathname === "/api/knowledge" || pathname === "/agent.html") {
      if (!isAdmin(req)) return askForPassword(res);
    }

    if (req.method === "GET" && pathname === "/api/tickets") {
      return sendJson(res, 200, readTickets().reverse());
    }

    // mark a ticket solved or open again
    const ticketStatus = pathname.match(/^\/api\/tickets\/(T\d+)\/status$/);
    if (req.method === "POST" && ticketStatus) {
      if (!requireJson(req)) return sendJson(res, 415, { error: "Send JSON." });
      const body = await readBody(req);
      if (body.status !== "open" && body.status !== "solved") return sendJson(res, 400, { error: "Status must be open or solved." });
      const tickets = readTickets();
      const ticket = tickets.find((t) => t.id === ticketStatus[1]);
      if (!ticket) return sendJson(res, 404, { error: "Ticket not found." });
      ticket.status = body.status;
      ticket.solvedAt = body.status === "solved" ? new Date().toISOString() : "";
      saveTickets(tickets);
      const conv = conversations.get(ticket.conversationId);
      if (conv) addMessage(conv, "system", body.status === "solved" ? "Your ticket " + ticket.id + " was marked solved by the IT team." : "Your ticket " + ticket.id + " was opened again.");
      return sendJson(res, 200, ticket);
    }

    if (req.method === "GET" && pathname === "/api/stats") {
      const range = ["today", "week", "all"].includes(url.searchParams.get("range")) ? url.searchParams.get("range") : "all";
      return sendJson(res, 200, buildStats(range));
    }

    // the help articles, edited from the IT team page
    if (pathname === "/api/knowledge") {
      if (req.method === "GET") return sendJson(res, 200, knowledge.get());
      if (req.method === "POST") {
        if (!requireJson(req)) return sendJson(res, 415, { error: "Send JSON." });
        const body = await readBody(req, 200000);
        try {
          return sendJson(res, 200, knowledge.set(body.articles));
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }

    // chats waiting for a person come first, urgent ones before the rest
    const weight = (c) => (c.needsHuman && c.mode !== "human" ? 2 : 0) + (c.priority === "urgent" ? 1 : 0);

    if (req.method === "GET" && pathname === "/api/conversations") {
      const list = [...conversations.values()]
        .sort((a, b) => weight(b) - weight(a) || b.updatedAt - a.updatedAt)
        .map((c) => {
          const last = [...c.messages].reverse().find((m) => m.role !== "system");
          return {
            id: c.id,
            name: c.name,
            ticketId: c.ticketId,
            mode: c.mode,
            needsHuman: c.needsHuman,
            priority: c.priority,
            outcome: c.outcome,
            updatedAt: c.updatedAt,
            count: c.messages.length,
            preview: last ? last.content.slice(0, 80) : "",
          };
        });
      return sendJson(res, 200, list);
    }

    const one = pathname.match(/^\/api\/conversations\/([\w-]+)(?:\/(takeover|reply|handback|priority))?$/);
    if (one) {
      const conv = conversations.get(one[1]);
      if (!conv) return sendJson(res, 404, { error: "Chat not found." });
      const action = one[2];

      if (req.method === "GET" && !action) return sendJson(res, 200, { id: conv.id, name: conv.name, ticketId: conv.ticketId, ...publicView(conv, since) });

      // These change things, so they must be sent as JSON. A page on another site cannot do that with our password.
      if (req.method === "POST" && action) {
        if (!requireJson(req)) return sendJson(res, 415, { error: "Send JSON." });
        if (action === "takeover") {
          if (conv.mode !== "human") {
            conv.mode = "human";
            conv.tookOver = true;
            addMessage(conv, "system", "An IT team member has joined the chat.");
          }
          return sendJson(res, 200, publicView(conv, since));
        }
        if (action === "priority") {
          const body = await readBody(req);
          conv.priority = body.urgent === true ? "urgent" : "normal";
          saveConversations();
          return sendJson(res, 200, publicView(conv, since));
        }
        if (action === "handback") {
          if (conv.mode !== "bot") {
            conv.mode = "bot";
            conv.needsHuman = false;
            addMessage(conv, "system", "You are back with the assistant.");
          }
          return sendJson(res, 200, publicView(conv, since));
        }
        if (action === "reply") {
          const body = await readBody(req);
          const text = String(body.text || "").trim();
          if (!text) return sendJson(res, 400, { error: "Write a reply first." });
          if (conv.mode !== "human") return sendJson(res, 409, { error: "Take over the chat first." });
          if (conv.messages.length >= MAX_CONV_MESSAGES) return sendJson(res, 400, { error: "This chat is full." });
          addMessage(conv, "agent", text);
          conv.needsHuman = false;
          return sendJson(res, 200, publicView(conv, since));
        }
      }
    }

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
