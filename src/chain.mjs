import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  bondingCurvePda,
  creatorVaultPda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  getSolVaultPda,
  getTokenVaultPda,
  OnlinePumpSdk,
  PUMP_SDK,
} from "@pump-fun/pump-sdk";
import {
  CREATE_PRIORITY_LAMPORTS,
  CREATE_SLIPPAGE_PERCENT,
  COLLECT_COMPUTE_UNITS,
  CREATOR_VAULT_RENT,
  DEV_BUY_LAMPORTS,
  SELL_COMPUTE_UNITS,
  SELL_PRIORITY_LAMPORTS,
  SELL_SLIPPAGE_PERCENT,
  microLamports,
  sweepLamports,
} from "./money.mjs";
import { keypairFromRecord } from "./wallets.mjs";
import { readTokenAmount, tokenAmountFromMeta } from "./vault.mjs";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

export function rpcConnection(rpcUrl) {
  const wsEndpoint = rpcUrl.replace(/^http/, "ws");
  return new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint });
}

function budget(units, feeLamports) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamports(feeLamports, units) }),
  ];
}

export async function sendInstructions(connection, payer, instructions, extraSigners = [], options = {}) {
  const priority = options.priority !== false;
  const all = priority
    ? [...budget(options.computeUnits, options.priorityLamports), ...instructions]
    : instructions;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: all,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer, ...extraSigners]);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: Boolean(options.skipPreflight),
    maxRetries: 3,
  });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) {
    throw new Error(`Transaktion ${signature} fehlgeschlagen: ${JSON.stringify(result.value.err)}`);
  }
  return signature;
}

export async function sweepAll(connection, fromRecord, toRecord) {
  const from = keypairFromRecord(fromRecord);
  const to = new PublicKey(toRecord.publicKey);
  const balance = BigInt(await connection.getBalance(from.publicKey, "confirmed"));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const probe = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: 1 }),
    ],
  }).compileToV0Message();
  const quoted = await connection.getFeeForMessage(probe, "confirmed");
  const fee = BigInt(quoted?.value ?? 5000);
  const lamports = sweepLamports(balance, fee);
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("SOL-Betrag ist zu groß für einen Transfer");
  const message = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to,
        lamports: Number(lamports),
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([from]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`Sweep ${signature} fehlgeschlagen`);
  return signature;
}

export function candidateVaults(mint) {
  const mintKey = new PublicKey(mint);
  const vaults = [getTokenVaultPda(mintKey), getAssociatedTokenAddressSync(mintKey, getSolVaultPda(), true, TOKEN_2022_PROGRAM_ID)];
  return vaults.filter((key, index) => vaults.findIndex((other) => other.equals(key)) === index);
}

export async function resolveAgentVault(connection, mint) {
  const vaults = candidateVaults(mint);
  const infos = await connection.getMultipleAccountsInfo(vaults, "confirmed");
  for (let index = 0; index < vaults.length; index += 1) {
    if (infos[index]) return vaults[index];
  }
  return vaults[0];
}

export async function readVaultAmount(connection, vault) {
  const info = await connection.getAccountInfo(vault, "processed");
  if (!info) return 0n;
  return readTokenAmount(info.data) ?? 0n;
}

export async function vaultBaseline(connection, mint) {
  const vault = await resolveAgentVault(connection, mint);
  const owner = getSolVaultPda().toBase58();
  const signatures = await connection.getSignaturesForAddress(vault, { limit: 30 }, "confirmed");
  const oldest = signatures.at(-1);
  if (oldest) {
    const tx = await connection.getTransaction(oldest.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const amount = tokenAmountFromMeta(tx?.meta?.postTokenBalances, mint, owner);
    if (amount != null) return amount;
  }
  return readVaultAmount(connection, vault);
}

export function waitForBuy(connection, vault, baseline, signal) {
  let last = BigInt(baseline);
  return new Promise((resolve, reject) => {
    let subscription = null;
    let timer = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearInterval(timer);
      if (subscription != null) connection.removeAccountChangeListener(subscription).catch(() => {});
    };
    let checking = false;
    const consider = (amount) => {
      if (amount == null || settled) return;
      if (amount <= last) {
        last = amount;
        return;
      }
      if (checking) return;
      checking = true;
      connection.getAccountInfo(vault, "confirmed").then((info) => {
        checking = false;
        if (settled) return;
        const again = info ? readTokenAmount(info.data) : null;
        if (again != null && again > last) finish("buy");
        else if (again != null && again < last) last = again;
      }).catch(() => {
        checking = false;
      });
    };
    const onAbort = () => finish("manual");
    if (signal?.aborted) {
      finish("manual");
      return;
    }
    signal?.addEventListener("abort", onAbort);
    try {
      subscription = connection.onAccountChange(vault, (info) => consider(readTokenAmount(info.data)), "processed");
    } catch (error) {
      fail(error);
      return;
    }
    timer = setInterval(() => {
      connection.getAccountInfo(vault, "processed").then((info) => {
        if (info) consider(readTokenAmount(info.data));
      }).catch(() => {});
    }, 400);
  });
}

