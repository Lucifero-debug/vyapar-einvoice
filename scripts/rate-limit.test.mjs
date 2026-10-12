/**
 * Rate limits on sign-in, sign-up and emailing a bill (lib/rateLimit.mjs),
 * and the write permission on acknowledging a stock alert.
 *
 * The counter's database half (lib/rateLimitStore.mjs) is checked by reading
 * its source: it needs a live MongoDB to run.
 *
 * Bare node: `node scripts/rate-limit.test.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LIMITS,
  clientIp,
  ipBucket,
  limitFor,
  proxyTrusted,
  tooManyResponse,
  verdict,
  waitText,
  windowKey,
} from "../lib/rateLimit.mjs";
import { ROLE_PERMISSIONS, can } from "../lib/roles.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.log(`  FAIL  ${name}\n        ${err.message.split("\n").join("\n        ")}`);
  }
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0); // on a 15-minute boundary

/* ─────────────────────────────── the rules ─────────────────────────────── */

console.log("\n--- the limits ---");

test("every bucket the routes use has a rule", () => {
  for (const bucket of ["login-ip", "login-email-ip", "login-email", "signup-ip", "email-firm", "email-user"]) {
    const rule = limitFor(bucket);
    assert.ok(Number.isInteger(rule.limit) && rule.limit > 0, bucket);
    assert.ok(rule.windowMs > 0, bucket);
  }
});

test("an unknown bucket throws rather than meaning no limit", () => {
  assert.throws(() => limitFor("login-ipp"), /No rate limit/);
});

test("sign-in: per address from one network is the tight limit", () => {
  assert.ok(LIMITS["login-email-ip"].limit < LIMITS["login-ip"].limit);
});

test("sign-in: a stranger needs many tries to lock somebody else out", () => {
  // The address-wide ceiling is the only one a stranger on another network
  // runs up for somebody else's account, so it must be well above the tight one.
  assert.ok(LIMITS["login-email"].limit >= 5 * LIMITS["login-email-ip"].limit);
});

test("the email caps can be raised from the environment", () => {
  const before = process.env.EMAIL_DAILY_LIMIT;
  process.env.EMAIL_DAILY_LIMIT = "500";
  assert.equal(limitFor("email-firm").limit, 500);
  process.env.EMAIL_DAILY_LIMIT = "nonsense";
  assert.equal(limitFor("email-firm").limit, 200, "a bad value falls back, never unlimited");
  process.env.EMAIL_DAILY_LIMIT = "0";
  assert.equal(limitFor("email-firm").limit, 200, "zero is not 'no limit'");
  if (before === undefined) delete process.env.EMAIL_DAILY_LIMIT;
  else process.env.EMAIL_DAILY_LIMIT = before;
});

console.log("\n--- the verdict ---");

test("up to the limit is allowed; one more is not", () => {
  const { limit } = limitFor("login-email");
  const resetAt = new Date(T0 + 15 * MIN);
  assert.equal(verdict("login-email", limit, resetAt, T0).allowed, true);
  const over = verdict("login-email", limit + 1, resetAt, T0);
  assert.equal(over.allowed, false);
  assert.equal(over.retryAfterSeconds, 15 * 60);
});

test("Retry-After never says 0", () => {
  const resetAt = new Date(T0);
  assert.equal(verdict("login-email", 999, resetAt, T0 + 5).retryAfterSeconds, 1);
});

test("the 429 says how long to wait and sets Retry-After", () => {
  const out = tooManyResponse({ retryAfterSeconds: 14 * 60 }, "sign-in attempts");
  assert.equal(out.status, 429);
  assert.equal(out.headers["Retry-After"], "840");
  assert.equal(out.body.code, "rate_limited");
  assert.match(out.body.message, /Too many sign-in attempts\. Try again in 14 minutes\./);
  assert.equal(out.body.error, out.body.message);
});

test("waiting times read naturally", () => {
  assert.equal(waitText(1), "a minute");
  assert.equal(waitText(61), "2 minutes");
  assert.equal(waitText(3600), "an hour");
  assert.equal(waitText(20 * 3600), "20 hours");
});

console.log("\n--- the key ---");

test("one window, one key; the next window, a new key", () => {
  const a = windowKey("login-email", "a@shop.in", T0 + 1 * MIN);
  const b = windowKey("login-email", "a@shop.in", T0 + 14 * MIN);
  const c = windowKey("login-email", "a@shop.in", T0 + 15 * MIN);
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
  assert.equal(a.resetAt.getTime(), T0 + 15 * MIN);
});

test("case and spacing do not make a second counter", () => {
  assert.equal(
    windowKey("login-email", " A@Shop.in ", T0).key,
    windowKey("login-email", "a@shop.in", T0).key
  );
});

test("buckets and callers do not share counters", () => {
  assert.notEqual(windowKey("login-email", "x", T0).key, windowKey("login-ip", "x", T0).key);
  assert.notEqual(windowKey("login-email", "a@shop.in", T0).key, windowKey("login-email", "b@shop.in", T0).key);
});

