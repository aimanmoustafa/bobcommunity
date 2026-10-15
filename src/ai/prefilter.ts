import vocabulary from "../data/prefilterVocabulary.json";

/**
 * Decides which Discord messages are worth an AI call. Every message that
 * passes costs money and every message dropped is feedback the bot never
 * sees, so this gate has to be accurate in both directions.
 *
 * The previous version matched keywords as raw substrings ("op" fired on
 * "people", "hope", "open" and "stop"; "lag" fired on "flag") and let any
 * message over 40 characters through, so it passed chatter while dropping
 * real player questions such as "Why I not have mov speed in gears?".
 *
 * Rules, in order. The first one that matches decides:
 *   1. Too short once links, mentions and emoji are removed: drop.
 *   2. Pure acknowledgement or greeting ("gg", "thanks bro", "lol"): drop.
 *   3. Critical phrase (crash, can't log in, refund, hacked...): pass.
 *   4. Social chatter ("welcome", "play with me", "good luck"): drop.
 *   5. Ends in a question mark (any language): pass.
 *   6. Strong feedback keyword (bug, nerf, p2w, queue, refund...): pass.
 *   7. Opens with a question word plus something on-topic: pass.
 *   8. Hero name or game term, plus an opinion word or enough text: pass.
 *   9. Opinion word in a long enough message: pass.
 *  10. Long prose with no signal at all: pass. Everything else: drop.
 *
 * Hero names and game terms come from the FAQ (see tools/generate_faq_data.py),
 * including localized hero names for all eight FAQ languages. Keyword lists
 * are English only; other languages are covered by the question rules, the
 * hero names, shared English game terms and the long-message rule.
 */

const MIN_LETTERS = 6;
const QUESTION_MIN_LETTERS = 8;
const QUESTION_MIN_WORDS = 3;
const GAME_TERM_MIN_LETTERS = 14;
const OPINION_MIN_LETTERS = 12;
const WEAK_OPINION_MIN_LETTERS = 30;
const LONG_MIN_LETTERS = 40;
const LONG_MIN_WORDS = 7;

// A trailing * means "any word ending", so "crash*" matches crash, crashed,
// crashes and crashing, but only at a word boundary, never inside another word.
const CRITICAL_PHRASES = [
  "crash*", "can't log in", "cant log in", "cannot log in", "unable to log in", "can't login", "cant login",
  "lost my account", "account lost", "banned", "hacked", "hacker*", "cheat*", "exploit*", "refund*", "scam*",
  "charged twice", "double charged", "didn't receive", "didnt receive", "not received", "stolen",
];

const STRONG_KEYWORDS = [
  "bug*", "glitch*", "broke*", "broken", "crash*", "lag*", "freez*", "froze*", "stuck", "error*",
  "fix*", "patch*", "hotfix", "nerf*", "buff*", "op", "overpowered", "underpowered", "unbalanced",
  "imbalanced", "balance*", "p2w", "pay2win", "pay to win", "pay 2 win", "paywall", "pay", "paid",
  "purchas*", "refund*", "scam*", "charged", "chargeback*", "price*", "expensive", "overpriced", "money",
  "microtransaction*", "disconnect*", "reconnect*", "connection", "ping", "server*", "login", "log in",
  "logged out", "queue*", "matchmak*", "bot", "bots", "cheat*", "hack*", "exploit*", "toxic*", "report*",
  "ban", "banned", "suggest*", "request*", "feedback", "idea", "feature*", "please add", "pls add",
  "should add", "needs to", "need to add", "would be nice", "would be great", "wish", "bring back",
  "give us", "let us", "allow us", "add a", "add an", "add more", "add some", "add new", "remove*", "rework*", "update*", "unfair", "annoying", "confus*",
  "issue*", "problem*", "reward*",
  "not working", "doesn't work", "doesnt work", "does not work", "won't work", "stopped working", "not loading",
  "won't load", "doesn't load", "won't open", "keeps closing", "can't play", "cant play", "can't open", "cant open",
  "can't claim", "cant claim", "can't connect", "cant connect", "can't buy", "can't find",
  // Recurring topics in real community tickets: controls, performance, economy.
  "control*", "unresponsive", "unreliable", "clunky", "target*", "delay*", "fps", "stutter*", "overheat*",
  "battery", "drain*", "grind*", "f2p", "odds", "rng", "gacha", "currency",
];

// Everyday words that are on-topic in a game server but too common to count
// as feedback on their own. They only help when paired with an opinion word,
// or when a message opens with a question word.
const DOMAIN_NOUNS = ["hero*", "skin*", "season*", "rank*", "tier*", "match*", "gear", "spell*", "event*", "game*"];

