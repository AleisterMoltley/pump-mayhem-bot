import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadWordText(text) {
  const seen = new Set();
  const words = [];
  for (const line of String(text).split(/\n/)) {
    const word = line.trim().toLowerCase();
    if (!word || seen.has(word) || !/^[a-z]{1,13}$/.test(word)) continue;
    seen.add(word);
    words.push({
      word,
      name: word[0].toUpperCase() + word.slice(1),
      symbol: word.toUpperCase(),
    });
  }
  return words;
}

export function wordAt(words, index) {
  if (!Number.isInteger(index) || index < 0 || index >= words.length) return null;
  return words[index];
}

export function loadWordList(file = path.join(root, "data", "words.txt")) {
  return loadWordText(fs.readFileSync(file, "utf8"));
}
