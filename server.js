
// main server file

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createStore } = require("./store");
const auth = require("./auth");
const alerts = require("./alerts");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PUBLIC_DIR = path.join(__dirname, "public");
const knowledge = require("./knowledge");

// if the ai takes longer than this we use the keyword answers instead

const AI_TIMEOUT_MS = 15000;
const ESCALATE_TAG = "[ESCALATE]";
const MAX_BODY = 20000;
const MAX_IMAGE_BODY = 700000;
const MAX_MESSAGES = 20;

// what we tell the ai before every chat
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

// everything is kept in memory and saved in the background by the store file
let store = null;
let conversations = null;
const readTickets = () => store.tickets;
const saveTickets = () => Promise.resolve(store.saveTickets()).catch((err) => console.error("Could not save tickets: " + err.message));
const saveUsers = () => Promise.resolve(store.saveUsers()).catch((err) => console.error("Could not save team: " + err.message));

// every message the bot writes itself in english first then arabic
const TEXT = {
  notFound: ["I could not find a fix for that, so I will create a ticket for the IT team.", "لم أجد حلاً لهذه المشكلة، لذلك سأنشئ تذكرة لفريق تقنية المعلومات."],
  handover: ["Of course, I am forwarding you to the IT team. Please leave your details below, and a team member will reply here or contact you.", "بكل سرور، سأحوّلك إلى فريق تقنية المعلومات. اترك بياناتك في الأسفل وسيرد عليك أحد أفراد الفريق هنا أو يتواصل معك."],
  fixed: ["Great, I am glad it is fixed. Write here any time you need help.", "ممتاز، يسعدني أن المشكلة حُلّت. اكتب هنا في أي وقت تحتاج فيه مساعدة."],
  notFixed: ["Sorry about that. Please leave your details below, and the IT team will help you.", "نعتذر عن ذلك. اترك بياناتك في الأسفل وسيساعدك فريق تقنية المعلومات."],
  image: ["Thanks, your screenshot is saved for the IT team. Please also tell me in words what is wrong, and I will try to help.", "شكراً، تم حفظ لقطة الشاشة لفريق تقنية المعلومات. أخبرني أيضاً بالكلمات ما المشكلة وسأحاول المساعدة."],
};
const pick = (key, hint) => TEXT[key][knowledge.isArabic(hint || "") ? 1 : 0];
const recentText = (conv) => conv.messages.filter((m) => m.role === "user").slice(-3).map((m) => m.content).join(" ");

