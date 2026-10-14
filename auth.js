
// passwords and login cookies

const crypto = require("crypto");

const COOKIE = "sd_session";
const SESSION_HOURS = 12;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

// do the full check even when the user doesnt exist, so the timing gives nothing away
function checkPassword(password, user) {
  const salt = user ? user.salt : "0".repeat(32);
  const expected = Buffer.from(user ? user.hash : "0".repeat(128), "hex");
  const given = crypto.scryptSync(String(password), salt, 64);
  return Boolean(user) && expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const sign = (text) => crypto.createHmac("sha256", SECRET).update(text).digest("base64url");

function makeCookie(user, secure) {
  const payload = Buffer.from(JSON.stringify({ u: user.username, pv: user.hash.slice(0, 8), exp: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString("base64url");
  const value = payload + "." + sign(payload);
  return COOKIE + "=" + value + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + SESSION_HOURS * 3600 + (secure ? "; Secure" : "");
}

function clearCookie(secure) {
  return COOKIE + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" + (secure ? "; Secure" : "");
}

function readSession(req) {
  const cookie = String(req.headers.cookie || "")
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(COOKIE + "="));
  if (!cookie) return null;
  const [payload, signature] = cookie.slice(COOKIE.length + 1).split(".");
  if (!payload || !signature) return null;
  const good = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, checkPassword, makeCookie, clearCookie, readSession };