test("the key is keyed on AUTH_SECRET, so it cannot be matched back by hashing guesses", () => {
  const before = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "first-secret-0123456789";
  const a = windowKey("login-ip", "203.0.113.9", T0).key;
  process.env.AUTH_SECRET = "second-secret-0123456789";
  const b = windowKey("login-ip", "203.0.113.9", T0).key;
  if (before === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = before;
  assert.notEqual(a, b);
});

test("the stored key holds no email address or IP", () => {
  const { key } = windowKey("login-email", "owner@shop.in", T0);
  assert.ok(!key.includes("owner") && !key.includes("@"), key);
  assert.ok(!windowKey("login-ip", "203.0.113.9", T0).key.includes("203.0.113"));
});

console.log("\n--- the caller's address ---");

const VERCEL = { VERCEL: "1" };

test("on a trusted proxy: x-real-ip first, then the first x-forwarded-for entry", () => {
  const h = (o) => new Headers(o);
  assert.equal(clientIp(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1" }), VERCEL), "203.0.113.9");
  assert.equal(clientIp(h({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }), VERCEL), "198.51.100.4");
  assert.equal(clientIp(h({}), VERCEL), null);
});

test("without a trusted proxy the headers are the caller's, so they are not used", () => {
  const spoofed = new Headers({ "x-real-ip": "203.0.113.9" });
  assert.equal(clientIp(spoofed, {}), null);
  assert.equal(clientIp(spoofed, { TRUST_PROXY: "true" }), "203.0.113.9");
  assert.equal(proxyTrusted({}), false);
  assert.equal(proxyTrusted({ VERCEL: "1" }), true);
});

test("an IPv6 client is counted per /64, not per address", () => {
  assert.equal(ipBucket("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:0db8:0001:0002::9"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.notEqual(ipBucket("2001:db8:1:3::1"), ipBucket("2001:db8:1:2::1"));
});

test("IPv4, and IPv4 written as IPv6, stay per address", () => {
  assert.equal(ipBucket("203.0.113.9"), "203.0.113.9");
  assert.equal(ipBucket("::ffff:203.0.113.9"), "203.0.113.9");
});

/* ─────────────────────────────── the routes ────────────────────────────── */

console.log("\n--- wired into the routes ---");

const login = code(read("../app/api/auth/login/route.js"));
const register = code(read("../app/api/auth/register/route.js"));
const sendEmail = code(read("../app/api/send-email/route.js"));
const store = code(read("../lib/rateLimitStore.mjs"));
const model = code(read("../models/rateLimitModel.js"));

test("sign-in counts all three limits before any hashing", () => {
  const ip = login.indexOf('["login-ip", ip]');
  const pair = login.indexOf('["login-email-ip"');
  const email = login.indexOf('["login-email", address]');
  const hit = login.indexOf("hitRateLimit(bucket, id)");
  const hashing = login.indexOf("verifyPassword(");
  assert.ok(ip > 0 && pair > ip && email > pair, "network, address-on-network, address");
  assert.ok(hit > email && hashing > hit, "counted before the first scrypt");
  assert.match(login, /if \(ip\) checks\.push\(\["login-ip"/, "an untrusted address is not counted");
  assert.match(login, /status, headers/);
});

test("a successful sign-in clears only the address-on-this-network count", () => {
  const usable = login.indexOf("usable[0]");
  const clear = login.indexOf('clearRateLimit("login-email-ip"');
  assert.ok(clear > usable, "cleared only once the account is known good");
  assert.ok(!/clearRateLimit\("login-ip"/.test(login), "the network count is not cleared");
  assert.ok(!/clearRateLimit\("login-email",/.test(login), "the address-wide ceiling is not cleared");
});

test("sign-up is counted per network before the password is hashed", () => {
  const hit = register.indexOf('hitRateLimit("signup-ip", ip)');
  assert.match(register, /ip \? await hitRateLimit/, "an untrusted address is not counted");
  assert.ok(hit > 0);
  assert.ok(register.indexOf("hashPassword(") > hit);
  assert.ok(register.indexOf("SIGNUP_DISABLED") < hit, "a closed sign-up is not counted");
});

test("emailing a bill is capped per person, then per firm, before the send", () => {
  const user = sendEmail.indexOf('hitRateLimit("email-user"');
  const firm = sendEmail.indexOf('hitRateLimit("email-firm"');
  const send = sendEmail.indexOf("resend.emails.send(");
  assert.ok(user > 0 && firm > user && send > firm);
  assert.match(sendEmail, /byFirm = byUser\.allowed\s*\?/, "a refused person does not use up the firm's count");
  assert.ok(sendEmail.indexOf("sendProblem(") < user, "an invalid request is not counted");
  assert.match(sendEmail, /auth\?\.companyId/);
});

test("the counter is one atomic upsert, with the duplicate-key race retried", () => {
  assert.match(store, /\$inc:\s*\{\s*count:\s*1\s*\}/);
  assert.match(store, /upsert:\s*true/);
  assert.match(store, /11000/);
  assert.ok(!/\.find(One)?\(\s*\{\s*_id/.test(store.replace(/findOneAndUpdate/g, "")), "no read-then-write");
});

test("counters expire on their own and are not tenant-scoped", () => {
  assert.match(model, /expireAfterSeconds:\s*0/);
  assert.ok(!/tenantPlugin/.test(model), "sign-in is counted before there is a firm");
});

/* ───────────────────────────── stock alerts ────────────────────────────── */

console.log("\n--- acknowledging a stock alert ---");

const alerts = code(read("../app/api/stock-alerts/route.js"));

test("acknowledging asks for a write permission; reading stays as it was", () => {
  assert.match(alerts, /POST = tenantRoute\(handlePOST, \{ permission: "master:write" \}\)/);
  assert.match(alerts, /GET = tenantRoute\(handleGET\)/);
});

test("nobody who could acknowledge before loses it", () => {
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    if (perms.includes("report:read")) assert.ok(can(role, "master:write"), role);
  }
  assert.equal(can("biller", "master:write"), false);
});

console.log(`\n  ${passed} checks passed\n`);
