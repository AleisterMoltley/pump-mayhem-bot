import crypto from "node:crypto";

export function createAuth(password) {
  const sessions = new Map();
  let failures = 0;
  let lockedUntil = 0;
  return {
    login(candidate) {
      if (Date.now() < lockedUntil) return null;
      const given = Buffer.from(String(candidate ?? ""));
      const expected = Buffer.from(String(password ?? ""));
      if (given.length === 0 || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        failures += 1;
        if (failures >= 8) lockedUntil = Date.now() + 15_000;
        return null;
      }
      failures = 0;
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
      return token;
    },
    check(token) {
      if (!token || !sessions.has(token)) return false;
      if (sessions.get(token) < Date.now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    logout(token) {
      sessions.delete(token);
    },
  };
}

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const text = part.trim();
    if (!text.startsWith(`${name}=`)) continue;
    return decodeURIComponent(text.slice(name.length + 1));
  }
  return "";
}
