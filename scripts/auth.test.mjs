/**
 * Fixture tests for the auth core: roles, passwords, sessions.
 *
 *   node scripts/auth.test.mjs
 *
 * This is the first thing in the app standing between one customer's books and
 * another's, so the cases here are mostly about what must NOT happen: a role
 * reaching a page it has no business on, a tampered token being accepted, a
 * route nobody remembered to list being left open.
 */

import assert from "node:assert/strict";
import {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  isPublicPath,
  permissionForPath,
  canAccessPath,
} from "../lib/roles.mjs";
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  parseHash,
  passwordProblem,
  MIN_PASSWORD_LENGTH,
} from "../lib/password.mjs";
import { signSession, verifySession, SESSION_TTL_SECONDS } from "../lib/session.mjs";

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const SECRET = "x".repeat(32);

console.log("\n--- roles hold what they should ---");

await test("an owner holds every permission", () => {
  for (const p of PERMISSIONS) assert.ok(can("owner", p), `owner must hold ${p}`);
});

await test("only an owner reaches setup and the danger zone", () => {
  // Setup is where Clear All Data lives. A wrong click there empties the books.
  for (const role of ROLES) {
    assert.equal(can(role, "setup:write"), role === "owner", `setup:write for ${role}`);
    assert.equal(can(role, "user:manage"), role === "owner", `user:manage for ${role}`);
  }
});

await test("a biller can bill and nothing else", () => {
  assert.ok(can("biller", "invoice:write"));
  assert.ok(can("biller", "master:read"), "cannot pick a customer without this");
  for (const p of ["ledger:read", "master:write", "voucher:write", "voucher:read", "setup:write", "user:manage"]) {
    assert.ok(!can("biller", p), `a biller must not hold ${p}`);
  }
});

await test("an accountant keeps the books but does not run the firm", () => {
  for (const p of ["ledger:read", "voucher:write", "master:write", "report:read"]) {
    assert.ok(can("accountant", p), `accountant needs ${p}`);
  }
  assert.ok(!can("accountant", "setup:write"));
  assert.ok(!can("accountant", "user:manage"));
});

await test("an unknown or missing role holds nothing", () => {
  for (const role of ["admin", "", null, undefined, "OWNER", "Owner"]) {
    for (const p of PERMISSIONS) assert.ok(!can(role, p), `${role} must hold nothing`);
  }
});

await test("every role grants only permissions that exist", () => {
  for (const role of ROLES) {
    for (const p of ROLE_PERMISSIONS[role]) {
      assert.ok(PERMISSIONS.includes(p), `${role} grants unknown permission ${p}`);
    }
  }
});

console.log("\n--- paths demand the right permission ---");

await test("the danger zone routes are owner-only", () => {
  for (const path of ["/api/clear-all-data", "/api/clear-transactions", "/setup"]) {
    assert.equal(permissionForPath(path), "setup:write", path);
    assert.ok(canAccessPath("owner", path));
    assert.ok(!canAccessPath("accountant", path), `accountant reached ${path}`);
    assert.ok(!canAccessPath("biller", path), `biller reached ${path}`);
  }
});

await test("every role can read the letterhead, only the owner can change it", () => {
  // A biller who cannot read /api/company cannot print an invoice at all.
  for (const role of ROLES) {
    assert.ok(canAccessPath(role, "/api/company"), `${role} cannot read the letterhead`);
  }
  for (const path of ["/company", "/api/company-update"]) {
    assert.equal(permissionForPath(path), "setup:write", path);
    assert.ok(canAccessPath("owner", path));
    assert.ok(!canAccessPath("accountant", path), `accountant reached ${path}`);
    assert.ok(!canAccessPath("biller", path), `biller reached ${path}`);
  }
  // The update route must not be swallowed by the read rule's prefix.
  assert.equal(permissionForPath("/api/company"), null);
});

await test("a biller cannot open the ledger", () => {
  for (const path of ["/ledger", "/api/ledger", "/item-ledger", "/api/item-ledger"]) {
    assert.ok(!canAccessPath("biller", path), `biller reached ${path}`);
    assert.ok(canAccessPath("accountant", path), `accountant blocked from ${path}`);
  }
});

await test("a biller can write a sale and read the masters it needs", () => {
  for (const path of ["/saleadd", "/api/save-invoice", "/api/get-customer", "/api/get-item", "/api/item-stock"]) {
    assert.ok(canAccessPath("biller", path), `biller blocked from ${path}`);
  }
});

await test("a biller cannot change a master", () => {
  for (const path of ["/api/customer-add", "/api/item-alter", "/api/delete-cust", "/customeradd", "/itemadd"]) {
    assert.ok(!canAccessPath("biller", path), `biller reached ${path}`);
  }
});

await test("an unlisted api route is owner-only, not open", () => {
  // The whole point of the default: a route added later and never listed must
  // fail closed. This is the rule that stops the next feature leaking.
  assert.equal(permissionForPath("/api/something-nobody-listed"), "setup:write");
  assert.ok(!canAccessPath("biller", "/api/something-nobody-listed"));
  assert.ok(!canAccessPath("accountant", "/api/something-nobody-listed"));
  assert.ok(canAccessPath("owner", "/api/something-nobody-listed"));
});

