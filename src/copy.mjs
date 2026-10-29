import { TWITTER } from "./money.mjs";

const ADJECTIVES = [
  "bright", "brief", "loud", "quiet", "swift", "plain", "wild", "clean",
  "rough", "sharp", "odd", "bold", "calm", "raw", "keen", "warm",
];

const NOUNS = [
  "ticker", "spark", "lane", "coin", "note", "flare", "pocket", "signal",
  "banner", "drift", "echo", "stamp", "ripple", "flash", "marker", "chant",
];

const TEMPLATES = [
  (name, adjective, noun) =>
    `${name} is a ${adjective} ${noun} on Solana. Plain English, one picture, nothing promised.`,
  (name, adjective, noun) =>
    `Fresh ${name}. ${capitalize(adjective)} ${noun}, a public link, and a short English caption.`,
  (name, adjective, noun) =>
    `The word is ${name}. Picture a ${adjective} ${noun} and a chart that does not sit still.`,
  (name, adjective, noun) =>
    `${name} keeps the copy simple: a ${adjective} ${noun}, written in English, with its own link.`,
  (name, adjective, noun) =>
    `${capitalize(adjective)} ${noun} energy. ${name} is the ticker. Read it once and decide fast.`,
  (name, adjective, noun) =>
    `Say ${name} out loud. It is a ${adjective} ${noun} of a coin with a brand new description.`,
  (name, adjective, noun) =>
    `${name} arrives as a ${adjective} ${noun}. English text, a unique page, no extra story.`,
  (name, adjective, noun) =>
    `This one is called ${name}. A ${adjective} ${noun}, described in English, linked once.`,
];

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function pick(list, rng) {
  const index = Math.floor(rng() * list.length) % list.length;
  return list[index];
}

function slugPart(rng) {
  return Math.floor(rng() * 36 ** 6)
    .toString(36)
    .padStart(4, "0");
}

export function buildCopy(word, rng = Math.random) {
  const name = capitalize(word);
  const adjective = pick(ADJECTIVES, rng);
  const noun = pick(NOUNS, rng);
  const slug = `${String(word).toLowerCase()}-${adjective}-${noun}-${slugPart(rng)}`;
  return {
    description: pick(TEMPLATES, rng)(name, adjective, noun),
    website: `https://example.com/${slug}`,
    telegram: `https://example.com/room/${slug}`,
    twitter: TWITTER,
  };
}
