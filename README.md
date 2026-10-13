# NBB IT Help Project

A student project. It is not an official NBB system and is not connected to NBB.

## The idea

Employees often open IT tickets for basic things like Outlook not updating or a keyboard that does not work. Here the AI assistant answers first with simple steps, and a ticket only reaches the IT team if the AI cannot solve it. The ticket includes the whole chat, so the employee does not repeat themselves and IT sees what was already tried.

## Run it

```bash
cd /Users/haas7n/SupportDesk
node server.js
```

Open http://localhost:3000. The IT team view is at http://localhost:3000/agent.html.

Without an API key it still works, using simple keyword matching on `knowledge.json`. To use the real AI:

```bash
GEMINI_API_KEY=your_key_here node server.js
```

Free Groq keys come from https://console.groq.com, run with `GROQ_API_KEY=your_key_here node server.js`. A free Gemini key comes from https://aistudio.google.com. If you use a paid Anthropic key instead, set `ANTHROPIC_API_KEY`. If several keys are set, the order is Gemini, then Groq, then Anthropic.

## How it works, in four steps

1. The employee types in the chat box (`public/chat.js`).
2. The browser sends the chat to the server (`/api/chat` in `server.js`). The API key lives only on the server.
3. The server asks the AI, giving it the help articles from `knowledge.json`. If the AI cannot answer, it ends its reply with `[ESCALATE]`.
4. On escalate, the chat shows a form. Submitting it saves a ticket in `tickets.json`, shown in the agent view.

## Live chats, taking over from the bot

Every chat is stored on the server. On the IT team page, the Live chats tab lists them, with a label for who is answering: Bot, Needs a person, or You.

1. Open a chat to read it as it happens.
2. Press Take over. The employee sees "An IT team member has joined the chat" and the bot stops answering.
3. Type replies. They appear in the employee's chat within a few seconds.
4. Press Hand back to bot when you are done, and the assistant takes over again.

The employee page and the IT team page both ask the server for news every 2 to 3 seconds. That is simple polling, easy to explain, and fine for a small team.

## Files

| File | What it does |
| --- | --- |
| `server.js` | The whole backend, no packages needed |
| `knowledge.json` | The help articles, edit these to teach the assistant |
| `public/index.html`, `style.css` | The portal page |
| `public/chat.js` | The chat widget |
| `public/agent.html` | The IT team page, live chats and tickets |

## Safety choices worth mentioning

* The assistant is told never to accept passwords, and the chat shows a warning.
* Typed text is shown with `textContent`, so it can never run as code.
* Message length and count are limited, and the server falls back to keyword answers if the AI is down.
* The IT team routes need the admin password, and the actions that change things only accept JSON, so another website cannot trigger them.
* Demo limits: no login on the agent page, and tickets and chats sit in plain files, which a free host wipes when it restarts. A real system needs both fixed.

## Ideas for next steps

* Add more help articles to `knowledge.json`.
* Add a ticket status button (open, solved).
* Add Arabic.
* Add more problems to `knowledge.json` from the tickets the team sees most often.
