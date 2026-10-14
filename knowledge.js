
// the help articles. load, check, save and match them

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "knowledge.json");
const MAX_ARTICLES = 60;

let items = JSON.parse(fs.readFileSync(FILE, "utf8"));

function get() {
  return items;
}

const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

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

let keep = null;
async function init(store) {
  if (store.mode !== "postgres") return;
  const saved = await store.getKV("knowledge");
  if (saved) items = check(saved);
  keep = (list) => store.setKV("knowledge", list);
}

function set(list) {
  const cleaned = check(list);
  if (keep) {
    keep(cleaned).catch((err) => console.error("Could not save the articles: " + err.message));
    try {
      fs.writeFileSync(FILE, JSON.stringify(cleaned, null, 2));
    } catch {
    }
  } else {
    fs.writeFileSync(FILE, JSON.stringify(cleaned, null, 2));
  }
  items = cleaned;
  return items;
}

const isArabic = (t) => /[؀-ۿ]/.test(t);
const GREETING = /^\s*(hi|hello|hey|hola|salam|good (morning|afternoon|evening)|thanks|thank you|مرحبا|مرحباً|اهلا|أهلا|هلا|السلام عليكم|شكرا|شكراً)(\s|$|[!.,؟?])/i;
const isGreeting = (t) => GREETING.test(t) && t.length < 30;

// picks the article with the most keyword hits
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

function topicFor(t) {
  const hit = bestArticle(t);
  return hit ? hit.topic : "Other";
}

// used when theres no ai key or the ai is down
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

module.exports = { init, get, set, check, isArabic, isGreeting, topicFor, keywordAnswer, promptList };
