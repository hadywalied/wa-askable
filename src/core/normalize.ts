/**
 * Arabic / Franco-Arab text folding for search.
 *
 * The whole point: a query typed in one writing system must match a message
 * typed in another. We do that by folding everything into one canonical form
 * at ingest time, and folding the query the same way at search time.
 *
 * This is character-level only. Converting Franco ("3ashan") into real Arabic
 * ("عشان") is genuinely ambiguous and needs a model — see enrich.ts. What we do
 * here is cheap, deterministic, and runs on every message.
 */

/** Harakat (short vowels), shadda, sukun, superscript alef. */
const DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
/** Kashida / tatweel — a purely decorative letter-stretcher. */
const TATWEEL = /\u0640/g;
/** Zero-width joiners and marks that survive copy-paste from phones. */
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

const LETTER_FOLD: Record<string, string> = {
  // Every alef variant collapses to bare alef. This one matters most —
  // people type أ and ا interchangeably and search must not care.
  '\u0623': '\u0627', // أ
  '\u0625': '\u0627', // إ
  '\u0622': '\u0627', // آ
  '\u0671': '\u0627', // ٱ
  // Taa marbuta -> haa. Egyptians type both for the same word ending.
  '\u0629': '\u0647', // ة
  // Alef maksura -> yaa. Same reason.
  '\u0649': '\u064A', // ى
  // Hamza carriers -> their base letter.
  '\u0624': '\u0648', // ؤ
  '\u0626': '\u064A', // ئ
  // Persian/Urdu lookalikes that show up in forwarded text.
  '\u06A9': '\u0643', // ک
  '\u06CC': '\u064A', // ی
  '\u06C1': '\u0647', // ہ
};

/** Arabic-Indic and Eastern Arabic-Indic digits -> ASCII. */
function foldDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => {
    const c = d.charCodeAt(0);
    const base = c >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(c - base);
  });
}

/**
 * Canonical form used for the searchable Arabic column and for query folding.
 * Idempotent: folding an already-folded string returns it unchanged.
 */
export function normalizeArabic(input: string): string {
  if (!input) return '';
  let s = input.normalize('NFKC');
  s = s.replace(INVISIBLES, '');
  s = s.replace(DIACRITICS, '');
  s = s.replace(TATWEEL, '');
  s = s.replace(/[\u0600-\u06FF]/g, (ch) => LETTER_FOLD[ch] ?? ch);
  s = foldDigits(s);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Digits that stand in for Arabic letters with no Latin equivalent:
 * 3=ع  7=ح  5=خ  2=ء  6=ط  8=غ  9=ق
 *
 * Matching these naively flags half of a developer's chat: "v2", "5pm", "mp3",
 * "base64", "x86", "sha256" all contain a digit next to letters. So we require
 * the digit to sit in a position Arabic transliteration actually puts it in:
 * either surrounded by letters on both sides ("sha2a", "ma3lesh"), or opening
 * a word of at least three more letters ("3ashan", "7abibi").
 */
const FRANCO_INFIX = /[a-z][2356789][a-z]/;
const FRANCO_PREFIX = /^[2356789][a-z]{3,}/;

/** Common Egyptian function words, written in Latin. */
const FRANCO_STOPWORDS = new Set([
  'msh', 'mesh', 'ana', 'enta', 'enti', 'ehna', 'homma', 'keda', 'kda',
  'tmam', 'tamam', 'khalas', 'yalla', 'habibi', 'maalesh', 'ma3lesh',
  'eh', 'fen', 'emta', 'leh', 'ezay', 'ezzay', 'shokran', 'bokra',
  'elnaharda', 'dlwa2ty', 'delwa2ty', 'wala', 'aywa', 'la2', 'tayeb',
  'inshallah', 'insha2allah', 'mabrouk', 'mabrook', 'ya3ni', 'yaani',
]);

/**
 * Heuristic: is this text Arabic written in Latin script?
 *
 * Used to decide whether a message is worth spending a model call on for
 * transliteration. Deliberately conservative — a false negative just means we
 * skip an enrichment; a false positive costs a few tokens.
 */
export function looksLikeFranco(text: string): boolean {
  if (!text) return false;
  const tokens = text.split(/\s+/).filter((t) => /[a-zA-Z]/.test(t));
  if (tokens.length === 0) return false;

  let hits = 0;
  for (const raw of tokens) {
    const t = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (t.length < 2) continue;
    if (FRANCO_STOPWORDS.has(t)) hits++;
    else if (FRANCO_INFIX.test(t) || FRANCO_PREFIX.test(t)) hits++;
    // Arabic definite article glued to a word: "elsha2a", "ilbeit".
    else if (/^(el|il)[a-z]{3,}/.test(t)) hits++;
  }
  return hits / tokens.length >= 0.2;
}

/** Does the string contain any Arabic-script character? */
export function hasArabicScript(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F]/.test(text);
}

/**
 * What we actually write into the FTS index. Lowercases Latin so English
 * matching is case-insensitive, and folds Arabic to canonical form.
 */
export function foldForSearch(text: string): string {
  return normalizeArabic(text).toLowerCase();
}

export type ScriptMix = 'arabic' | 'latin' | 'franco' | 'mixed' | 'empty';

/** Classify a message so the enrichment queue knows what work it needs. */
export function classifyScript(text: string): ScriptMix {
  if (!text || !text.trim()) return 'empty';
  const ar = hasArabicScript(text);
  const la = /[a-zA-Z]/.test(text);
  if (ar && la) return 'mixed';
  if (ar) return 'arabic';
  if (la) return looksLikeFranco(text) ? 'franco' : 'latin';
  return 'empty';
}

/**
 * Arabic proclitics — particles that attach to the front of a word rather than
 * standing alone. "the apartment" is الشقة, "for the apartment" is للشقة, "and
 * the apartment" is والشقة. All one token to a search index.
 *
 * This matters more than it sounds. A prefix search for الشقه cannot match
 * للشقه, because the match has to start at the beginning of the token — so a
 * user searching for "the apartment" silently misses every message that said
 * "for the apartment". Stripping these gives us a stem to index alongside the
 * full form.
 *
 * Longest-first, so لل is tried before ل.
 */
const PROCLITICS = ['وبال', 'فبال', 'وال', 'فال', 'بال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب', 'ك', 'ل'];

/** Strip one leading particle, if what remains is still a plausible word. */
export function stripProclitic(token: string): string {
  for (const p of PROCLITICS) {
    if (token.length >= p.length + 3 && token.startsWith(p)) {
      return token.slice(p.length);
    }
  }
  return token;
}

/**
 * Stem forms for every Arabic token, indexed in their own FTS column so a
 * query can reach a word regardless of what was glued to the front of it.
 * Latin tokens are left alone — English does not do this.
 */
export function stemsForSearch(text: string): string {
  const seen = new Set<string>();
  for (const tok of foldForSearch(text).split(/\s+/)) {
    if (!tok || !hasArabicScript(tok)) continue;
    const stem = stripProclitic(tok);
    if (stem !== tok) seen.add(stem);
  }
  return [...seen].join(' ');
}