async function quoteGlobals(online) {
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  if (!global.mayhemModeEnabled) {
    const error = new Error("Mayhem Mode ist on-chain ausgeschaltet");
    error.code = "MAYHEM_OFF";
    throw error;
  }
  return { global, feeConfig };
}

async function quotedBuyAmount(connection, global, feeConfig, mintKey, quoteAmount) {
  const info = await connection.getAccountInfo(bondingCurvePda(mintKey), "confirmed");
  if (!info) {
    return getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: null,
      amount: quoteAmount,
      quoteMint: NATIVE_MINT,
    });
  }
  const bondingCurve = PUMP_SDK.decodeBondingCurve(info);
  return getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: bondingCurve.tokenTotalSupply,
    bondingCurve,
    amount: quoteAmount,
    quoteMint: NATIVE_MINT,
  });
}

export async function createMayhemCoin(connection, online, { wallet, mint, word, uri }) {
  const user = keypairFromRecord(wallet);
  const mintKey = keypairFromRecord({ secretKey: mint.secretKey, publicKey: mint.publicKey });
  const { global, feeConfig } = await quoteGlobals(online);
  const quoteAmount = new BN(DEV_BUY_LAMPORTS.toString());
  const existing = await connection.getAccountInfo(mintKey.publicKey, "confirmed");
  if (!existing) {
    const createIx = await PUMP_SDK.createV2Instruction({
      mint: mintKey.publicKey,
      name: word.name,
      symbol: word.symbol,
      uri,
      creator: user.publicKey,
      user: user.publicKey,
      mayhemMode: true,
    });
    await sendInstructions(connection, user, [createIx], [mintKey], {
      computeUnits: 400_000,
      priorityLamports: CREATE_PRIORITY_LAMPORTS,
      skipPreflight: false,
    });
  }
  const held = await tokenBalance(connection, user.publicKey.toBase58(), mintKey.publicKey.toBase58());
  if (held > 0n) return "bereits-gekauft";
  const amount = await quotedBuyAmount(connection, global, feeConfig, mintKey.publicKey, quoteAmount);
  const associatedUser = getAssociatedTokenAddressSync(mintKey.publicKey, user.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const buyIx = await PUMP_SDK.buyV2Instruction({
    global,
    mint: mintKey.publicKey,
    creator: user.publicKey,
    user: user.publicKey,
    associatedUser,
    amount,
    quoteAmount,
    slippage: CREATE_SLIPPAGE_PERCENT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    mayhemMode: true,
  });
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    user.publicKey,
    associatedUser,
    user.publicKey,
    mintKey.publicKey,
    TOKEN_2022_PROGRAM_ID,
  );
  return sendInstructions(connection, user, [ataIx, buyIx], [], {
    computeUnits: 400_000,
    priorityLamports: CREATE_PRIORITY_LAMPORTS,
    skipPreflight: false,
  });
}

export async function sellAll(connection, online, { wallet, mintPublic }) {
  const user = keypairFromRecord(wallet);
  const mintKey = new PublicKey(mintPublic);
  const ata = getAssociatedTokenAddressSync(mintKey, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
  let amount;
  try {
    const balance = await connection.getTokenAccountBalance(ata, "processed");
    amount = new BN(balance.value.amount);
  } catch (error) {
    if (String(error.message || error).toLowerCase().includes("could not find")) {
      throw new Error("Tokenkonto ist noch nicht lesbar");
    }
    throw error;
  }
  if (amount.isZero()) throw new Error("Tokenbestand ist leer");
  const [global, feeConfig, sellState] = await Promise.all([
    online.fetchGlobal(),
    online.fetchFeeConfig(),
    online.fetchSellState(mintKey, user.publicKey, TOKEN_2022_PROGRAM_ID),
  ]);
  const quoteAmount = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: sellState.bondingCurve.tokenTotalSupply,
    bondingCurve: sellState.bondingCurve,
    amount,
    quoteTransferFee: sellState.quoteTransferFee,
  });
  const instructions = await PUMP_SDK.sellV2Instructions({
    global,
    bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
    bondingCurve: sellState.bondingCurve,
    mint: mintKey,
    user: user.publicKey,
    amount,
    quoteAmount,
    slippage: SELL_SLIPPAGE_PERCENT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: sellState.quoteTokenProgram,
  });
  const creator = sellState.bondingCurve.creator;
  const sweep = await PUMP_SDK.sweepCreatorFeeInstruction({
    payer: user.publicKey,
    mint: mintKey,
    creator,
    quoteMint: sellState.quoteMint,
    quoteTokenProgram: sellState.quoteTokenProgram,
  });
  return sendInstructions(connection, user, [...instructions, sweep], [], {
    computeUnits: SELL_COMPUTE_UNITS + 80_000,
    priorityLamports: SELL_PRIORITY_LAMPORTS,
    skipPreflight: true,
  });
}

