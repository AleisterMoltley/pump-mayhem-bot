import fs from "node:fs/promises";
import path from "node:path";

async function writeSynced(file, text) {
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

export async function readState(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeState(file, state) {
  await writeSynced(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function pushLog(state, message, limit = 200) {
  state.log.unshift({ at: new Date().toISOString(), message: String(message).slice(0, 500) });
  state.log = state.log.slice(0, limit);
}

export function runtimePaths(dataDir) {
  return {
    state: path.join(dataDir, "state.json"),
    wallets: path.join(dataDir, "wallets.jsonl"),
    imageCid: path.join(dataDir, "image-cid.txt"),
  };
}