// Opinion words. Praise is a tracked category, so these matter, but "have
// fun" and "the weather is amazing" are not feedback. Strong words are
// emotionally specific enough to count in a short message; weak ones need
// something on-topic nearby or a longer message.
const STRONG_OPINION_WORDS = [
  "love*", "hate*", "terrible", "awful", "horrible", "worst", "boring", "useless", "trash", "garbage",
  "disappointing", "disappointed", "frustrating", "frustrated", "sucks", "sucked",
];
const WEAK_OPINION_WORDS = ["great", "awesome", "amazing", "bad", "worse", "best", "favorite", "favourite", "fun", "enjoy*", "better", "good"];

// Messages made up only of these words are acknowledgements, greetings or
// laughter. Covers the FAQ languages; kept deliberately short and unambiguous.
const NOISE_WORDS = new Set([
  "gg", "ggs", "wp", "ggwp", "gl", "hf", "glhf", "lol", "lmao", "rofl", "xd", "kek", "haha", "hehe", "ok", "okay",
  "oki", "k", "kk", "yes", "yeah", "yep", "yup", "no", "nope", "nah", "thanks", "thank", "thx", "ty", "tysm",
  "you", "welcome", "hi", "hello", "hey", "heya", "yo", "sup", "gm", "gn", "good", "morning", "night", "evening",
  "bye", "cya", "np", "nvm", "same", "true", "indeed", "exactly", "agreed", "brb", "afk", "bro", "bruh",
  "dude", "man", "guys", "everyone", "all", "so", "much", "very", "again", "nice", "cool", "wow", "damn", "oof",
  "well", "played", "game", "congrats", "gratz", "gz",
  "спасибо", "спс", "ок", "окей", "ага", "угу", "да", "нет", "привет", "пока", "лол", "хах", "хаха", "ахах",
  "всем", "добрый", "день", "вечер", "утро",
  "شكرا", "شكراً", "مرحبا", "اهلا", "أهلا", "تمام", "اوكي", "حسنا", "نعم", "لا", "السلام", "عليكم",
  "danke", "hallo", "moin", "ja", "nein", "bitte", "tschüss", "gern", "zusammen",
  "obrigado", "obrigada", "valeu", "oi", "olá", "ola", "sim", "não", "nao", "blz", "tmj",
  "makasih", "terima", "kasih", "halo", "hai", "iya", "ya", "tidak", "tak", "sama", "wkwk", "wkwkwk",
  "gracias", "hola", "sí", "si", "claro", "vale", "buenas", "jaja", "jeje",
]);

