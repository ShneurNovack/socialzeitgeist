// Text readings with no language model: key terms, hooks, similarity.

const STOP = new Set(`a an the and or but if then than so of to in on at by for from with without about into over under
after before during through between among against as is are was were be been being am do does did doing have has had
having will would shall should can could may might must this that these those there here it its it's they them their
theirs we us our ours you your yours he him his she her hers i me my mine who whom whose which what when where why how
not no nor only own same such too very just also more most some any all each every both few many much other another
one two three first new now today tonight yesterday tomorrow week year day days time times out up down off again further
once because while until via per like get got go going went come came see saw said says say make made making take took
know knew think thought want wants really still even ever never always already yet back way thing things people man
woman men women life world link bio comment comments share follow tag tags post posts story stories reel reels video
watch read full swipe right left dm below above click tap here's heres don't dont it's im i'm ive i've you're youre
we're were they're theyre let's lets can't cant won't wont isn't isnt aren't arent wasn't wasnt doesn't doesnt didn't
didnt that's thats what's whats there's theres who's whos he's hes she's shes
את של על עם לא זה היא הוא אני אנחנו אתם הם כל גם או כי אם מה מי איך למה יש אין היה היו הזה הזאת
היום אתמול מחר עכשיו עוד רק כבר אבל אז שם פה כאן אחרי לפני בין תחת מעל מול נגד בגלל כדי כמו יותר פחות מאוד הרבה מעט
אחד אחת שני שתי שלוש כמה איזה אילו אלה אלו אותו אותה אותם אותן שלו שלה שלהם שלנו שלי שלך לו לה להם לנו לי לך
בוקר ערב לילה שעה שעות דקות ימים שבוע חודש שנה היתה הייתה יהיה תהיה יהיו עדיין בלבד לגבי בנוגע ממש`.split(/\s+/));

const PLATFORM_NOISE = /^(rt|via|credit|credits|repost|reposted|source|photo|pc|ig|insta|instagram|tiktok|youtube|x|twitter|telegram|reddit)$/;

function normalize(s) {
  return String(s || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function stem(w) {
  // Light English stemming so "hostages" and "hostage" meet.
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

// Key terms: hashtags, @handles, capitalized runs (names), and content words. Lowercased, light-stemmed.
export function terms(text, { max = 40 } = {}) {
  const t = normalize(text);
  const out = new Map();
  const add = (k, w = 1) => {
    if (!k || k.length < 3 || STOP.has(k) || PLATFORM_NOISE.test(k)) return;
    out.set(k, (out.get(k) || 0) + w);
  };
  for (const m of t.matchAll(/#([\p{L}\p{N}_]{3,40})/gu)) add(m[1].toLowerCase(), 2);
  for (const m of t.matchAll(/@([\p{L}\p{N}_.]{3,40})/gu)) add("@" + m[1].toLowerCase().replace(/\.$/, ""), 1.5);
  // Capitalized runs of 2 to 4 words are names: "Ziv Abud", "Nova Festival", "Hebrew University"
  const noTags = t.replace(/[#@][\p{L}\p{N}_.]+/gu, " ");
  for (const m of noTags.matchAll(/\b(\p{Lu}[\p{L}'’-]+(?:\s+(?:of|the|de|van|bin|ben|al)\s+)?(?:\s+\p{Lu}[\p{L}'’-]+){1,3})\b/gu)) {
    const name = m[1].toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
    const words = name.split(" ");
    if (words.every((w) => STOP.has(w))) continue;
    add(name, 3);
  }
  // Single capitalized words that are not sentence starts count a little (places, people with one name)
  for (const m of noTags.matchAll(/(?<![.!?]\s|^)\b(\p{Lu}[\p{L}'’-]{3,})\b/gu)) add(stem(m[1].toLowerCase()), 1.2);
  // Content words
  for (const w of noTags.toLowerCase().split(/[^\p{L}\p{N}'’]+/u)) {
    const s = stem(w.replace(/[’']/g, "'").replace(/^'+|'+$/g, ""));
    if (s.length >= 4 && !/^\d+$/.test(s)) add(s, 1);
  }
  return [...out.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, w]) => [k, Math.round(w * 10) / 10]);
}

// How the post opens: the things that are about writing, not subject.
export function hook(text) {
  const t = normalize(text);
  const first = (t.split(/\n|(?<=[.!?])\s/)[0] || "").trim();
  return {
    opener: first.slice(0, 90),
    question: /\?/.test(first),
    number: /\b\d[\d,.]*\b/.test(first),
    caps: first.length > 8 && first === first.toUpperCase() && /[A-Z]/.test(first),
    quote: /^["“]/.test(first),
    length: t.length,
    emoji_lead: /^[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u.test(first),
  };
}

export function termMap(arr) {
  const m = new Map();
  for (const [k, w] of arr || []) m.set(k, w);
  return m;
}

// Weighted cosine over term weights, with idf.
export function cosine(a, b, idf) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, w] of a) {
    const x = w * (idf(k));
    na += x * x;
    const v = b.get(k);
    if (v) dot += x * (v * idf(k));
  }
  for (const [k, w] of b) {
    const x = w * idf(k);
    nb += x * x;
  }
  return dot && na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function makeIdf(dfMap, nDocs) {
  const n = Math.max(nDocs, 10);
  return (k) => {
    const df = dfMap.get(k) || 0;
    return Math.log((n + 1) / (df + 1)) + 1;
  };
}

// A short label from shared terms: prefer names and hashtags, then the rest.
export function labelFrom(sharedTerms) {
  const names = sharedTerms.filter((k) => k.includes(" ") && !k.startsWith("@"));
  const tags = sharedTerms.filter((k) => !k.includes(" ") && !k.startsWith("@"));
  const picked = [...names.slice(0, 2), ...tags.slice(0, names.length ? 1 : 3)];
  return picked
    .map((k) => k.replace(/\b\p{L}/gu, (c) => c.toUpperCase()))
    .join(" · ")
    .slice(0, 80) || "Untitled";
}
