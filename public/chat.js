// Chat widget. Keeps the conversation in memory, asks the server for answers,
// and shows the ticket form when the AI says it cannot solve the problem.

const chat = document.getElementById("chat");
const toggle = document.getElementById("chat-toggle");
const log = document.getElementById("log");
const form = document.getElementById("chat-form");
const input = document.getElementById("msg");
const ticketForm = document.getElementById("ticket-form");

const history = [];
let started = false;

function addBubble(text, who) {
  const div = document.createElement("div");
  div.className = "bubble " + who;
  div.textContent = text; // textContent, never innerHTML, so nothing typed can run as code
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function openChat() {
  chat.hidden = false;
  toggle.hidden = true;
  if (!started) {
    started = true;
    addBubble("Hello, I am the IT help assistant. Tell me what is not working, for example Outlook, keyboard, printer or network.", "bot");
  }
  input.focus();
}

function closeChat() {
  chat.hidden = true;
  toggle.hidden = false;
}

toggle.addEventListener("click", openChat);
document.getElementById("hero-chat").addEventListener("click", openChat);
document.getElementById("chat-close").addEventListener("click", closeChat);

// Links on the page that start the chat with a question already asked.
document.querySelectorAll("[data-ask]").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    openChat();
    input.value = link.dataset.ask;
    form.requestSubmit();
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addBubble(text, "me");
  history.push({ role: "user", content: text });
  form.querySelector("button").disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    addBubble(data.reply, "bot");
    history.push({ role: "assistant", content: data.reply });
    if (data.escalate) ticketForm.hidden = false;
  } catch (err) {
    addBubble("Sorry, I could not answer that. You can leave your details for the IT team.", "bot");
    ticketForm.hidden = false;
  } finally {
    form.querySelector("button").disabled = false;
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
        name: document.getElementById("t-name").value,
        contact: document.getElementById("t-contact").value,
        place: document.getElementById("t-place").value,
        transcript: history,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    addBubble("Thank you. Your ticket number is " + data.id + ". The IT team will contact you soon.", "bot");
    ticketForm.hidden = true;
    ticketForm.reset();
  } catch (err) {
    addBubble("The ticket could not be saved, please try again.", "bot");
  } finally {
    button.disabled = false;
  }
});
