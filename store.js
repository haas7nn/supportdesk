// Where chats, tickets, team members and screenshots are kept.
// Without DATABASE_URL everything goes into plain files (fine on a laptop, wiped on a free host).
// With DATABASE_URL it goes into a Postgres database, so nothing is lost when the server restarts.
// The rest of the program only talks to the object returned by createStore(), it never knows which one it got.

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const SAVE_DELAY_MS = 300;

function imagesInside(conv) {
  return (conv.messages || []).filter((m) => m.img).map((m) => path.basename(m.img));
}

// ---------- plain files ----------

async function fileStore() {
  const read = (name, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8"));
    } catch {
      return fallback;
    }
  };
  const uploads = path.join(DIR, "uploads");
  const store = {
    mode: "file",
    conversations: new Map(),
    tickets: read("tickets.json", []),
    users: read("users.json", []),
  };
  for (const c of read("conversations.json", [])) store.conversations.set(c.id, c);

  let timer = null;
  const writeNow = () => {
    clearTimeout(timer);
    timer = null;
    try {
      fs.writeFileSync(path.join(DIR, "conversations.json"), JSON.stringify([...store.conversations.values()]));
    } catch (err) {
      console.error("Could not save conversations: " + err.message);
    }
  };
  store.touch = () => {
    if (!timer) timer = setTimeout(writeNow, SAVE_DELAY_MS);
  };
  store.removeConversation = (id) => {
    const conv = store.conversations.get(id);
    if (conv) for (const name of imagesInside(conv)) fs.rm(path.join(uploads, name), () => {});
    store.conversations.delete(id);
    store.touch();
  };
  store.saveTickets = () => fs.writeFileSync(path.join(DIR, "tickets.json"), JSON.stringify(store.tickets, null, 2));
  store.saveUsers = () => fs.writeFileSync(path.join(DIR, "users.json"), JSON.stringify(store.users, null, 2));
  store.putImage = async (name, bytes) => {
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, name), bytes);
  };
  store.getImage = (name) =>
    new Promise((resolve) => fs.readFile(path.join(uploads, name), (err, data) => resolve(err ? null : data)));
  // The help articles already live in knowledge.json, so there is nothing extra to keep here.
  store.getKV = async () => null;
  store.setKV = async () => {};
  store.flush = async () => {
    if (timer) writeNow();
  };
  return store;
}

// ---------- Postgres ----------

async function pgStore(url) {
  const { Pool } = require("pg"); // only needed in this mode
  const pool = new Pool({ connectionString: url, max: 4 });
  const run = (sql, params) => pool.query(sql, params);

  await run("create table if not exists conversations (id text primary key, data jsonb not null, updated_at bigint not null)");
  await run("create table if not exists tickets (id text primary key, data jsonb not null)");
  await run("create table if not exists users (username text primary key, data jsonb not null)");
  await run("create table if not exists images (name text primary key, bytes bytea not null, created_at bigint not null)");
  await run("create table if not exists kv (key text primary key, value jsonb not null)");

  const store = {
    mode: "postgres",
    conversations: new Map(),
    tickets: [],
    users: [],
  };
  for (const r of (await run("select data from conversations")).rows) store.conversations.set(r.data.id, r.data);
  store.tickets = (await run("select data from tickets order by id")).rows.map((r) => r.data);
  store.users = (await run("select data from users")).rows.map((r) => r.data);

  const dirty = new Set();
  const removed = [];
  let timer = null;

  async function flush() {
    clearTimeout(timer);
    timer = null;
    const ids = [...dirty];
    const gone = removed.splice(0);
    dirty.clear();
    try {
      for (const id of ids) {
        const conv = store.conversations.get(id);
        if (conv) {
          await run(
            "insert into conversations (id, data, updated_at) values ($1, $2, $3) on conflict (id) do update set data = $2, updated_at = $3",
            [id, conv, conv.updatedAt || Date.now()]
          );
        }
      }
      for (const g of gone) {
        await run("delete from conversations where id = $1", [g.id]);
        if (g.images.length) await run("delete from images where name = any($1)", [g.images]);
      }
    } catch (err) {
      console.error("Could not save to the database: " + err.message);
      ids.forEach((id) => dirty.add(id)); // try again on the next save
    }
  }

  store.touch = (conv) => {
    if (conv) dirty.add(conv.id);
    else store.conversations.forEach((c) => dirty.add(c.id));
    if (!timer) timer = setTimeout(flush, SAVE_DELAY_MS);
  };
  store.removeConversation = (id) => {
    const conv = store.conversations.get(id);
    if (conv) removed.push({ id, images: imagesInside(conv) });
    store.conversations.delete(id);
    dirty.delete(id);
    if (!timer) timer = setTimeout(flush, SAVE_DELAY_MS);
  };
  store.saveTickets = async () => {
    for (const t of store.tickets) {
      await run("insert into tickets (id, data) values ($1, $2) on conflict (id) do update set data = $2", [t.id, t]);
    }
  };
  store.saveUsers = async () => {
    const names = store.users.map((u) => u.username);
    await run("delete from users where not (username = any($1))", [names]);
    for (const u of store.users) {
      await run("insert into users (username, data) values ($1, $2) on conflict (username) do update set data = $2", [u.username, u]);
    }
  };
  store.putImage = async (name, bytes) => {
    await run("insert into images (name, bytes, created_at) values ($1, $2, $3)", [name, bytes, Date.now()]);
  };
  store.getImage = async (name) => {
    const r = await run("select bytes from images where name = $1", [name]);
    return r.rows[0] ? r.rows[0].bytes : null;
  };
  store.getKV = async (key) => {
    const r = await run("select value from kv where key = $1", [key]);
    return r.rows[0] ? r.rows[0].value : null;
  };
  store.setKV = async (key, value) => {
    await run("insert into kv (key, value) values ($1, $2) on conflict (key) do update set value = $2", [key, JSON.stringify(value)]);
  };
  store.flush = flush;
  store.close = () => pool.end();
  return store;
}

async function createStore() {
  const url = process.env.DATABASE_URL || "";
  return url ? pgStore(url) : fileStore();
}

module.exports = { createStore };
