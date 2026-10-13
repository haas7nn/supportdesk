// Help articles: loading, checking, saving, and the simple keyword matcher.
// The IT team edits these from the "Help articles" tab, and the AI is given the same list.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "knowledge.json");
const MAX_ARTICLES = 60;

let items = JSON.parse(fs.readFileSync(FILE, "utf8"));

function get() {
  return items;
}

const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

// Cleans whatever the editor sends. Throws a readable error so the page can show it.
function check(list) {
  if (!Array.isArray(list)) throw new Error("Send a list of articles.");
  if (list.length > MAX_ARTICLES) throw new Error("Too many articles, the limit is " + MAX_ARTICLES + ".");
  return list.map((a, i) => {
    const topic = text(a && a.topic, 120);
    const answer = text(a && a.answer, 900);
    if (!topic || !answer) throw new Error("Article " + (i + 1) + " needs a topic and an answer.");
    const keywords = (Array.isArray(a.keywords) ? a.keywords : String(a.keywords || "").split(","))
      .map((k) => text(k, 30).toLowerCase())
      .filter(Boolean)
      .slice(0, 30);
    const out = { topic, keywords, answer };
    const ar = text(a.answer_ar, 900);
    if (ar) out.answer_ar = ar;
    return out;
  });
}

function set(list) {
  const cleaned = check(list);
  fs.writeFileSync(FILE, JSON.stringify(cleaned, null, 2));
  items = cleaned;
  return items;
}

const isArabic = (t) => /[؀-ۿ]/.test(t);
const GREETING = /^\s*(hi|hello|hey|hola|salam|good (morning|afternoon|evening)|thanks|thank you|مرحبا|مرحباً|اهلا|أهلا|هلا|السلام عليكم|شكرا|شكراً)(\s|$|[!.,؟?])/i;
const isGreeting = (t) => GREETING.test(t) && t.length < 30;

// Scores each article by how many of its keywords appear in the text.
function bestArticle(t) {
  const words = t.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const score = item.keywords.filter((k) => words.includes(k)).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

// The problem area of a message, used for the "most common problems" chart.
function topicFor(t) {
  const hit = bestArticle(t);
  return hit ? hit.topic : "Other";
}

// What the bot says with no AI key, or when the AI is down.
function keywordAnswer(t, notFound) {
  const ar = isArabic(t);
  if (isGreeting(t)) {
    return {
      reply: ar
        ? "أهلاً! أخبرني ما المشكلة، مثلاً أوتلوك أو تيمز أو لوحة المفاتيح أو الطابعة."
        : "Hello! Tell me what is not working, for example Outlook, Teams, a keyboard or a printer.",
      escalate: false,
    };
  }
  const hit = bestArticle(t);
  if (!hit) return { reply: notFound, escalate: true };
  return { reply: ar && hit.answer_ar ? hit.answer_ar : hit.answer, escalate: false };
}

function promptList() {
  return items.map((k) => "- " + k.topic + ": " + k.answer);
}

module.exports = { get, set, check, isArabic, isGreeting, topicFor, keywordAnswer, promptList };
