import path from "node:path";

export function loadConfig(env = process.env) {
  const helius = String(env.HELIUS_API_KEY || "").trim();
  let rpc = String(env.SOLANA_RPC_URL || "").trim();
  const publicRpc = !rpc || rpc.includes("api.mainnet-beta.solana.com");
  if (publicRpc && helius) {
    rpc = `https://mainnet.helius-rpc.com/?api-key=${helius}`;
  }
  const railway = Boolean(env.RAILWAY_ENVIRONMENT);
  const volumePath = String(env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  const dataDir = volumePath || String(env.DATA_DIR || "").trim() || (railway ? "/data" : path.resolve("runtime"));
  return {
    rpc,
    pinataJwt: String(env.PINATA_JWT || "").trim(),
    privateKey: String(env.PRIVATE_KEY || "").trim(),
    password: String(env.DASHBOARD_PASSWORD || "").trim(),
    dataDir,
    port: Number(env.PORT || 8080),
    autostart: env.AUTOSTART !== "false",
    railway,
    volume: Boolean(volumePath || env.RAILWAY_VOLUME_NAME),
    volumePath,
  };
}

export function configStatus(config) {
  const blockers = [];
  const warnings = [];
  if (!config.password || config.password.length < 8) blockers.push("DASHBOARD_PASSWORD fehlt oder ist kürzer als 8 Zeichen");
  if (!config.privateKey) blockers.push("PRIVATE_KEY fehlt");
  if (!config.pinataJwt) blockers.push("PINATA_JWT fehlt");
  if (!config.rpc) blockers.push("SOLANA_RPC_URL oder HELIUS_API_KEY fehlt");
  if (config.railway && !config.volume) {
    blockers.push("Railway-Volume fehlt. Mount-Pfad setzen, sonst wird die Key-Bibliothek beim Redeploy gelöscht.");
  }
  return { blockers, warnings, ready: blockers.length === 0 };
}
