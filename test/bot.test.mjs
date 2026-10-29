import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../src/auth.mjs";
import { buildCopy } from "../src/copy.mjs";
import { configStatus, loadConfig } from "../src/config.mjs";
import { formatSol, microLamports, sweepLamports } from "../src/money.mjs";
import { blankState, publicState, step } from "../src/round.mjs";
import { armVaultWatch, nextVaultEvent, readTokenAmount } from "../src/vault.mjs";
import { appendWalletRecord, writeWalletLibrary } from "../src/wallets.mjs";
import { loadWordText } from "../src/words.mjs";
import { createHttpServer } from "../src/server.mjs";

test("sweep leaves only the exact fee", () => {
  assert.equal(sweepLamports(1_080_005_000n), 1_080_000_000n);
  assert.throws(() => sweepLamports(5000n), /Zu wenig SOL/);
});

test("priority fee budget stays the requested lamports", () => {
  const units = 250_000;
  const fee = 400_000n;
  const micro = microLamports(fee, units);
  assert.equal(Math.floor((micro * units) / 1_000_000), Number(fee));
});

test("sol formatting keeps the sign", () => {
  assert.equal(formatSol(1_500_000_000n), "1.5");
  assert.equal(formatSol(-2500n), "-0.0000025");
});

test("vault increase is a mayhem buy", () => {
  const data = Buffer.alloc(72);
  data.writeBigUInt64LE(15n, 64);
  assert.equal(readTokenAmount(data), 15n);
  assert.deepEqual(nextVaultEvent(10n, 15n).side, "buy");
  assert.equal(nextVaultEvent(15n, 12n).side, "sell");
  assert.equal(armVaultWatch(100n, 90n).action, "watch");
  assert.equal(armVaultWatch(100n, 90n).floor, 90n);
  assert.equal(armVaultWatch(100n, 110n).action, "sell");
});

test("words stay in order and fit a cashtag", () => {
  const words = loadWordText("Zebra\na\na\nA\nsupercalifragilistic\nbeta\n");
  assert.deepEqual(words.map((word) => word.symbol), ["ZEBRA", "A", "BETA"]);
});

test("each coin gets an english description and its own links", () => {
  const first = buildCopy("ember", () => 0.1);
  const second = buildCopy("ember", () => 0.9);
  assert.match(first.description, /Ember/);
  assert.equal(first.twitter, "https://x.com/Pumpfun");
  assert.match(first.website, /^https:\/\/example\.com\/ember-/);
  assert.notEqual(first.website, second.website);
  assert.notEqual(first.description, second.description);
});

test("public state never exposes a secret", () => {
  const state = blankState("seed");
  state.position = { phase: "watching", mintPublic: "Mint", mintSecret: "SECRET", word: "aa", symbol: "AA" };
  const view = publicState(state);
  assert.equal(JSON.stringify(view).includes("SECRET"), false);
});

test("the next coin waits until the dump finishes", async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const wallets = [{ id: "seed", publicKey: "SEED", launched: true }];
  const state = blankState("seed");
  let creates = 0;
  const ctx = {
    state,
    wallets,
    wordList: [
      { word: "ash", name: "Ash", symbol: "ASH" },
      { word: "bolt", name: "Bolt", symbol: "BOLT" },
    ],
    signal: new AbortController().signal,
    log() {},
    async save() {},
    async balance() { return 2_000_000_000n; },
    async totalBalance() { return 2_000_000_000n; },
    async recoverHolder() {},
    generateWallet() {
      return { id: "fresh", publicKey: "FRESH", secretKey: "saved-before-send", launched: false };
    },
    async persistWallet(wallet) {
      events.push("persist");
      wallets.push(wallet);
    },
    async gather() { events.push("gather"); },
    async collect() { events.push("collect"); },
    generateMint() { return { publicKey: "MINT", secretKey: "mint-secret" }; },
    buildCopy() {
      return { description: "Ash is a coin.", website: "https://example.com/ash", telegram: "https://example.com/room/ash", twitter: "https://x.com/Pumpfun" };
    },
    async metadata() { return "https://ipfs.io/ipfs/cid"; },
    async createBuy() {
      creates += 1;
      events.push("create");
      return "create-sig";
    },
    async vaultBaseline() { return 10n; },
    async waitForBuy() {
      events.push("watch");
      await gate;
      return "buy";
    },
    async tokenBalance() { return 0n; },
    async sell() {
      events.push("sell");
      return "sell-sig";
    },
    async markLaunched(id) {
      wallets.find((wallet) => wallet.id === id).launched = true;
    },
  };
  const pending = step(ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(creates, 1);
  assert.equal(state.wordIndex, 0);
  assert.equal(state.position.mintSecret, "mint-secret");
  release();
  const result = await pending;
  assert.equal(result.status, "dumped");
  assert.equal(state.wordIndex, 1);
  assert.equal(state.position, null);
  assert.deepEqual(events.filter((event) => ["persist", "gather", "create", "sell"].includes(event)), ["persist", "gather", "create", "sell", "gather"]);
});

