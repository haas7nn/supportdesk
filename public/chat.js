// Chat widget. The conversation lives on the server, so the IT team can read it and take over.
// This page sends messages, then asks the server every few seconds for anything new
// (bot answers, or a reply from an IT team member).

const chat = document.getElementById("chat");
const toggle = document.getElementById("chat-toggle");
const log = document.getElementById("log");
const form = document.getElementById("chat-form");
const input = document.getElementById("msg");
const ticketForm = document.getElementById("ticket-form");

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

function showTyping(on) {
  if (on && !typing) typing = addBubble("...", "bot");
  if (!on && typing) {
    typing.remove();
    typing = null;
  }
}

function render(m) {
  if (m.role === "user") {
    // Already shown when it was sent, so just mark that one as confirmed.
    if (pendingBubbles.length) pendingBubbles.shift();
    else addBubble(m.content, "me");
  } else if (m.role === "agent") {
    showTyping(false);
    addBubble(m.content, "bot agent", "IT team");
  } else if (m.role === "assistant") {
    showTyping(false);
    addBubble(m.content, "bot");
  } else {
    addBubble(m.content, "note");
  }
}

function applyState(data) {
  for (const m of data.messages) render(m);
  seen += data.messages.length;
  humanMode = data.mode === "human";
  if (humanMode) showTyping(false);
  // Offer the ticket form when the assistant could not solve it and there is no ticket yet.
  ticketForm.hidden = !(data.needsHuman && !data.ticketId);
  input.placeholder = humanMode ? "Write to the IT team" : "Describe the problem";
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
    addBubble("Hello, I am the IT help assistant. Tell me what is not working, for example Outlook, keyboard, printer or network.", "bot");
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
  const button = form.querySelector("button");
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
      // A brand new server chat, so earlier on screen counts start again from this one.
      convId = data.id;
      try { sessionStorage.setItem("chatId", convId); } catch { /* ignore */ }
    }
    // The answer is already stored, so this is the same data a poll would give.
    const next = await fetch("/api/chat/" + convId + "?since=" + seen);
    if (next.ok) applyState(await next.json());
  } catch (err) {
    showTyping(false);
    pendingBubbles.pop();
    addBubble(err.message || "Sorry, that did not send. Please try again.", "note");
  } finally {
    button.disabled = false;
    input.focus();
  }
});

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
    addBubble("Thank you. Your ticket number is " + data.id + ". The IT team will contact you soon, or reply right here.", "note");
    ticketForm.hidden = true;
    ticketForm.reset();
    poll();
  } catch (err) {
    addBubble(err.message || "The ticket could not be saved, please try again.", "note");
  } finally {
    button.disabled = false;
  }
});
