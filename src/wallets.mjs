import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

export function encodeSecret(secretKey) {
  return bs58.encode(secretKey);
}

export function keypairFromSecret(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("PRIVATE_KEY fehlt");
  const bytes = text.startsWith("[")
    ? Uint8Array.from(JSON.parse(text))
    : bs58.decode(text);
  if (bytes.length !== 64) throw new Error("PRIVATE_KEY muss 64 Bytes sein");
  return Keypair.fromSecretKey(bytes);
}

export function walletRecordFromKeypair(keypair, extra = {}) {
  return {
    id: extra.id || randomUUID(),
    publicKey: keypair.publicKey.toBase58(),
    secretKey: encodeSecret(keypair.secretKey),
    createdAt: extra.createdAt || new Date().toISOString(),
    launched: Boolean(extra.launched),
    role: extra.role || "creator",
  };
}

export function newWalletRecord() {
  return walletRecordFromKeypair(Keypair.generate(), { role: "creator", launched: false });
}

export function keypairFromRecord(record) {
  return keypairFromSecret(record.secretKey);
}

async function writeFileSynced(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const handle = await fs.open(temp, "w");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

export async function readWalletLibrary(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function appendWalletRecord(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, "a");
  try {
    await handle.write(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(file, 0o600).catch(() => {});
  const saved = await readWalletLibrary(file);
  if (!saved.some((entry) => entry.id === record.id && entry.publicKey === record.publicKey)) {
    throw new Error("Wallet-Key wurde nicht in die Bibliothek geschrieben");
  }
  return record;
}

export async function writeWalletLibrary(file, records) {
  let existing = [];
  try {
    existing = await readWalletLibrary(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const saved of existing) {
    const next = records.find((record) => record.id === saved.id);
    if (!next?.secretKey || next.secretKey !== saved.secretKey || next.publicKey !== saved.publicKey) {
      throw new Error("Key-Bibliothek würde einen gespeicherten Private Key verlieren");
    }
  }
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFileSynced(file, body ? `${body}\n` : "");
}