await test("an unlisted page needs only a session", () => {
  assert.equal(permissionForPath("/"), null);
  for (const role of ROLES) assert.ok(canAccessPath(role, "/"), `${role} blocked from the dashboard`);
});

await test("the longest matching prefix wins", () => {
  // /api/auth/me must not be caught by a shorter rule, and /api/get-customer
  // must not be read as the write route.
  assert.equal(permissionForPath("/api/auth/me"), null);
  assert.equal(permissionForPath("/api/get-customer"), "master:read");
  assert.equal(permissionForPath("/api/customer-add"), "master:write");
});

await test("a trailing slash or query string changes nothing", () => {
  assert.equal(permissionForPath("/setup/"), "setup:write");
  assert.equal(permissionForPath("/setup?tab=1"), "setup:write");
  assert.equal(permissionForPath("/api/ledger/"), "ledger:read");
});

await test("a sub-path inherits its parent's rule", () => {
  assert.equal(permissionForPath("/api/ledger/anything"), "ledger:read");
  assert.equal(permissionForPath("/setup/deep/page"), "setup:write");
});

await test("a nested rule beats the broader one it sits inside", () => {
  // The real table has no nesting yet, so first-match and longest-match agree
  // and a bug here would stay invisible. This proves the behaviour with a
  // nested pair deliberately listed broad-first, which is how somebody adding
  // a rule later would naturally write it.
  const rules = [
    ["/api/reports", "report:read"],
    ["/api/reports/payroll", "setup:write"],
  ];
  assert.equal(permissionForPath("/api/reports", rules), "report:read");
  assert.equal(permissionForPath("/api/reports/summary", rules), "report:read");
  assert.equal(permissionForPath("/api/reports/payroll", rules), "setup:write");
  assert.equal(permissionForPath("/api/reports/payroll/2026", rules), "setup:write");
  assert.ok(canAccessPath("accountant", "/api/reports/summary", rules));
  assert.ok(!canAccessPath("accountant", "/api/reports/payroll", rules));
});

await test("a path that merely starts with the same letters does not match", () => {
  // "/setupxyz" is not under "/setup".
  assert.equal(permissionForPath("/setupxyz"), null);
});

console.log("\n--- only the sign-in pages are public ---");

await test("sign-in and sign-up are reachable signed out", () => {
  for (const path of ["/login", "/signup", "/api/auth/login", "/api/auth/register", "/api/auth/logout"]) {
    assert.ok(isPublicPath(path), `${path} must be public`);
  }
});

await test("nothing else is public", () => {
  for (const path of ["/", "/setup", "/saleadd", "/ledger", "/api/get-customer", "/api/auth/me", "/api/clear-all-data"]) {
    assert.ok(!isPublicPath(path), `${path} must NOT be public`);
  }
});

await test("a public path cannot be faked with a suffix", () => {
  assert.ok(!isPublicPath("/login/../setup"));
  assert.ok(!isPublicPath("/loginx"));
  assert.ok(!isPublicPath("/api/auth/login/extra"));
});

console.log("\n--- passwords ---");