test("a key library cannot drop a stored key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mayhem-"));
  const file = path.join(dir, "wallets.jsonl");
  await appendWalletRecord(file, { id: "a", publicKey: "A", secretKey: "secret-a", launched: false, role: "creator" });
  await assert.rejects(
    writeWalletLibrary(file, [{ id: "a", publicKey: "A", secretKey: "other", launched: true, role: "creator" }]),
    /verlieren/,
  );
  await assert.rejects(writeWalletLibrary(file, []), /verlieren/);
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /secret-a/);
});

test("a sell without a signature does not advance the word", async () => {
  const wallets = [{ id: "holder", publicKey: "HOLDER", launched: true }];
  const state = blankState("holder");
  state.position = {
    phase: "watching",
    walletId: "holder",
    mintPublic: "MINT",
    word: "ash",
    symbol: "ASH",
    baseline: "10",
    startBalance: "1000",
    createSig: "create",
  };
  await assert.rejects(step({
    state,
    wallets,
    wordList: [{ word: "ash", name: "Ash", symbol: "ASH" }],
    signal: new AbortController().signal,
    log() {},
    async save() {},
    async balance() { return 1_000n; },
    async waitForBuy() { return "buy"; },
    async sell() { return null; },
    async tokenBalance() { return 0n; },
    async collect() {},
    async markLaunched() {},
  }), /Signatur/);
  assert.equal(state.wordIndex, 0);
  assert.equal(state.position.phase, "selling");
});

test("a short balance still gathers onto the holder", async () => {
  const events = [];
  const wallets = [{ id: "seed", publicKey: "SEED", launched: true }];
  const state = blankState("seed");
  const result = await step({
    state,
    wallets,
    wordList: [{ word: "ash", name: "Ash", symbol: "ASH" }],
    log() {},
    async save() {},
    async balance() { return 10n; },
    async totalBalance() { return 10n; },
    async recoverHolder() {},
    generateWallet() {
      throw new Error("kein neues Wallet bei zu wenig SOL");
    },
    async gather() { events.push("gather"); },
  });
  assert.equal(result.status, "low-balance");
  assert.deepEqual(events, ["gather"]);
  assert.equal(state.position, null);
});

test("railway without a volume cannot start", () => {
  const status = configStatus(loadConfig({
    RAILWAY_ENVIRONMENT: "production",
    PRIVATE_KEY: "x".repeat(20),
    PINATA_JWT: "jwt",
    SOLANA_RPC_URL: "https://rpc.example",
    DASHBOARD_PASSWORD: "long-password",
  }));
  assert.equal(status.ready, false);
  assert.match(status.blockers.join(" "), /Volume/);
});

test("the dashboard password protects the api", async () => {
  const auth = createAuth("correct-horse");
  assert.equal(auth.login("nope"), null);
  const token = auth.login("correct-horse");
  assert.equal(auth.check(token), true);
  const server = createHttpServer({
    config: { password: "correct-horse" },
    auth,
    runtime: {
      wallets: [],
      async holderBalance() { return null; },
      async snapshot() {
        return { running: false, wordIndex: 0, wordCount: 1, blockers: [], warnings: [], totals: { dumps: 0, profitLamports: "0" }, position: null, log: [] };
      },
      async start() {},
      async stop() {},
      sellNow() { return false; },
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const denied = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(denied.status, 401);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct-horse" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const allowed = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie } });
  assert.equal(allowed.status, 200);
  server.close();
});