// h-a-h-a, lolll, xddd, kkkk, jajaja, wkwkwk and similar repeated laughter.
const LAUGH_RE = /^(?:h?a+h[ah]*|(?:ha){2,}h?|(?:he){2,}|lo+l+|lmf?a+o+|xd+|kek+w?|k{3,}|(?:wk){2,}w?|(?:ja){2,}j?|ه{2,})$/u;

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
// <@id> <@!id> <@&id> <#id> <:name:id> <a:name:id>
const DISCORD_TOKEN_RE = /<(?:@[!&]?\d+|#\d+|a?:\w+:\d+)>/g;
const SHORTCODE_RE = /:[a-z0-9_]{2,}:/gi;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu;
const QUESTION_END_RE = /[?？؟]['")\]]*\s*$/u;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(entries: string[]): RegExp {
  const parts = [...entries]
    .sort((a, b) => b.length - a.length)
    .map((e) => (e.endsWith("*") ? `${escapeRegex(e.slice(0, -1))}\\p{L}*` : escapeRegex(e)));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join("|")})(?![\\p{L}\\p{N}])`, "u");
}

const criticalMatcher = buildMatcher(CRITICAL_PHRASES);
const strongMatcher = buildMatcher(STRONG_KEYWORDS);
const strongOpinionMatcher = buildMatcher(STRONG_OPINION_WORDS);
const weakOpinionMatcher = buildMatcher(WEAK_OPINION_WORDS);
const gameTermMatcher = buildMatcher(vocabulary.gameTerms);
const domainNounMatcher = buildMatcher(DOMAIN_NOUNS);

// Social chatter that shares vocabulary with feedback ("play ranked with me",
// "welcome to the server", "good luck, have fun"). Checked after critical
// phrases so a real problem report is never mistaken for it.
const SOCIAL_RE = new RegExp(
  [
    "^(?:welcome|happy birthday|good (?:morning|night|evening|luck)|see you)\\b",
    "\\b(?:who wants|anyone (?:want|wanna)|wanna play|looking for (?:a )?(?:duo|team|squad|partner|friends?)|add me)\\b",
    "\\b(?:play|queue|duo|team up|squad) with me\\b",
    "\\bwish (?:me|you|us)\\b",
  ].join("|"),
  "u"
);

// Hero names. Latin names must match a whole word ("Vio" must not fire inside
// "violin"). Non-Latin names are matched by stem, because Russian and Arabic
// attach case endings and prefixes ("Халикса", "لهاليكس").
const normalizeName = (s: string) => s.toLowerCase().replace(/['’\-]/g, "");
const LATIN_ONLY = /^[\u0000-\u024f]+$/;
const latinHeroNames = new Set<string>();
const nonLatinHeroStems = new Set<string>();
for (const names of Object.values(vocabulary.heroNames as Record<string, string[]>)) {
  for (const raw of names) {
    const n = normalizeName(raw);
    if (LATIN_ONLY.test(n)) latinHeroNames.add(n);
    else if (n.length >= 4) nonLatinHeroStems.add(n.length >= 6 ? n.slice(0, -1) : n);
  }
}

const questionStarters = new Set<string>([
  ...Object.values(vocabulary.questionStarters as Record<string, string[]>).flat(),
  "when", "where", "who", "should",
]);

export interface PrefilterResult {
  shouldAnalyze: boolean;
  isPotentiallyCritical: boolean;
  /** Which rule decided. Useful when tuning: log it and see what is passing or dropping. */
  reason: string;
}

function cleanText(content: string): string {
  return content
    .replace(URL_RE, " ")
    .replace(DISCORD_TOKEN_RE, " ")
    .replace(SHORTCODE_RE, " ")
    .replace(EMOJI_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^\p{L}\p{N}'\-]+/u)
    .map((t) => t.replace(/^['-]+|['-]+$/g, "").replace(/'s$/, ""))
    .filter(Boolean);
}

function mentionsHero(tokens: string[]): boolean {
  for (const token of tokens) {
    const t = normalizeName(token);
    if (latinHeroNames.has(t)) return true;
    if (!LATIN_ONLY.test(t)) {
      for (const stem of nonLatinHeroStems) if (t.includes(stem)) return true;
    }
  }
  return false;
}

function endsLikeQuestion(cleaned: string, tokens: string[], letters: number): boolean {
  if (tokens.length < QUESTION_MIN_WORDS || letters < QUESTION_MIN_LETTERS) return false;
  return QUESTION_END_RE.test(cleaned) || cleaned.includes("¿");
}

function opensLikeQuestion(tokens: string[], letters: number): boolean {
  return tokens.length >= 4 && letters >= QUESTION_MIN_LETTERS && questionStarters.has(tokens[0]);
}

export function prefilterMessage(content: string): PrefilterResult {
  const cleaned = cleanText(content);
  const letters = (cleaned.match(/\p{L}/gu) || []).length;
  const drop = (reason: string): PrefilterResult => ({ shouldAnalyze: false, isPotentiallyCritical: false, reason });
  const pass = (reason: string, critical = false): PrefilterResult => ({ shouldAnalyze: true, isPotentiallyCritical: critical, reason });

  if (letters < MIN_LETTERS) return drop("too_short");

  const tokens = tokenize(cleaned);
  if (tokens.every((t) => NOISE_WORDS.has(t) || LAUGH_RE.test(t))) return drop("noise");

  const text = tokens.join(" ");

  if (criticalMatcher.test(text)) return pass("critical", true);
  if (SOCIAL_RE.test(text)) return drop("social");

  // A question mark is enough on its own: it is the one signal that works in
  // every language, and the keyword lists below are English only.
  if (endsLikeQuestion(cleaned, tokens, letters)) return pass("question");
  if (strongMatcher.test(text)) return pass("keyword");

  const hasGameTerm = gameTermMatcher.test(text) || mentionsHero(tokens);
  const hasDomainNoun = domainNounMatcher.test(text);
  const hasStrongOpinion = strongOpinionMatcher.test(text);
  const hasWeakOpinion = weakOpinionMatcher.test(text);

  // Opening with a question word but with no question mark ("how many points
  // do I need for gold tier") only counts when something on-topic is there,
  // otherwise "can someone help me with my homework" would pass.
  if (opensLikeQuestion(tokens, letters) && (hasGameTerm || hasDomainNoun)) return pass("question");

  if (hasGameTerm && (hasStrongOpinion || hasWeakOpinion || letters >= GAME_TERM_MIN_LETTERS)) return pass("game_term");
  if (hasDomainNoun && (hasStrongOpinion || hasWeakOpinion) && letters >= OPINION_MIN_LETTERS) return pass("opinion");
  if (hasStrongOpinion && letters >= OPINION_MIN_LETTERS) return pass("opinion");
  if (hasWeakOpinion && letters >= WEAK_OPINION_MIN_LETTERS) return pass("opinion");
  if (letters >= LONG_MIN_LETTERS && tokens.length >= LONG_MIN_WORDS) return pass("long_message");

  return drop("no_signal");
}
