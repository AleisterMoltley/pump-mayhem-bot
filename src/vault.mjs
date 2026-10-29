export function readTokenAmount(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length < 72) return null;
  return buffer.readBigUInt64LE(64);
}

export function tokenAmountFromMeta(balances, mint, owner) {
  const row = (balances || []).find((entry) => entry.mint === mint && entry.owner === owner);
  if (!row?.uiTokenAmount?.amount) return null;
  return BigInt(row.uiTokenAmount.amount);
}

export function armVaultWatch(baseline, current) {
  const base = BigInt(baseline);
  const now = BigInt(current);
  if (now > base) return { action: "sell", floor: now };
  return { action: "watch", floor: now };
}

export function nextVaultEvent(previous, next) {
  const before = BigInt(previous);
  const after = BigInt(next);
  if (after > before) return { side: "buy", delta: after - before, amount: after };
  if (after < before) return { side: "sell", delta: before - after, amount: after };
  return { side: "flat", delta: 0n, amount: after };
}
