/**
 * How often one caller may knock: the rules, with no database in here.
 *
 * Pure, like the rest of lib/*.mjs, so `node scripts/rate-limit.test.mjs` runs
 * it bare. The counter itself lives in MongoDB (lib/rateLimitStore.mjs),
 * because the app runs on serverless functions: a counter held in memory
 * starts again at zero in every fresh instance, which limits nothing.
 *
 *
 * WHY THESE ROUTES
 * ----------------
 * - Sign-in had no limit at all. Every attempt costs a full scrypt hash
 *   (N=65536, lib/password.mjs), so an unlimited guesser is also a cheap way
 *   to exhaust the server.
 * - Sign-up is open by default (SIGNUP_DISABLED), and each one creates a firm.
 * - Emailing a bill sends real mail from the firm's sending address. Its
 *   content is already tied to a real bill (app/api/send-email/route.js);
 *   this caps how many go out.
 *
 * FIXED WINDOWS
 * -------------
 * One counter per caller per window, e.g. "10 sign-in attempts for this
 * address per 15 minutes". Simpler than a sliding window, and the worst case
 * -- twice the limit across a window boundary -- is still a hard ceiling.
 *
 * WHAT IS STORED
 * --------------
 * An HMAC of the caller's key under AUTH_SECRET, never the IP address or the
 * email itself. A plain hash would not do: every IPv4 address can be hashed
 * in minutes and matched back. Without the secret the keys cannot be
 * reversed, so the collection is not a log of who tried to sign in.
 */

import { createHmac } from "node:crypto";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A positive whole number from the environment, or the fallback. */
const envLimit = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * Every limit in one place. `limit` attempts per `windowMs`.
 *
 * A getter for the email caps, so a deployment can raise them with an
 * environment variable and no code change.
 */
export const LIMITS = {
  // Per network address: enough for an office full of people behind one IP
  // who mistype now and then, far too few for a guesser.
  "login-ip": { limit: 30, windowMs: 15 * MINUTE },
  // Per account address FROM ONE NETWORK. Tight, and cleared on a successful
  // sign-in, so a person who mistypes a few times and then gets it right
  // starts again from zero. Keyed on the network too, so a stranger failing
  // on somebody's address from elsewhere cannot lock that person out.
  "login-email-ip": { limit: 10, windowMs: 15 * MINUTE },
  // Per account address from anywhere: the ceiling for a guesser spread
  // across many networks. Loose, because it is the one a stranger CAN run
  // up against somebody else's account -- it takes 100 tries in 15 minutes
  // to lock a person out, and it is not cleared by signing in.
  "login-email": { limit: 100, windowMs: 15 * MINUTE },
  // Each sign-up creates a firm.
  "signup-ip": { limit: 5, windowMs: HOUR },
  get "email-firm"() {
    return { limit: envLimit("EMAIL_DAILY_LIMIT", 200), windowMs: DAY };
  },
  // Reading a bill off a photo (app/api/invoice-extract): a paid model call.
  get "bill-read-firm"() {
    return { limit: envLimit("BILL_READ_DAILY_LIMIT", 200), windowMs: DAY };
  },
  // The optional AI summary in Hindi on the dashboard (lib/hindiInsights.mjs).
  // Each one is a paid model call on the firm's key.
  get "ai-insights-firm"() {
    return { limit: envLimit("AI_INSIGHTS_DAILY_LIMIT", 50), windowMs: DAY };
  },
  get "email-user"() {
    return { limit: envLimit("EMAIL_HOURLY_LIMIT_PER_USER", 40), windowMs: HOUR };
  },
};

/** The rule for a bucket, or a thrown error: a typo must not mean "no limit". */
export function limitFor(bucket) {
  const rule = LIMITS[bucket];
  if (!rule) throw new Error(`No rate limit is defined for "${bucket}".`);
  return rule;
}

/**
 * Are the forwarding headers set by a proxy we trust, rather than by the
 * caller? On Vercel the platform overwrites them, so yes. On any other host
 * they are whatever the caller sent, unless TRUST_PROXY=true says a proxy in
 * front rewrites them.
 */
export const proxyTrusted = (env = process.env) =>
  env.VERCEL === "1" || String(env.TRUST_PROXY || "").toLowerCase() === "true";

/**
 * IPv6 clients usually hold a whole /64, so one address is not one caller:
 * count the /64. IPv4 (and IPv4-mapped IPv6) is counted per address.
 */
export function ipBucket(ip) {
  const text = String(ip || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!text.includes(":")) return text;
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail = ""] = text.split("%")[0].split("::");
  const left = head ? head.split(":") : [];
  const right = text.includes("::") && tail ? tail.split(":") : [];
  const groups = text.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * The caller's network address, or null when it cannot be trusted.
 *
 * On a trusted proxy, `x-real-ip` (the connecting client, on Vercel) and then
 * the first `x-forwarded-for` entry. Untrusted -- a bare `next start` with no
 * proxy -- gives null, and the routes then skip the per-network limits rather
 * than count a value the caller can change on every request. The per-address
 * limits still apply.
 */
export function clientIp(headers, env = process.env) {
  if (!proxyTrusted(env)) return null;
  const get = (name) => {
    if (!headers) return "";
    const value = typeof headers.get === "function" ? headers.get(name) : headers[name];
    return String(value || "").trim();
  };
  const ip = get("x-real-ip") || get("x-forwarded-for").split(",")[0].trim();
  return ip ? ipBucket(ip) : null;
}

/** The stored key for one caller in one window. Hashed: see the note above. */
export function windowKey(bucket, id, now = Date.now()) {
  const { windowMs } = limitFor(bucket);
  const start = Math.floor(now / windowMs) * windowMs;
  const digest = createHmac("sha256", `rate-limit\u0000${process.env.AUTH_SECRET || ""}`)
    .update(`${bucket}\u0000${String(id ?? "").trim().toLowerCase()}`)
    .digest("hex");
  return { key: `${bucket}:${digest}:${start}`, resetAt: new Date(start + windowMs) };
}

/**
 * Given the count AFTER this attempt was added, may it go ahead?
 *
 * `retryAfterSeconds` is at least 1, so a Retry-After header never says 0.
 */
export function verdict(bucket, count, resetAt, now = Date.now()) {
  const { limit } = limitFor(bucket);
  const allowed = Number(count) <= limit;
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(1, Math.ceil((new Date(resetAt).getTime() - now) / 1000));
  return { allowed, limit, count: Number(count), retryAfterSeconds };
}

/** "a minute", "14 minutes", "3 hours" -- for the message a person reads. */
export function waitText(seconds) {
  const minutes = Math.max(1, Math.ceil(Number(seconds) / 60));
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/** The 429 body and headers for a refused attempt. */
export function tooManyResponse(result, what) {
  const message = `Too many ${what}. Try again in ${waitText(result.retryAfterSeconds)}.`;
  return {
    status: 429,
    body: { success: false, error: message, message, code: "rate_limited" },
    headers: { "Retry-After": String(result.retryAfterSeconds) },
  };
}
