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

## Everything it can do

For employees:
* Chat with the assistant, in English or Arabic (the button in the top corner, the whole page flips).
* After each answer, press Yes, fixed or No, still broken. No sends them to the IT team.
* Say "I want a human" and the chat is handed over at once.
* Attach a screenshot. The page shrinks it first, and the server only accepts real JPEG files.
* Check a ticket with its number and the contact they gave.

For the IT team (each person signs in with their own username and password):
* Live chats with a Needs a person label, an Urgent label, a sound alert and a count in the tab title.
* Take over, reply with saved replies, hand back to the bot, mark urgent.
* Tickets with the Problem, Tried and Result note, and Mark solved or Open again.
* Stats: chats, solved by the bot, needed a person, solve rate, and the most common problems.
* Help articles, on their own page: a searchable list and an editor, in English and Arabic, with a box to try the bot. No code needed.
* Team: the owner adds and removes members and resets passwords, and everyone can change their own password.
* Every reply carries the name of the person who wrote it, and the chat list shows who has each chat.
* Email alerts when a chat needs a person, when a chat is urgent, and when a ticket arrives.

## Keeping data for good (a database)

By default chats and tickets are saved in plain files. A free host wipes those on every restart. To keep everything, set `DATABASE_URL` to a Postgres address (a free one from https://neon.tech works). Then chats, tickets, screenshots, team members and edited help articles are all saved in the database, and the server needs nothing else. Run `npm install` once so the database package is there.

## Signing in

The owner account is the username `admin`, and its password is the `ADMIN_PASSWORD` setting. Forgot it? Change the setting and restart, and the account follows it. The owner adds the other team members on the Team tab. Passwords are stored only as salted hashes. Set `SESSION_SECRET` to a long random text so sign ins last across restarts.

## Email alerts

Set `RESEND_API_KEY` (from https://resend.com) and `ALERT_EMAIL_TO` (one or more addresses, separated by commas), and optionally `PUBLIC_URL` so the email links to the IT page. With Resend's test sender, mail can only go to the address you signed up with, until you verify your own domain. There is a limit of one email per chat every 30 minutes, and 20 an hour overall.

## Files

| File | What it does |
| --- | --- |
| `server.js` | The backend: chat, tickets, sign in, team |
| `store.js` | Saves everything, to files or to a database |
| `auth.js` | Password hashing and sign in cookies |
| `alerts.js` | Email alerts |
| `knowledge.json`, `knowledge.js` | The help articles, and the code that loads, checks and matches them |
| `public/index.html`, `style.css` | The portal page |
| `public/chat.js`, `public/i18n.js` | The chat widget, and the English and Arabic texts |
| `public/agent.html` | The IT team page: live chats, tickets, stats, team |
| `public/articles.html` | The help articles editor |
| `public/login.html` | The IT team sign in page |

## Safety choices worth mentioning

* The assistant is told never to accept passwords, and the chat shows a warning.
* Typed text is shown with `textContent`, so it can never run as code.
* Message length and count are limited, and the server falls back to keyword answers if the AI is down.
* The IT team pages need a sign in. The cookie is signed, HttpOnly and SameSite strict, and actions that change things only accept JSON, so another website cannot trigger them.
* A removed member or a changed password ends that persons sessions at once.
* Demo limits: the sign in has no lockout after many wrong tries, only a rate limit, and there is no two step sign in. A real system would add both.

## Ideas for next steps

* Two step sign in for the IT team.
* Assign a ticket to one person.
* Add more problems to `knowledge.json` from the tickets the team sees most often.
