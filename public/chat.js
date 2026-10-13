// Chat widget. The conversation lives on the server, so the IT team can read it and take over.
// This page sends messages, then asks the server every few seconds for anything new
// (bot answers, or a reply from an IT team member). Texts come from i18n.js, in English or Arabic.

const chat = document.getElementById("chat");
const toggle = document.getElementById("chat-toggle");
const log = document.getElementById("log");
const form = document.getElementById("chat-form");
const input = document.getElementById("msg");
const ticketForm = document.getElementById("ticket-form");
const fileInput = document.getElementById("file");

const POLL_MS = 3000;
let convId = null;
try {
  convId = sessionStorage.getItem("chatId");
} catch {
  // storage can be blocked, the chat still works until the page reloads
}
let seen = 0; // how many server messages are already on screen
let started = false;
let timer = null;
let humanMode = false;
const pendingBubbles = []; // the employee's own bubbles shown before the server confirms them
let typing = null;

function addBubble(text, kind, label) {
  const div = document.createElement("div");
  div.className = "bubble " + kind;
  if (label) {
    const tag = document.createElement("strong");
    tag.className = "tag";
    tag.textContent = label;
    div.append(tag);
  }
  div.append(document.createTextNode(text)); // text nodes only, so nothing typed can run as code
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function addPicture(src) {
  const div = document.createElement("div");
  div.className = "bubble me pic";
  const img = document.createElement("img");
  img.src = src;
  img.alt = "Screenshot";
  img.addEventListener("load", () => { log.scrollTop = log.scrollHeight; });
  div.append(img);
  log.appendChild(div);
}

function showTyping(on) {
  if (on && !typing) typing = addBubble("...", "bot");
  if (!on && typing) {
    typing.remove();
    typing = null;
  }
}

// The "Did that fix it?" buttons. Only the newest answer keeps them.
function addFeedback(index) {
  log.querySelectorAll(".fb").forEach((el) => el.remove());
  const row = document.createElement("div");
  row.className = "fb";
  const question = document.createElement("span");
  question.textContent = t("fb_q");
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "fb-yes";
  yes.textContent = t("fb_yes");
  const no = document.createElement("button");
  no.type = "button";
  no.className = "fb-no";
  no.textContent = t("fb_no");
  async function answerWith(helped) {
    yes.disabled = no.disabled = true;
    try {
      const res = await fetch("/api/chat/" + convId + "/feedback?since=" + seen, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ index, helped }),
      });
      const data = await res.json();
      row.remove();
      if (res.ok) applyState(data);
    } catch {
      yes.disabled = no.disabled = false;
    }
  }
  yes.onclick = () => answerWith(true);
  no.onclick = () => answerWith(false);
  row.append(question, yes, no);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function render(m) {
  if (m.img) {
    addPicture(m.img);
  } else if (m.role === "user") {
    // Already shown when it was sent, so just mark that one as confirmed.
    if (pendingBubbles.length) pendingBubbles.shift();
    else addBubble(m.content, "me");
  } else if (m.role === "agent") {
    showTyping(false);
    addBubble(m.content, "bot agent", t("it_team"));
  } else if (m.role === "assistant") {
    showTyping(false);
    addBubble(m.content, "bot");
    if (m.ask) addFeedback(m.i);
  } else {
    addBubble(m.content, "note");
  }
}

function applyState(data) {
  for (const m of data.messages) render(m);
  seen += data.messages.length;
  humanMode = data.mode === "human";
  if (humanMode) {
    showTyping(false);
    log.querySelectorAll(".fb").forEach((el) => el.remove());
  }
  // Offer the ticket form when the assistant could not solve it and there is no ticket yet.
  ticketForm.hidden = !(data.needsHuman && !data.ticketId);
  input.placeholder = humanMode ? t("ph_human") : t("ph_msg");
}

