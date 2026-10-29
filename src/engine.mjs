import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configStatus } from "./config.mjs";
import { buildCopy } from "./copy.mjs";
import {
  collectCreatorFees,
  confirmSignature,
  createMayhemCoin,
  createOnline,
  creatorVaultBalance,
  fundedWallets,
  readVaultAmount,
  resolveAgentVault,
  rpcConnection,
  reclaimRent,
  sellAll,
  sweepAll,
  tokenBalance,
  vaultBaseline,
  waitForBuy,
  walletsWithCreatorFees,
} from "./chain.mjs";
import { loadImageCid, metadataDocument, pinFile, pinJson, saveImageCid } from "./pinata.mjs";
import { CREATOR_VAULT_RENT } from "./money.mjs";
import { blankState, publicState, step } from "./round.mjs";
import { pushLog, readState, runtimePaths, writeState } from "./store.mjs";
import { armVaultWatch, readTokenAmount } from "./vault.mjs";
import { loadWordList } from "./words.mjs";
import {
  appendWalletRecord,
  keypairFromSecret,
  newWalletRecord,
  readWalletLibrary,
  walletRecordFromKeypair,
  writeWalletLibrary,
} from "./wallets.mjs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { encodeSecret } from "./wallets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posterPath = path.join(root, "assets", "boycott.png");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createEngine(config) {
  const status = configStatus(config);
  const paths = runtimePaths(config.dataDir);
  const wordList = loadWordList();
  let wallets = await readWalletLibrary(paths.wallets);
  const savedState = await readState(paths.state);
  const hadState = Boolean(savedState);
  let state = savedState;
  const connection = config.rpc ? rpcConnection(config.rpc) : null;
  const online = connection ? createOnline(connection) : null;
  let running = false;
  let loopPromise = null;
  let sellController = null;
  let forceSell = false;
  let imageCid = null;

  if (config.privateKey) {
    const seedKey = keypairFromSecret(config.privateKey);
    const existing = wallets.find((wallet) => wallet.publicKey === seedKey.publicKey.toBase58());
    if (!existing) {
      const record = walletRecordFromKeypair(seedKey, { role: "seed", launched: true });
      await appendWalletRecord(paths.wallets, record);
      wallets.push(record);
    } else if (!existing.launched && existing.role !== "creator") {
      existing.launched = true;
      existing.role = existing.role || "seed";
      await writeWalletLibrary(paths.wallets, wallets);
    }
  }

  if (!state) {
    const seed = wallets.find((wallet) => wallet.role === "seed") || wallets[0];
    state = blankState(seed?.id || null);
  }
  if (!Array.isArray(state.log)) state.log = [];
  if (!state.totals) state.totals = { dumps: 0, profitLamports: "0" };
  if (!Array.isArray(state.rounds)) state.rounds = [];

  function log(message) {
    pushLog(state, message);
    console.log(message);
  }

  async function save() {
    await writeState(paths.state, state);
  }

  async function refreshHolder() {
    if (!connection || wallets.length === 0) return;
    if (!Array.isArray(state.solWalletIds)) {
      state.solWalletIds = state.currentWalletId ? [state.currentWalletId] : [];
    }
    if (!Array.isArray(state.feeWalletIds)) {
      const candidates = wallets.filter((wallet) => wallet.launched && wallet.role !== "seed");
      try {
        state.feeWalletIds = candidates.length ? await walletsWithCreatorFees(connection, candidates) : [];
        await save();
      } catch (error) {
        state.feeWalletIds = candidates.map((wallet) => wallet.id);
        log(`Creator-Vaults konnten nicht gelesen werden: ${error.message}`);
      }
    }
    if (state.position) {
      state.currentWalletId = state.position.walletId;
      return;
    }
    try {
      const funded = await fundedWallets(connection, wallets);
      if (funded.length) {
        state.currentWalletId = funded[0].id;
        state.solWalletIds = funded.map((entry) => entry.id);
      }
    } catch (error) {
      log(`Kontostand konnte nicht gelesen werden: ${error.message}`);
    }
  }

  async function imageUri() {
    if (imageCid) return `https://ipfs.io/ipfs/${imageCid}`;
    imageCid = await loadImageCid(paths.imageCid);
    if (!imageCid) {
      const bytes = await fs.readFile(posterPath);
      imageCid = await pinFile(config.pinataJwt, bytes, "boycott-pumpfun.png");
      await saveImageCid(paths.imageCid, imageCid);
      log("Bild einmalig auf Pinata gelegt");
    }
    return `https://ipfs.io/ipfs/${imageCid}`;
  }

  async function metadata(input) {
    const image = await imageUri();
    return pinJson(config.pinataJwt, metadataDocument({
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      image,
      website: input.website,
      telegram: input.telegram,
      twitter: input.twitter,
    }));
  }

  function armSignal() {
    sellController = new AbortController();
    return sellController.signal;
  }

  function rememberFeeWallet(id, owes) {
    const next = new Set(state.feeWalletIds || []);
    if (owes) next.add(id);
    else next.delete(id);
    state.feeWalletIds = [...next];
  }

  async function collectWallet(wallet) {
    let owes = true;
    try {
      const parked = await creatorVaultBalance(connection, wallet);
      if (parked > CREATOR_VAULT_RENT) {
        const signature = await collectCreatorFees(connection, online, wallet);
        if (signature) log(`Creator-Fee auf ${wallet.publicKey} gezogen`);
        const left = await creatorVaultBalance(connection, wallet);
        owes = left > CREATOR_VAULT_RENT;
      } else {
        owes = false;
      }
    } catch (error) {
      log(`Creator-Fee noch nicht abgeholt: ${error.message}`);
      owes = true;
    }
    rememberFeeWallet(wallet.id, owes);
    return owes;
  }

  function ctx() {
    return {
      state,
      wallets,
      wordList,
      signal: armSignal(),
      pendingSell: () => forceSell,
      log,
      save,
      async balance(publicKey) {
        return BigInt(await connection.getBalance(new PublicKey(publicKey), "confirmed"));
      },
      generateWallet() {
        return newWalletRecord();
      },
      async persistWallet(record) {
        await appendWalletRecord(paths.wallets, record);
        wallets.push(record);
      },
      async sweep(from, to) {
        await sweepAll(connection, from, to);
      },
      async collect(wallet) {
        return collectWallet(wallet);
      },
      async gather(target) {
        const sourceIds = [...new Set([...(state.solWalletIds || []), ...(state.feeWalletIds || []), target.id])];
        const pending = new Set(sourceIds);
        try {
          for (const id of sourceIds) {
            if (id === target.id) continue;
            const wallet = wallets.find((entry) => entry.id === id);
            if (!wallet) {
              pending.delete(id);
              continue;
            }
            await collectWallet(wallet);
            const lamports = BigInt(await connection.getBalance(new PublicKey(wallet.publicKey), "confirmed"));
            if (lamports > 5_000n) await sweepAll(connection, wallet, target);
            pending.delete(id);
          }
          await collectWallet(target);
        } finally {
          state.solWalletIds = [...pending];
          await save();
        }
      },
      async totalBalance() {
        const ids = new Set([...(state.solWalletIds || []), ...(state.feeWalletIds || [])]);
        if (state.currentWalletId) ids.add(state.currentWalletId);
        let total = 0n;
        const seen = new Set();
        for (const id of ids) {
          const wallet = wallets.find((entry) => entry.id === id);
          if (!wallet || seen.has(wallet.publicKey)) continue;
          seen.add(wallet.publicKey);
          total += BigInt(await connection.getBalance(new PublicKey(wallet.publicKey), "confirmed"));
          try {
            const parked = await creatorVaultBalance(connection, wallet);
            if (parked > CREATOR_VAULT_RENT) total += parked - CREATOR_VAULT_RENT;
          } catch {
            // Ungelesener Vault zählt nicht als verfügbares SOL.
          }
        }
        return total;
      },
      generateMint() {
        const mint = Keypair.generate();
        return { publicKey: mint.publicKey.toBase58(), secretKey: encodeSecret(mint.secretKey) };
      },
      buildCopy,
      metadata,
      async createBuy(input) {
        return createMayhemCoin(connection, online, input);
      },
      async mintExists(mint) {
        const info = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
        return Boolean(info);
      },
      async confirmSig(signature) {
        return confirmSignature(connection, signature);
      },
      async vaultBaseline(mint) {
        return vaultBaseline(connection, mint);
      },
      async waitForBuy({ mintPublic, baseline, signal }) {
        const vault = await resolveAgentVault(connection, mintPublic);
        const current = await readVaultAmount(connection, vault);
        const armed = armVaultWatch(baseline, current);
        if (armed.action === "sell") {
          const info = await connection.getAccountInfo(vault, "confirmed");
          const again = info ? readTokenAmount(info.data) : 0n;
          if (again > BigInt(baseline)) return "buy";
          return waitForBuy(connection, vault, again ?? 0n, signal);
        }
        return waitForBuy(connection, vault, armed.floor, signal);
      },
      async reclaim(wallet, mint) {
        try {
          const signature = await reclaimRent(connection, wallet, mint);
          if (signature) log(`Kontomiete zurück auf ${wallet.publicKey}`);
        } catch (error) {
          log(`Kontomiete bleibt liegen: ${error.message}`);
        }
      },
      async tokenBalance(owner, mint) {
        return tokenBalance(connection, owner, mint);
      },
      async sell(input) {
        return sellAll(connection, online, input);
      },
      async markLaunched(id) {
        const wallet = wallets.find((entry) => entry.id === id);
        if (!wallet) return;
        wallet.launched = true;
        await writeWalletLibrary(paths.wallets, wallets);
      },
    };
  }

  function ensureLoop() {
    if (!loopPromise) loopPromise = loop().finally(() => {
      loopPromise = null;
    });
    return loopPromise;
  }

  async function tick() {
    if (!status.ready) throw new Error(status.blockers.join(" "));
    if (!state.position) forceSell = false;
    return step(ctx());
  }

  async function loop() {
    await refreshHolder();
    while (running || state.position) {
      if (!running && !state.position) break;
      try {
        const result = await tick();
        if (result.status === "low-balance") {
          log(`Zu wenig SOL für 1 SOL Dev-Buy plus Gebühren. Stand ${result.balance} Lamports.`);
          await sleep(15_000);
          continue;
        }
        if (result.status === "wordlist-done") {
          log("Wörterliste ist durch. Bot stoppt.");
          running = false;
          state.running = false;
          await save();
          break;
        }
      } catch (error) {
        log(error.message || String(error));
        if (error.code === "MAYHEM_OFF") {
          running = false;
          state.running = false;
          await save();
          break;
        }
        await sleep(4_000);
      }
    }
  }

  return {
    async start() {
      const current = configStatus(config);
      if (!current.ready) throw new Error(current.blockers.join(" "));
      if (running) return;
      running = true;
      state.running = true;
      await save();
      log("Bot läuft. Ein Coin nach dem anderen.");
      ensureLoop();
    },
    async stop() {
      running = false;
      state.running = false;
      await save();
      log(state.position ? "Stopp nach dem offenen Coin. Der Dump läuft noch zu Ende." : "Bot gestoppt.");
    },
    sellNow() {
      if (!state.position) return false;
      forceSell = true;
      sellController?.abort();
      log("Manueller Verkauf angefordert.");
      return true;
    },
    async snapshot(balanceLamports = null) {
      const view = publicState(state, {
        warnings: status.warnings,
        blockers: status.blockers,
        ready: status.ready,
        wordCount: wordList.length,
        devBuySol: "1",
        balanceLamports: balanceLamports == null ? null : balanceLamports.toString(),
        holder: wallets.find((wallet) => wallet.id === state.currentWalletId)?.publicKey || null,
      });
      return view;
    },
    wallets,
    async holderBalance() {
      if (!connection || !state.currentWalletId) return null;
      const wallet = wallets.find((entry) => entry.id === state.currentWalletId);
      if (!wallet) return null;
      return BigInt(await connection.getBalance(new PublicKey(wallet.publicKey), "confirmed"));
    },
    async boot() {
      if (!status.ready) {
        log(`Nicht startklar: ${status.blockers.join(" ")}`);
        return;
      }
      if (state.position && !state.running) {
        log("Offene Position wird zu Ende gebracht.");
        ensureLoop();
        return;
      }
      if (state.running || (!hadState && config.autostart)) await this.start();
    },
  };
}
