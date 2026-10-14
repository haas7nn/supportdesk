
// email alerts through resend needs RESEND_API_KEY and ALERT_EMAIL_TO

const knowledge = require("./knowledge");

const KEY = process.env.RESEND_API_KEY || "";
const TO = (process.env.ALERT_EMAIL_TO || "").split(",").map((a) => a.trim()).filter(Boolean);
const FROM = process.env.ALERT_FROM || "NBB IT Help project <onboarding@resend.dev>";
const LINK = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

const enabled = Boolean(KEY && TO.length);

// limits so the inbox never gets flooded
const PER_CHAT_MS = 30 * 60 * 1000;
const PER_HOUR = 20;
const lastForChat = new Map();
let sentThisHour = [];

function allowed(key) {
  const now = Date.now();
  sentThisHour = sentThisHour.filter((t) => now - t < 3600 * 1000);
  if (sentThisHour.length >= PER_HOUR) return false;
  if (key && now - (lastForChat.get(key) || 0) < PER_CHAT_MS) return false;
  if (key) lastForChat.set(key, now);
  sentThisHour.push(now);
  return true;
}

async function send(subject, text) {
  const res = await fetch(process.env.RESEND_URL || "https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({ from: FROM, to: TO, subject, text }),
  });
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    throw new Error("Email failed with status " + res.status + (info.message ? ": " + info.message : ""));
  }
}

function fire(subject, text, key) {
  if (!enabled || !allowed(key)) return;
  send(subject, text + (LINK ? "\n\nOpen it: " + LINK + "/agent.html" : "")).catch((err) => console.error(err.message));
}

function firstProblem(conv) {
  const first = (conv.messages || []).find((m) => m.role === "user" && !m.img && !knowledge.isGreeting(m.content));
  return first ? first.content.slice(0, 200) : "(no message yet)";
}

module.exports = {
  enabled,
  recipients: TO.length,
  chatNeedsPerson: (conv) =>
    fire((conv.priority === "urgent" ? "URGENT: " : "") + "A chat needs a person", "Problem: " + firstProblem(conv) + "\nPriority: " + conv.priority, "chat:" + conv.id),
  chatBecameUrgent: (conv) => fire("URGENT chat", "Problem: " + firstProblem(conv), "urgent:" + conv.id),
  newTicket: (t) =>
    fire((t.priority === "urgent" ? "URGENT: " : "") + "New ticket " + t.id, t.name + " (" + t.contact + (t.place ? ", " + t.place : "") + ")\n\n" + (t.summary || ""), "ticket:" + t.id),
  test: async () => {
    if (!enabled) throw new Error("Email alerts are off. Set RESEND_API_KEY and ALERT_EMAIL_TO on the server.");
    await send("Test from the NBB IT Help project", "If you can read this, email alerts work.");
  },
};