async function poll() {
  if (!convId || chat.hidden) return;
  try {
    const res = await fetch("/api/chat/" + convId + "?since=" + seen);
    if (res.status === 404) {
      // The server forgot this chat (it restarted), so start fresh.
      convId = null;
      seen = 0;
      try { sessionStorage.removeItem("chatId"); } catch { /* ignore */ }
      return;
    }
    if (res.ok) applyState(await res.json());
  } catch {
    // network blip, try again on the next tick
  }
}

async function openChat() {
  chat.hidden = false;
  toggle.hidden = true;
  if (!started) {
    started = true;
    addBubble(t("greeting"), "bot");
    if (convId) await poll(); // page was reloaded in the middle of a chat, so load it back
  }
  clearInterval(timer);
  timer = setInterval(poll, POLL_MS);
  input.focus();
}

function closeChat() {
  chat.hidden = true;
  toggle.hidden = false;
  clearInterval(timer);
}

toggle.addEventListener("click", openChat);
document.getElementById("hero-chat").addEventListener("click", openChat);
document.getElementById("chat-close").addEventListener("click", closeChat);

// Links on the page that start the chat with a question already asked.
document.querySelectorAll("[data-ask]").forEach((link) => {
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    await openChat();
    input.value = link.dataset.ask;
    form.requestSubmit();
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  pendingBubbles.push(addBubble(text, "me"));
  const button = form.querySelector("button.primary");
  button.disabled = true;
  if (!humanMode) showTyping(true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: convId, text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    if (convId !== data.id) {
      convId = data.id;
      try { sessionStorage.setItem("chatId", convId); } catch { /* ignore */ }
    }
    // The answer is already stored, so this is the same data a poll would give.
    const next = await fetch("/api/chat/" + convId + "?since=" + seen);
    if (next.ok) applyState(await next.json());
  } catch (err) {
    showTyping(false);
    pendingBubbles.pop();
    addBubble(err.message || t("err_send"), "note");
  } finally {
    button.disabled = false;
    input.focus();
  }
});

// ---------- screenshots ----------

// Shrinks the picture in the browser first, so it is small and always a JPEG.
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      for (const [side, quality] of [[1100, 0.72], [800, 0.6], [600, 0.5]]) {
        const scale = Math.min(1, side / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length < 650000) return resolve(dataUrl);
      }
      reject(new Error("That picture is too big."));
    };
    img.onerror = () => reject(new Error("That file is not a picture."));
    img.src = url;
  });
}

document.getElementById("attach").addEventListener("click", () => {
  if (!convId) {
    addBubble(t("need_text"), "note");
    return;
  }
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file || !convId) return;
  const note = addBubble(t("uploading"), "note");
  try {
    const dataUrl = await shrink(file);
    const res = await fetch("/api/chat/" + convId + "/image?since=" + seen, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    const data = await res.json();
    note.remove();
    if (!res.ok) throw new Error(data.error || t("err_send"));
    applyState(data);
  } catch (err) {
    note.remove();
    addBubble(err.message || t("err_send"), "note");
  }
});

// ---------- ticket form and ticket check ----------

ticketForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = ticketForm.querySelector("button");
  button.disabled = true;
  try {
    const res = await fetch("/api/ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: convId,
        name: document.getElementById("t-name").value,
        contact: document.getElementById("t-contact").value,
        place: document.getElementById("t-place").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    addBubble(t("ticket_thanks", { id: data.id }), "note");
    ticketForm.hidden = true;
    ticketForm.reset();
    poll();
  } catch (err) {
    addBubble(err.message || t("err_send"), "note");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("check-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const result = document.getElementById("check-result");
  try {
    const res = await fetch("/api/ticket-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: document.getElementById("c-id").value,
        contact: document.getElementById("c-contact").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    result.textContent = t(data.status === "solved" ? "st_solved" : "st_open", { id: data.id });
  } catch (err) {
    result.textContent = err.message || t("err_send");
  }
});

// Changing the language also changes the texts the chat made before.
document.addEventListener("langchange", () => {
  input.placeholder = humanMode ? t("ph_human") : t("ph_msg");
});