export async function creatorVaultBalance(connection, wallet) {
  const owner = keypairFromRecord(wallet).publicKey;
  const info = await connection.getAccountInfo(creatorVaultPda(owner), "confirmed");
  return BigInt(info?.lamports || 0);
}

export async function pullCreatorFee(connection, online, wallet) {
  const parked = await creatorVaultBalance(connection, wallet);
  if (parked <= CREATOR_VAULT_RENT) return null;
  return collectCreatorFees(connection, online, wallet);
}

function userVolumeAccumulatorPda(user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
}

export async function tokenBalance(connection, owner, mint) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, TOKEN_2022_PROGRAM_ID);
  let seen = 0n;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const balance = await connection.getTokenAccountBalance(ata, "confirmed");
      seen = BigInt(balance.value.amount);
      if (seen > 0n) return seen;
    } catch (error) {
      if (!String(error.message || error).toLowerCase().includes("could not find")) throw error;
      seen = 0n;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return seen;
}

export async function reclaimRent(connection, wallet, mint) {
  const user = keypairFromRecord(wallet);
  const mintKey = new PublicKey(mint);
  const instructions = [];
  const ata = getAssociatedTokenAddressSync(mintKey, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const ataInfo = await connection.getAccountInfo(ata, "confirmed");
  if (ataInfo && readTokenAmount(ataInfo.data) === 0n) {
    instructions.push(createCloseAccountInstruction(
      ata,
      user.publicKey,
      user.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID,
    ));
  }
  const volume = userVolumeAccumulatorPda(user.publicKey);
  const volumeInfo = await connection.getAccountInfo(volume, "confirmed");
  if (volumeInfo) instructions.push(await PUMP_SDK.closeUserVolumeAccumulator(user.publicKey));
  if (!instructions.length) return null;
  return sendInstructions(connection, user, instructions, [], {
    computeUnits: 80_000,
    priorityLamports: 0n,
    skipPreflight: false,
  });
}

export async function collectCreatorFees(connection, online, wallet) {
  const user = keypairFromRecord(wallet);
  const instructions = await online.collectCoinCreatorFeeInstructions(user.publicKey);
  if (!instructions?.length) return null;
  return sendInstructions(connection, user, instructions, [], {
    computeUnits: COLLECT_COMPUTE_UNITS,
    priorityLamports: 50_000n,
    skipPreflight: true,
  });
}

export function createOnline(connection) {
  return new OnlinePumpSdk(connection);
}

export async function confirmSignature(connection, signature) {
  const status = await connection.getSignatureStatuses([signature]);
  const value = status.value[0];
  if (!value) return "pending";
  if (value.err) return "err";
  return "ok";
}

export async function walletsWithCreatorFees(connection, wallets) {
  const owed = [];
  const pdas = wallets.map((wallet) => creatorVaultPda(new PublicKey(wallet.publicKey)));
  for (let offset = 0; offset < pdas.length; offset += 100) {
    const slice = pdas.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(slice, "confirmed");
    infos.forEach((info, index) => {
      if (BigInt(info?.lamports || 0) > CREATOR_VAULT_RENT) owed.push(wallets[offset + index].id);
    });
  }
  return owed;
}

export async function fundedWallets(connection, wallets) {
  const funded = [];
  const keys = wallets.map((wallet) => new PublicKey(wallet.publicKey));
  for (let offset = 0; offset < keys.length; offset += 100) {
    const slice = keys.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(slice, "confirmed");
    infos.forEach((info, index) => {
      const lamports = BigInt(info?.lamports || 0);
      if (lamports > 0n) funded.push({ id: wallets[offset + index].id, lamports });
    });
  }
  funded.sort((a, b) => (a.lamports > b.lamports ? -1 : 1));
  return funded;
}