await test("the right password verifies and a wrong one does not", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("Correct horse battery", stored), false);
  assert.equal(await verifyPassword("correct horse batter", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

await test("the same password hashes differently every time", async () => {
  // A shared salt would make two users with the same password obvious.
  const a = await hashPassword("same password here");
  const b = await hashPassword("same password here");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same password here", a), true);
  assert.equal(await verifyPassword("same password here", b), true);
});

await test("the password itself never appears in the stored string", async () => {
  const stored = await hashPassword("hunter2 hunter2");
  assert.ok(!stored.includes("hunter2"));
});

await test("the parameters travel with the hash", async () => {
  const stored = await hashPassword("a strong password");
  const parsed = parseHash(stored);
  assert.equal(parsed.N, 65536);
  assert.equal(parsed.keylen, 64);
  assert.equal(parsed.hash.length, 64);
  assert.equal(parsed.salt.length, 16);
});

await test("a hash made with weaker settings still verifies", async () => {
  // Raising the cost later must not lock anybody out.
  const weak = await hashPassword("an old password", { N: 1024, r: 8, p: 1, keylen: 32 });
  assert.equal(await verifyPassword("an old password", weak), true);
  assert.equal(needsRehash(weak), true, "and it should be flagged for upgrade");
});

await test("a current hash is not flagged for rehash", async () => {
  assert.equal(needsRehash(await hashPassword("a current password")), false);
});

await test("garbage in the password column is a failed sign-in, not a crash", async () => {
  for (const junk of ["", null, undefined, "not-a-hash", "scrypt$$$$$$", "scrypt$1$2$3$4$zz$zz", "bcrypt$x$y"]) {
    assert.equal(await verifyPassword("anything", junk), false, `junk: ${junk}`);
    assert.equal(parseHash(junk), null, `parse: ${junk}`);
  }
});

await test("a short password is refused before it is ever hashed", async () => {
  assert.ok(passwordProblem("short"), "must be refused");
  assert.equal(passwordProblem("x".repeat(MIN_PASSWORD_LENGTH)), null);
  await assert.rejects(() => hashPassword("short"));
  await assert.rejects(() => hashPassword(""));
  await assert.rejects(() => hashPassword("        "), "spaces are not a password");
});

await test("the same password typed on different keyboards still matches", async () => {
  // e + combining acute vs the single precomposed character. Normalising means
  // a Mac and a Windows user who typed the same thing both get in.
  const stored = await hashPassword("passéword");
  assert.equal(await verifyPassword("passéword", stored), true);
});

console.log("\n--- sessions ---");

await test("a signed session reads back with who and which firm", async () => {
  const token = await signSession({ uid: "u1", cid: "c1", role: "owner", v: 3 }, SECRET);
  const claims = await verifySession(token, SECRET);
  assert.equal(claims.uid, "u1");
  assert.equal(claims.cid, "c1");
  assert.equal(claims.role, "owner");
  assert.equal(claims.v, 3);
});

await test("another secret cannot read it", async () => {
  const token = await signSession({ uid: "u1", cid: "c1", role: "owner" }, SECRET);
  assert.equal(await verifySession(token, "y".repeat(32)), null);
});

await test("editing the payload breaks the signature", async () => {
  // The attack this is all for: change cid to another firm's id and read their
  // books. Without the matching secret the signature cannot be redone.
  const token = await signSession({ uid: "u1", cid: "c1", role: "biller" }, SECRET);
  const [body, mac] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());

  payload.cid = "SOMEBODY-ELSES-COMPANY";
  const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal(await verifySession(`${forgedBody}.${mac}`, SECRET), null);

  payload.cid = "c1";
  payload.role = "owner";
  const escalated = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal(await verifySession(`${escalated}.${mac}`, SECRET), null);
});

await test("an expired session is refused", async () => {
  const token = await signSession({ uid: "u1", cid: "c1", role: "owner" }, SECRET);
  const justBefore = Date.now() + (SESSION_TTL_SECONDS - 10) * 1000;
  const justAfter = Date.now() + (SESSION_TTL_SECONDS + 10) * 1000;
  assert.ok(await verifySession(token, SECRET, { now: justBefore }));
  assert.equal(await verifySession(token, SECRET, { now: justAfter }), null);
});

await test("a token with no signature at all is refused", async () => {
  // Expiry is checked after the signature, so an unsigned token is never read.
  const body = Buffer.from(JSON.stringify({
    uid: "u1", cid: "c1", role: "owner", v: 0,
    iat: 0, exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  assert.equal(await verifySession(body, SECRET), null);
  assert.equal(await verifySession(`${body}.`, SECRET), null);
  assert.equal(await verifySession(`${body}.AAAA`, SECRET), null);
});

await test("rubbish in the cookie is just no session", async () => {
  for (const junk of ["", null, undefined, "....", "a.b", "{}", "null", "a".repeat(500)]) {
    assert.equal(await verifySession(junk, SECRET), null, `junk: ${junk}`);
  }
});

await test("a session without a company is refused", async () => {
  // Every query the app makes hangs off cid. A session missing it must never
  // come into existence.
  await assert.rejects(() => signSession({ uid: "u1", role: "owner" }, SECRET));
  await assert.rejects(() => signSession({ cid: "c1", role: "owner" }, SECRET));
  await assert.rejects(() => signSession({ uid: "u1", cid: "c1" }, SECRET));
});

await test("a signed token still missing its company is refused on read", async () => {
  // signSession will not make one, so forge it with the real secret: this is
  // the defence-in-depth check, for a token minted by older code or by hand.
  const te = new TextEncoder();
  const body = Buffer.from(JSON.stringify({
    uid: "u1", role: "owner", v: 0,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw", te.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, te.encode(body))).toString("base64url");

  // Properly signed, unexpired -- and still refused, because it names no firm.
  assert.equal(await verifySession(`${body}.${mac}`, SECRET), null);
});

await test("a weak secret is refused outright", async () => {
  await assert.rejects(() => signSession({ uid: "u", cid: "c", role: "owner" }, "short"));
  await assert.rejects(() => signSession({ uid: "u", cid: "c", role: "owner" }, ""));
  await assert.rejects(() => signSession({ uid: "u", cid: "c", role: "owner" }, undefined));
});

await test("the token carries no secret and no password", async () => {
  const token = await signSession({ uid: "u1", cid: "c1", role: "owner" }, SECRET);
  assert.ok(!token.includes(SECRET));
  const body = Buffer.from(token.split(".")[0], "base64url").toString();
  assert.ok(!body.includes("password"));
  assert.ok(!body.includes(SECRET));
});

console.log(`\n  ${passed} checks passed\n`);
