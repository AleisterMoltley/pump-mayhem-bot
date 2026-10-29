import { MIN_BALANCE_LAMPORTS, TRANSFER_FEE, pnlLamports } from "./money.mjs";
import { wordAt } from "./words.mjs";

function walletById(ctx, id) {
  const wallet = ctx.wallets.find((entry) => entry.id === id);
  if (!wallet) throw new Error("Wallet aus der Runde fehlt in der Key-Bibliothek");
  return wallet;
}

function rememberRound(state, position, profit) {
  state.rounds.unshift({
    word: position.word,
    symbol: position.symbol,
    mint: position.mintPublic,
    pnlLamports: profit.toString(),
    createSig: position.createSig,
    sellSig: position.sellSig || null,
    at: new Date().toISOString(),
  });
  state.rounds = state.rounds.slice(0, 40);
  state.totals.dumps += 1;
  state.totals.profitLamports = (BigInt(state.totals.profitLamports) + profit).toString();
}

async function dumpPosition(ctx) {
  const position = ctx.state.position;
  const wallet = walletById(ctx, position.walletId);
  position.phase = "watching";
  await ctx.save();
  const manual = ctx.pendingSell?.();
  ctx.log(manual ? `Verkaufe ${position.word} sofort` : `Warte auf den ersten Mayhem-Kauf für ${position.word}`);
  const reason = manual ? "manual" : await ctx.waitForBuy({
    mintPublic: position.mintPublic,
    baseline: BigInt(position.baseline),
    signal: ctx.signal,
  });
  position.phase = "selling";
  position.sellReason = reason;
  await ctx.save();
  ctx.log(reason === "manual" ? `Manueller Verkauf von ${position.word}` : `Mayhem hat ${position.word} gekauft, verkaufe sofort`);
  const sellSig = await ctx.sell({ wallet, mintPublic: position.mintPublic });
  if (!sellSig) throw new Error("Verkauf ohne Signatur");
  position.sellSig = sellSig;
  const left = BigInt(await ctx.tokenBalance(wallet.publicKey, position.mintPublic));
  if (left > 0n) throw new Error(`Verkauf unvollständig, Rest ${left} Basiseinheiten`);
  position.phase = "collecting";
  await ctx.save();
  await ctx.collect(wallet);
  if (ctx.reclaim) await ctx.reclaim(wallet, position.mintPublic);
  if (ctx.gather) await ctx.gather(wallet);
  const endBalance = BigInt(await ctx.balance(wallet.publicKey));
  const profit = pnlLamports(position.startBalance, endBalance);
  wallet.launched = true;
  await ctx.markLaunched(wallet.id);
  rememberRound(ctx.state, position, profit);
  ctx.state.wordIndex += 1;
  ctx.state.position = null;
  ctx.state.currentWalletId = wallet.id;
  await ctx.save();
  ctx.log(`Dump fertig: ${position.word} ${profit >= 0n ? "+" : ""}${profit} Lamports`);
  return { status: "dumped", word: position.word, profitLamports: profit.toString() };
}

async function openPosition(ctx, wallet, word) {
  const mint = ctx.generateMint();
  const startBalance = BigInt(await ctx.balance(wallet.publicKey));
  if (startBalance < MIN_BALANCE_LAMPORTS) {
    return { status: "low-balance", balance: startBalance.toString() };
  }
  const copy = ctx.buildCopy(word.word);
  const uri = await ctx.metadata({ ...word, ...copy });
  ctx.state.position = {
    phase: "creating",
    walletId: wallet.id,
    mintPublic: mint.publicKey,
    mintSecret: mint.secretKey,
    word: word.word,
    name: word.name,
    symbol: word.symbol,
    uri,
    description: copy.description,
    website: copy.website,
    telegram: copy.telegram,
    twitter: copy.twitter,
    startedAt: new Date().toISOString(),
    startBalance: startBalance.toString(),
    createSig: null,
    baseline: null,
    sellSig: null,
  };
  await ctx.save();
  ctx.log(`Deploy ${word.name} ($${word.symbol}) von ${wallet.publicKey}`);
  const createSig = await ctx.createBuy({ wallet, mint, word, uri });
  ctx.state.position.createSig = createSig;
  ctx.state.position.baseline = (await ctx.vaultBaseline(mint.publicKey)).toString();
  ctx.state.position.phase = "watching";
  await ctx.save();
  return dumpPosition(ctx);
}

