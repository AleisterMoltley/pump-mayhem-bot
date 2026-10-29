import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth, readCookie } from "./auth.mjs";
import { configStatus, loadConfig } from "./config.mjs";
import { createEngine } from "./engine.mjs";
import { formatSol } from "./money.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const posterPath = path.join(root, "assets", "boycott.png");

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Anfrage ist zu groß"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("JSON ungültig"));
      }
    });
    req.on("error", reject);
  });
}

function cookieHeader(token, req) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`;
}

const files = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

export function createHttpServer({ config, auth, runtime }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (url.pathname === "/health") {
        const status = configStatus(config);
        sendJson(res, 200, { ok: true, ready: status.ready });
        return;
      }
      if (url.pathname === "/brand/boycott.png") {
        const bytes = await fs.readFile(posterPath);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        res.end(bytes);
        return;
      }
      if (files[url.pathname] && req.method === "GET") {
        const item = files[url.pathname];
        const body = await fs.readFile(path.join(publicDir, item.file));
        res.writeHead(200, { "content-type": item.type });
        res.end(body);
        return;
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        if (!config.password || config.password.length < 8) {
          sendJson(res, 503, { error: "DASHBOARD_PASSWORD fehlt oder ist kürzer als 8 Zeichen" });
          return;
        }
        const body = await readBody(req);
        const token = auth.login(body.password);
        if (!token) {
          sendJson(res, 401, { error: "Falsches Passwort" });
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": cookieHeader(token, req),
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/api/logout" && req.method === "POST") {
        auth.logout(readCookie(req.headers.cookie, "session"));
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!auth.check(readCookie(req.headers.cookie, "session"))) {
        sendJson(res, 401, { error: "Nicht angemeldet" });
        return;
      }
      if (url.pathname === "/api/state" && req.method === "GET") {
        const balance = await runtime.holderBalance();
        const snapshot = await runtime.snapshot(balance);
        snapshot.balanceSol = balance == null ? null : formatSol(balance);
        snapshot.totals.profitSol = formatSol(snapshot.totals.profitLamports);
        sendJson(res, 200, snapshot);
        return;
      }
      if (url.pathname === "/api/start" && req.method === "POST") {
        await runtime.start();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/stop" && req.method === "POST") {
        await runtime.stop();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/sell" && req.method === "POST") {
        sendJson(res, 200, { ok: runtime.sellNow() });
        return;
      }
      if (url.pathname === "/api/wallets" && req.method === "GET") {
        sendJson(res, 200, {
          wallets: runtime.wallets.map((wallet) => ({
            id: wallet.id,
            publicKey: wallet.publicKey,
            createdAt: wallet.createdAt,
            launched: wallet.launched,
            role: wallet.role,
          })),
        });
        return;
      }
      if (url.pathname.startsWith("/api/wallets/") && url.pathname.endsWith("/reveal") && req.method === "POST") {
        const id = decodeURIComponent(url.pathname.slice("/api/wallets/".length, -"/reveal".length));
        const wallet = runtime.wallets.find((entry) => entry.id === id);
        if (!wallet) {
          sendJson(res, 404, { error: "Wallet nicht in der Bibliothek" });
          return;
        }
        sendJson(res, 200, { publicKey: wallet.publicKey, secretKey: wallet.secretKey });
        return;
      }
      if (url.pathname === "/api/wallets/export" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": "attachment; filename=mayhem-wallets.json",
        });
        res.end(JSON.stringify(runtime.wallets, null, 2));
        return;
      }
      sendJson(res, 404, { error: "Nicht gefunden" });
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Fehler" });
    }
  });
}

export async function main() {
  const config = loadConfig();
  const auth = createAuth(config.password || "disabled-password-placeholder");
  const runtime = await createEngine(config);
  await runtime.boot();
  const server = createHttpServer({ config, auth, runtime });
  server.listen(config.port, () => {
    console.log(`Mayhem-Bot hört auf :${config.port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