// words that make a chat urgent
const URGENT = /\b(urgent|urgently|asap|emergency|critical|immediately|right now)\b|\b(everyone|everybody|whole (team|department|floor|branch)|all of us|nobody|no one)\b.{0,30}\b(can'?t|cannot|unable|down|not working)\b|(عاجل|ضروري|الجميع|الكل)/i;

// words people use when they want a real person
const WANTS_HUMAN = new RegExp(
  [
    "\\b(human(?! resources)|real person|live agent|real agent|technician|support staff)\\b",
    "\\b(talk|speak|chat|connect|transfer|forward|pass|escalate|get|give)\\b.{0,30}\\b(person|people|agent|someone|somebody|it team|it support|it guy|staff|colleague|member)\\b",
    "\\b(i|we)\\b.{0,12}\\b(want|need|prefer)\\b.{0,25}\\b(person|agent|human(?! resources)|someone|somebody|it team)\\b",
    "(موظف|بشري|شخص حقيقي|اتكلم مع|أتحدث مع|اكلم|فريق الدعم)",
  ].join("|"),
  "i"
);

// the chat box cant show markdown so take it out
function plain(text) {
  return text.replace(/\*\*|__|`/g, "").replace(/^\s*[*#>]+\s+/gm, "").replace(/[ \t]+\n/g, "\n").trim();
}

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

const AI_ON = Boolean(GEMINI_KEY || GROQ_KEY);

function callAI(messages, system) {
  if (GEMINI_KEY) return geminiAnswer(messages, system);
  if (GROQ_KEY) return groqAnswer(messages, system);
  throw new Error("No AI key is set");
}

async function answer(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const newest = lastUser.content.split("\n").pop();
  if (!AI_ON) return knowledge.keywordAnswer(newest, pick("notFound", newest));
  try {
    return await callAI(messages, systemPrompt());
  } catch (err) {
    console.error(err.message);
    return knowledge.keywordAnswer(newest, pick("notFound", newest));
  }
}

const SUMMARY_PROMPT = [
  "You write a short handoff note for an IT support team, from a chat between an employee and a help assistant.",
  "Use exactly these three lines and nothing else:",
  "Problem: what is wrong, in one sentence.",
  "Tried: the fixes the assistant suggested, in one sentence. If none, say none.",
  "Result: what the employee said happened, or that the problem is still open.",
  "Plain text only, under 70 words, never include passwords.",
].join("\n");

const isBotNotice = (content) => Object.values(TEXT).some((pair) => pair.includes(content));

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

function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out = input
    .slice(-MAX_MESSAGES)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
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

const LOCAL_USER = { username: "local", name: "Local", role: "owner" };

// with no ADMIN_PASSWORD set the pages only open on this computer
function currentUser(req) {
  if (!ADMIN_PASSWORD) {
    const a = req.socket.remoteAddress || "";
    if (a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1") return LOCAL_USER;
  }
  const session = auth.readSession(req);
  if (!session) return null;
  const user = store.users.find((u) => u.username === session.u);
  return user && user.hash.slice(0, 8) === session.pv ? user : null;
}

const isHttps = (req) => req.headers["x-forwarded-proto"] === "https" || Boolean(req.socket.encrypted);
const safeUser = (u) => ({ username: u.username, name: u.name, role: u.role });

// the admin account always follows the ADMIN_PASSWORD setting
async function ensureOwner() {
  if (!ADMIN_PASSWORD) return;
  let owner = store.users.find((u) => u.username === "admin");
  if (owner && auth.checkPassword(ADMIN_PASSWORD, owner)) return;
  const { salt, hash } = auth.hashPassword(ADMIN_PASSWORD);
  if (owner) Object.assign(owner, { salt, hash, role: "owner" });
  else store.users.push({ username: "admin", name: "Admin", role: "owner", salt, hash, createdAt: Date.now() });
  await saveUsers();
}

// stops one person using up the free ai quota
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

const MAX_CONVERSATIONS = 300;
const MAX_CONV_MESSAGES = 100;

function newConversation() {
  const conv = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode: "bot",
    needsHuman: false,
    everEscalated: false,
    tookOver: false,
    takenBy: "",
    takenByUser: "",
    outcome: "",
    priority: "normal",
    topic: "",
    name: "",
    ticketId: "",
    messages: [],
  };
  conversations.set(conv.id, conv);
  store.touch(conv);
  if (conversations.size > MAX_CONVERSATIONS) {
    const oldest = [...conversations.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    store.removeConversation(oldest.id);
  }
  return conv;
}

function addMessage(conv, role, content, extra) {
  conv.messages.push({ role, content: String(content).slice(0, 1000), at: Date.now(), ...extra });
  conv.updatedAt = Date.now();
  store.touch(conv);
}

// leave out the ticket lines or the bot starts copying them
function forAI(conv) {
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
    takenBy: conv.takenBy,
    messages: conv.messages.slice(since).map((m, k) => ({ i: since + k, role: m.role, content: m.content, by: m.by || "", at: m.at, ask: Boolean(m.fb && !m.fbDone), img: m.img || "" })),
  };
}

function flagForPerson(conv) {
  const wasWaiting = conv.needsHuman;
  conv.needsHuman = true;
  conv.everEscalated = true;
  if (!wasWaiting) alerts.chatNeedsPerson(conv);
}

function requireJson(req) {
  return String(req.headers["content-type"] || "").startsWith("application/json");
}

// the numbers for the stats tab
function buildStats(range) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const from = range === "today" ? startOfDay.getTime() : range === "week" ? Date.now() - 7 * 86400000 : 0;
  const chats = [...conversations.values()].filter((c) => c.createdAt >= from && c.messages.some((m) => m.role === "user"));
  const tickets = readTickets().filter((t) => new Date(t.createdAt).getTime() >= from);

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0);

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
      if (URGENT.test(text) && conv.priority !== "urgent") {
        conv.priority = "urgent";
        alerts.chatBecameUrgent(conv);
      }
      if (!conv.topic && !knowledge.isGreeting(text)) conv.topic = knowledge.topicFor(text);
      if (conv.mode === "bot" && WANTS_HUMAN.test(text)) {
        addMessage(conv, "assistant", pick("handover", text), { esc: true });
        flagForPerson(conv);
      } else if (conv.mode === "bot") {
        const result = await answer(forAI(conv));
        const asksFeedback = !result.escalate && !knowledge.isGreeting(text);
        addMessage(conv, "assistant", result.reply, result.escalate ? { esc: true } : asksFeedback ? { fb: true } : undefined);
        if (result.escalate) flagForPerson(conv);
      }
      return sendJson(res, 200, { id: conv.id, ...publicView(conv, conv.messages.length) });
    }

    const poll = pathname.match(/^\/api\/chat\/([\w-]+)$/);
    if (req.method === "GET" && poll) {
      if (tooMany(req, "poll", 120, 60 * 1000)) return sendJson(res, 429, { error: "Slow down." });
      const conv = conversations.get(poll[1]);
      if (!conv) return sendJson(res, 404, { error: "Chat not found." });
      return sendJson(res, 200, publicView(conv, since));
    }

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
      const name = crypto.randomUUID() + ".jpg";
      await store.putImage(name, bytes);
      addMessage(conv, "user", "Screenshot", { img: "/uploads/" + name });
      if (conv.mode === "bot") addMessage(conv, "assistant", pick("image", recentText(conv)));
      return sendJson(res, 200, publicView(conv, since));
    }

    const upload = pathname.match(/^\/uploads\/([0-9a-f-]{36}\.jpg)$/);
    if (req.method === "GET" && upload) {
      const data = await store.getImage(upload[1]);
      if (!data) return res.writeHead(404).end("Not found");
      res.writeHead(200, { "content-type": "image/jpeg", "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" });
      return res.end(data);
    }

    if (req.method === "POST" && pathname === "/api/ticket-status") {
      if (tooMany(req, "status", 10, 60 * 1000)) return sendJson(res, 429, { error: "Too many tries, please wait a minute." });
      const body = await readBody(req);
      const id = String(body.id || "").trim().toLowerCase();
      const contact = String(body.contact || "").trim().toLowerCase();
      const ticket = readTickets().find((t) => t.id.toLowerCase() === id && t.contact.trim().toLowerCase() === contact);
      if (!ticket) return sendJson(res, 404, { error: "No ticket found with those details." });
      return sendJson(res, 200, { id: ticket.id, status: ticket.status || "open", createdAt: ticket.createdAt, solvedAt: ticket.solvedAt || "" });
    }

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
      await saveTickets();
      alerts.newTicket(ticket);
      conv.ticketId = ticket.id;
      conv.name = name;
      flagForPerson(conv);
      conv.updatedAt = Date.now();
      store.touch(conv);
      return sendJson(res, 201, { id: ticket.id });
    }

    if (req.method === "POST" && pathname === "/api/login") {
      if (tooMany(req, "login", 10, 10 * 60 * 1000)) return sendJson(res, 429, { error: "Too many tries. Please wait a few minutes." });
      if (!requireJson(req)) return sendJson(res, 415, { error: "Send JSON." });
      const body = await readBody(req);
      const username = String(body.username || "").trim().toLowerCase();
      const user = store.users.find((u) => u.username === username);
      const ok = auth.checkPassword(String(body.password || "").slice(0, 200), user);
      if (!ok) return sendJson(res, 401, { error: "Wrong username or password." });
      res.setHeader("set-cookie", auth.makeCookie(user, isHttps(req)));
      return sendJson(res, 200, safeUser(user));
    }
    if (req.method === "POST" && pathname === "/api/logout") {
      res.setHeader("set-cookie", auth.clearCookie(isHttps(req)));
      return sendJson(res, 200, { ok: true });
    }

    const user = currentUser(req);
    const teamPage = pathname === "/agent.html" || pathname === "/articles.html";
    const teamApi = /^\/api\/(tickets|conversations|stats|knowledge|team|me|config|alerts)(\/|$)/.test(pathname);
    if (teamPage && !user) {
      res.writeHead(302, { location: "/login.html" });
      return res.end();
    }
    if (teamApi && !user) return sendJson(res, 401, { error: "Please sign in." });

    if (req.method === "GET" && pathname === "/api/me") return sendJson(res, 200, safeUser(user));

    if (req.method === "GET" && pathname === "/api/config") {
      return sendJson(res, 200, { storage: store.mode, emailAlerts: alerts.enabled, user: safeUser(user) });
    }

    const strongEnough = (p) => typeof p === "string" && p.length >= 8 && p.length <= 100;
    if (req.method === "GET" && pathname === "/api/team") {
      return sendJson(res, 200, store.users.map((u) => ({ ...safeUser(u), createdAt: u.createdAt })));
    }
    if (req.method === "POST" && /^\/api\/(team|me\/password|alerts\/test)/.test(pathname)) {
      if (!requireJson(req)) return sendJson(res, 415, { error: "Send JSON." });
      const body = await readBody(req);

      if (pathname === "/api/me/password") {
        const mine = store.users.find((u) => u.username === user.username);
        if (!mine) return sendJson(res, 400, { error: "This local session has no password." });
        if (!auth.checkPassword(String(body.current || ""), mine)) return sendJson(res, 400, { error: "Your current password is not right." });
        if (!strongEnough(body.next)) return sendJson(res, 400, { error: "Use a new password of at least 8 characters." });
        Object.assign(mine, auth.hashPassword(body.next));
        await saveUsers();
        res.setHeader("set-cookie", auth.makeCookie(mine, isHttps(req)));
        return sendJson(res, 200, { ok: true, note: mine.username === "admin" ? "The server setting ADMIN_PASSWORD will set this account back at the next restart." : "" });
      }

      if (user.role !== "owner") return sendJson(res, 403, { error: "Only the owner can do this." });

      if (pathname === "/api/alerts/test") {
        try {
          await alerts.test();
          return sendJson(res, 200, { sent: true });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === "/api/team") {
        const username = String(body.username || "").trim().toLowerCase();
        const name = String(body.name || "").trim().slice(0, 40);
        if (!/^[a-z0-9._-]{3,20}$/.test(username)) return sendJson(res, 400, { error: "Username: 3 to 20 letters, numbers, dots or dashes." });
        if (!name) return sendJson(res, 400, { error: "Add a display name." });
        if (!strongEnough(body.password)) return sendJson(res, 400, { error: "Use a password of at least 8 characters." });
        if (store.users.some((u) => u.username === username)) return sendJson(res, 400, { error: "That username is taken." });
        store.users.push({ username, name, role: "member", ...auth.hashPassword(body.password), createdAt: Date.now() });
        await saveUsers();
        return sendJson(res, 201, { ok: true });
      }

      const target = pathname.match(/^\/api\/team\/([a-z0-9._-]+)\/(delete|password)$/);
      if (target) {
        const member = store.users.find((u) => u.username === target[1]);
        if (!member) return sendJson(res, 404, { error: "No such member." });
        if (target[2] === "delete") {
          if (member.role === "owner") return sendJson(res, 400, { error: "The owner cannot be removed." });
          store.users.splice(store.users.indexOf(member), 1);
          await saveUsers();
          return sendJson(res, 200, { ok: true });
        }
        if (!strongEnough(body.password)) return sendJson(res, 400, { error: "Use a password of at least 8 characters." });
        Object.assign(member, auth.hashPassword(body.password));
        await saveUsers();
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === "POST" && pathname === "/api/knowledge/test") {
      if (!requireJson(req)) return sendJson(res, 415, { error: "Send JSON." });
      const body = await readBody(req);
      const text = String(body.text || "").slice(0, 300);
      const result = knowledge.keywordAnswer(text, "");
      return sendJson(res, 200, { topic: result.escalate ? "" : knowledge.topicFor(text), reply: result.escalate ? "" : result.reply });
    }

    if (req.method === "GET" && pathname === "/api/tickets") {
      return sendJson(res, 200, [...readTickets()].reverse());
    }

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
      await saveTickets();
      const conv = conversations.get(ticket.conversationId);
      if (conv) addMessage(conv, "system", body.status === "solved" ? "Your ticket " + ticket.id + " was marked solved by the IT team." : "Your ticket " + ticket.id + " was opened again.");
      return sendJson(res, 200, ticket);
    }

    if (req.method === "GET" && pathname === "/api/stats") {
      const range = ["today", "week", "all"].includes(url.searchParams.get("range")) ? url.searchParams.get("range") : "all";
      return sendJson(res, 200, buildStats(range));
    }

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
            takenBy: c.takenBy,
            takenByUser: c.takenByUser,
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

      if (req.method === "POST" && action) {
        if (!requireJson(req)) return sendJson(res, 415, { error: "Send JSON." });
        if (action === "takeover") {
          if (conv.mode !== "human" || conv.takenByUser !== user.username) {
            conv.mode = "human";
            conv.tookOver = true;
            conv.takenBy = user.name;
            conv.takenByUser = user.username;
            addMessage(conv, "system", user.name + " from the IT team has joined the chat.");
          }
          return sendJson(res, 200, publicView(conv, since));
        }
        if (action === "priority") {
          const body = await readBody(req);
          conv.priority = body.urgent === true ? "urgent" : "normal";
          store.touch(conv);
          return sendJson(res, 200, publicView(conv, since));
        }
        if (action === "handback") {
          if (conv.mode !== "bot") {
            conv.mode = "bot";
            conv.needsHuman = false;
            conv.takenBy = "";
            conv.takenByUser = "";
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
          addMessage(conv, "agent", text, { by: user.name });
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

async function start() {
  store = await createStore();
  conversations = store.conversations;
  await knowledge.init(store);
  await ensureOwner();

  server.listen(PORT, () => {
    console.log("SupportDesk running on port " + PORT);
    console.log(store.mode === "postgres" ? "Storage: database, chats and tickets are kept for good" : "Storage: plain files, a free host wipes these when it restarts");
    console.log(ADMIN_PASSWORD ? "IT team signs in with the username admin and the ADMIN_PASSWORD setting" : "No ADMIN_PASSWORD set, the IT team pages only open on this computer");
    console.log(alerts.enabled ? "Email alerts on, " + alerts.recipients + " recipient(s)" : "Email alerts off");
    if (GEMINI_KEY) console.log("AI mode on, Gemini model " + GEMINI_MODEL);
    else if (GROQ_KEY) console.log("AI mode on, Groq model " + GROQ_MODEL);
    else console.log("No API key set, using the built in keyword answers");
  });

  const shutdown = async () => {
    await store.flush();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start().catch((err) => {
  console.error("Could not start: " + err.message);
  process.exit(1);
});