async function resumeCreate(ctx) {
  const position = ctx.state.position;
  const wallet = walletById(ctx, position.walletId);
  const mint = { publicKey: position.mintPublic, secretKey: position.mintSecret };
  const exists = await ctx.mintExists(position.mintPublic);
  if (!exists && position.createSig && ctx.confirmSig) {
    const status = await ctx.confirmSig(position.createSig);
    if (status === "ok") {
      position.baseline = (await ctx.vaultBaseline(position.mintPublic)).toString();
      position.phase = "watching";
      await ctx.save();
      return dumpPosition(ctx);
    }
    if (status === "pending") throw new Error("Create-Transaktion ist noch unterwegs");
  }
  if (!exists) {
    const word = { word: position.word, name: position.name, symbol: position.symbol };
    const uri = position.uri || (await ctx.metadata({ ...word, ...ctx.buildCopy(word.word) }));
    position.uri = uri;
    await ctx.save();
    position.createSig = await ctx.createBuy({ wallet, mint, word, uri });
  }
  position.baseline = (await ctx.vaultBaseline(position.mintPublic)).toString();
  position.phase = "watching";
  await ctx.save();
  return dumpPosition(ctx);
}

async function launch(ctx) {
  const word = wordAt(ctx.wordList, ctx.state.wordIndex);
  if (!word) return { status: "wordlist-done" };
  if (ctx.recoverHolder) await ctx.recoverHolder();
  let holder = walletById(ctx, ctx.state.currentWalletId);
  const needed = holder.launched ? MIN_BALANCE_LAMPORTS + TRANSFER_FEE : MIN_BALANCE_LAMPORTS;
  let total = BigInt(ctx.totalBalance ? await ctx.totalBalance() : await ctx.balance(holder.publicKey));
  if (total < needed && ctx.gather) {
    await ctx.gather(holder);
    total = BigInt(await ctx.balance(holder.publicKey));
  }
  if (total < needed) return { status: "low-balance", balance: total.toString() };
  if (holder.launched) {
    const fresh = ctx.generateWallet();
    await ctx.persistWallet(fresh);
    ctx.log(`Neues Wallet ${fresh.publicKey}. Creator-Fee einziehen, ganzes SOL auf dieses Wallet.`);
    await ctx.gather(fresh);
    fresh.launched = false;
    ctx.state.currentWalletId = fresh.id;
    await ctx.save();
    holder = fresh;
  } else {
    await ctx.gather(holder);
  }
  return openPosition(ctx, holder, word);
}

export async function step(ctx) {
  const position = ctx.state.position;
  if (!position) return launch(ctx);
  if (position.phase === "creating") return resumeCreate(ctx);
  if (position.phase === "watching" || position.phase === "selling" || position.phase === "collecting") {
    if (position.phase === "selling" || position.phase === "collecting") {
      const wallet = walletById(ctx, position.walletId);
      const left = BigInt(await ctx.tokenBalance(wallet.publicKey, position.mintPublic));
      if (left > 0n) {
        position.phase = "selling";
        await ctx.save();
        const sellSig = await ctx.sell({ wallet, mintPublic: position.mintPublic });
        if (!sellSig) throw new Error("Verkauf ohne Signatur");
        position.sellSig = sellSig;
        const remain = BigInt(await ctx.tokenBalance(wallet.publicKey, position.mintPublic));
        if (remain > 0n) throw new Error(`Verkauf unvollständig, Rest ${remain} Basiseinheiten`);
      }
      await ctx.collect(wallet);
      if (ctx.reclaim) await ctx.reclaim(wallet, position.mintPublic);
      if (ctx.gather) await ctx.gather(wallet);
      const endBalance = BigInt(await ctx.balance(wallet.publicKey));
      const profit = pnlLamports(position.startBalance, endBalance);
      wallet.launched = true;
      await ctx.markLaunched(wallet.id);
      rememberRound(ctx.state, position, profit);
      ctx.state.wordIndex += 1;
      ctx.state.position = null;
      ctx.state.currentWalletId = wallet.id;
      await ctx.save();
      return { status: "dumped", word: position.word, profitLamports: profit.toString() };
    }
    return dumpPosition(ctx);
  }
  throw new Error(`Unbekannte Phase ${position.phase}`);
}

export function blankState(walletId) {
  return {
    running: false,
    wordIndex: 0,
    currentWalletId: walletId,
    solWalletIds: walletId ? [walletId] : [],
    feeWalletIds: [],
    position: null,
    rounds: [],
    totals: { dumps: 0, profitLamports: "0" },
    log: [],
  };
}

export function publicState(state, extra = {}) {
  const position = state.position
    ? {
        phase: state.position.phase,
        mint: state.position.mintPublic,
        word: state.position.word,
        symbol: state.position.symbol,
        createSig: state.position.createSig,
        sellSig: state.position.sellSig,
        website: state.position.website,
        telegram: state.position.telegram,
        twitter: state.position.twitter,
        description: state.position.description,
        startedAt: state.position.startedAt,
        sellReason: state.position.sellReason || null,
      }
    : null;
  return {
    running: state.running,
    wordIndex: state.wordIndex,
    currentWalletId: state.currentWalletId,
    position,
    rounds: state.rounds,
    totals: state.totals,
    log: state.log,
    ...extra,
  };
}
