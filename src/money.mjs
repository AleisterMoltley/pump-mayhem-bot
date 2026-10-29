export const TRANSFER_FEE = 5000n;
export const CREATOR_VAULT_RENT = 890_880n;
export const DEV_BUY_LAMPORTS = 1_000_000_000n;
export const MIN_BALANCE_LAMPORTS = 1_150_000_000n;
export const SELL_SLIPPAGE_PERCENT = 8;
export const CREATE_SLIPPAGE_PERCENT = 1;
export const SELL_PRIORITY_LAMPORTS = 400_000n;
export const CREATE_PRIORITY_LAMPORTS = 100_000n;
export const CREATE_COMPUTE_UNITS = 600_000;
export const SELL_COMPUTE_UNITS = 250_000;
export const COLLECT_COMPUTE_UNITS = 200_000;
export const TWITTER = "https://x.com/Pumpfun";

export function microLamports(feeLamports, computeUnits) {
  const fee = Number(feeLamports);
  const units = Number(computeUnits);
  if (!Number.isSafeInteger(fee) || fee < 0) throw new Error("Ungültige Prioritätsgebühr");
  if (!Number.isSafeInteger(units) || units < 1) throw new Error("Ungültiges Compute-Limit");
  return Math.max(1, Math.floor((fee * 1_000_000) / units));
}

export function sweepLamports(balance, fee = TRANSFER_FEE) {
  const lamports = BigInt(balance);
  const cost = BigInt(fee);
  if (lamports <= cost) {
    const error = new Error("Zu wenig SOL für den Wallet-Wechsel");
    error.code = "LOW_BALANCE";
    throw error;
  }
  return lamports - cost;
}

export function pnlLamports(startBalance, endBalance) {
  return BigInt(endBalance) - BigInt(startBalance);
}

export function formatSol(lamports) {
  const value = BigInt(lamports);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / 1_000_000_000n;
  const fraction = (abs % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}
