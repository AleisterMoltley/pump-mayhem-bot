import fs from "node:fs/promises";

const FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

async function readError(response) {
  const text = await response.text();
  return text.slice(0, 180);
}

export async function pinFile(jwt, bytes, filename) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), filename);
  const response = await fetch(FILE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Pinata-Bild fehlgeschlagen (${response.status}) ${await readError(response)}`);
  const json = await response.json();
  if (!json.IpfsHash) throw new Error("Pinata-Bild ohne IpfsHash");
  return json.IpfsHash;
}

export async function pinJson(jwt, content) {
  const response = await fetch(JSON_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pinataContent: content,
      pinataMetadata: { name: `${content.symbol}-metadata` },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Pinata-Metadaten fehlgeschlagen (${response.status}) ${await readError(response)}`);
  const json = await response.json();
  if (!json.IpfsHash) throw new Error("Pinata-Metadaten ohne IpfsHash");
  const uri = `https://ipfs.io/ipfs/${json.IpfsHash}`;
  if (uri.length > 200) throw new Error("Metadata-URI ist länger als 200 Zeichen");
  return uri;
}

export function metadataDocument({ name, symbol, description, image, website, telegram, twitter }) {
  return {
    name,
    symbol,
    description,
    image,
    showName: true,
    createdOn: "https://pump.fun",
    twitter,
    website,
    telegram,
  };
}

export async function loadImageCid(file) {
  try {
    const text = (await fs.readFile(file, "utf8")).trim();
    return text || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveImageCid(file, cid) {
  await fs.writeFile(file, `${cid}\n`);
}
