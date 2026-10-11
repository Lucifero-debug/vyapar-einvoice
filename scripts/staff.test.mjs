/**
 * Staff management: the rules, the permissions, and the wiring.
 *
 * Run with bare node -- lib/staffRules.mjs imports nothing but
 * lib/passwordRules.mjs, which imports nothing at all.
 *
 *
 * WHAT THIS SUITE IS REALLY FOR
 * -----------------------------
 * Two things, and the second one is the point.
 *
 * The RULES are ordinary logic and ordinary tests: who may be given which
 * role, who may not be switched off, when a session has to be killed.
 *
 * The WIRING is the part no amount of careful coding keeps safe. `users` is
 * one of the three collections with no tenantPlugin on it, so inside a
 * perfectly correct `tenantRoute` handler a bare `User.find({})` returns every
 * firm's staff, with no error and nothing in a log. The sweep at the bottom
 * fails the build if any staff route names `User` at all, or reads a
 * companyId out of a request. That is a thing a static check can actually
 * guarantee, and a code review cannot.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ASSIGNABLE_ROLES,
  ROLE_LABELS,
  STATUS_FILTERS,
  deactivateProblem,
  emailProblem,
  filterStaff,
  isAssignableRole,
  matchesSearch,
  nameProblem,
  needsTokenBump,
  normalizeEmail,
  publicStaff,
  roleChangeProblem,
  rowPowers,
  staffCreateProblems,
  staffSummary,
} from "../lib/staffRules.mjs";
import {
  PASSWORD_CHANGE_PATHS,
  ROLE_PERMISSIONS,
  allowedWhilePasswordChangeDue,
  can,
  canAccessPath,
  permissionForPath,
} from "../lib/roles.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

/** Read a project file, for the wiring checks. Declared with the helper. */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * Source with its comments removed.
 *
 * Needed because these files EXPLAIN the mistakes they avoid, and a sweep that
 * greps for `User.find({})` finds the sentence warning against it. Four of
 * these checks failed on their own prose the first time they ran.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const owner = (over = {}) => ({ _id: "own1", role: "owner", active: true, ...over });
const biller = (over = {}) => ({ _id: "bil1", role: "biller", active: true, ...over });
const accountant = (over = {}) => ({ _id: "acc1", role: "accountant", active: true, ...over });

const GOOD = { name: "Ravi Kumar", email: "ravi@firm.com", role: "biller", password: "shopfloor1" };

console.log("\n--- only two roles can be handed out ---");

test("the assignable list is exactly accountant and biller", () => {
  assert.deepEqual([...ASSIGNABLE_ROLES].sort(), ["accountant", "biller"]);
});

test("owner is not assignable, and neither is anything invented", () => {
  assert.equal(isAssignableRole("owner"), false);
  assert.equal(isAssignableRole("admin"), false);
  assert.equal(isAssignableRole("superuser"), false);
  assert.equal(isAssignableRole(""), false);
  assert.equal(isAssignableRole(null), false);
  // A WHITELIST, not a blacklist of "owner": the difference is that a fourth
  // role added to roles.mjs tomorrow is refused here without anybody
  // remembering to refuse it.
  assert.equal(isAssignableRole("accountant"), true);
  assert.equal(isAssignableRole("biller"), true);
});

test("asking for owner on create is refused, and says why", () => {
  const problems = staffCreateProblems({ ...GOOD, role: "owner" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot be made owners/i);
});

test("a garbled role gets the plain prompt, not the owner sentence", () => {
  const problems = staffCreateProblems({ ...GOOD, role: "biler" });
  assert.match(problems[0], /Pick a role/i);
});

console.log("\n--- what a new staff member needs ---");

test("a complete staff member has nothing wrong with them", () => {
  assert.deepEqual(staffCreateProblems(GOOD), []);
});

test("every problem is reported at once, not one per round trip", () => {
  const problems = staffCreateProblems({ name: "", email: "nope", role: "owner", password: "x" });
  assert.equal(problems.length, 4, problems.join(" | "));
});

test("a name is required, because it is the column the list is read by", () => {
  assert.ok(nameProblem(""));
  assert.ok(nameProblem("   "));
  assert.equal(nameProblem("Ravi"), null);
});

test("the email rule is the same loose one sign-up uses", () => {
  // Two different rules would be worse than either: an address accepted at
  // sign-up and refused here reads as a bug.
  assert.equal(emailProblem("ravi@firm.com"), null);
  assert.equal(emailProblem("ravi+gst@firm.co.in"), null);
  // A BLANK field and a MALFORMED one get different sentences. The pattern
  // rejects "" as well, so dropping the blank check leaves the rule correct
  // and the wording wrong -- "Enter a valid email address" against an empty
  // box reads as a complaint about something the person has not typed yet.
  assert.match(emailProblem(""), /^Enter an email address/);
  assert.match(emailProblem("   "), /^Enter an email address/);
  assert.match(emailProblem("ravi"), /valid email address/);
  assert.ok(emailProblem("ravi"));
  assert.ok(emailProblem("ravi@firm"));
  assert.ok(emailProblem("ravi @firm.com"));
});

test("the address is stored lowercased and trimmed", () => {
  // It has to match what userModel's own `lowercase: true` will store, or the
  // clash check compares a different string from the unique index.
  assert.equal(normalizeEmail("  Ravi@Firm.COM "), "ravi@firm.com");
  assert.equal(normalizeEmail(null), "");
});

test("the password rule is reused, not reimplemented", () => {
  // Importing it rather than copying the length is the whole point: one rule
  // for sign-up, staff creation and the change page.
  assert.ok(staffCreateProblems({ ...GOOD, password: "short" }).some((p) => /8 characters/.test(p)));
  assert.deepEqual(staffCreateProblems({ ...GOOD, password: "        " }).length > 0, true);
});

console.log("\n--- a firm can never be left without an owner ---");

test("you cannot change your own role", () => {
  // `user:manage` is the owner's alone, so an owner who demotes themselves has
  // shut the door they are standing in and cannot reopen it.
  const problem = roleChangeProblem({
    actorId: "own1",
    target: owner(),
    nextRole: "biller",
    activeOwners: 3,
  });
  assert.match(problem, /your own role/i);
});

test("the last active owner cannot be demoted by anybody", () => {
  const problem = roleChangeProblem({
    actorId: "own2",
    target: owner(),
    nextRole: "accountant",
    activeOwners: 1,
  });
  assert.match(problem, /only active owner/i);
});

test("an owner can be demoted while another active one remains", () => {
  assert.equal(
    roleChangeProblem({ actorId: "own2", target: owner(), nextRole: "accountant", activeOwners: 2 }),
    null
  );
});

test("promoting to owner is refused through the edit route too", () => {
  // The create route is not the only way in. "Do not allow staff creation to
  // assign Owner" is useless if an edit can do it a second later.
  const problem = roleChangeProblem({
    actorId: "own1",
    target: biller(),
    nextRole: "owner",
    activeOwners: 1,
  });
  assert.match(problem, /cannot be created from the staff page/i);
});

test("accountant and biller swap freely", () => {
  assert.equal(
    roleChangeProblem({ actorId: "own1", target: biller(), nextRole: "accountant", activeOwners: 1 }),
    null
  );
  assert.equal(
    roleChangeProblem({ actorId: "own1", target: accountant(), nextRole: "biller", activeOwners: 1 }),
    null
  );
});

test("a role that is not changing is not a change", () => {
  // Re-saving somebody's name must not trip the self-demotion guard.
  assert.equal(
    roleChangeProblem({ actorId: "own1", target: owner(), nextRole: "owner", activeOwners: 1 }),
    null
  );
});

test("a staff member from another firm is refused, not crashed into", () => {
  assert.match(roleChangeProblem({ actorId: "own1", target: null, nextRole: "biller" }), /not at this firm/i);
  assert.match(deactivateProblem({ actorId: "own1", target: null }), /not at this firm/i);
});

console.log("\n--- switching an account off ---");

test("you cannot deactivate yourself", () => {
  assert.match(
    deactivateProblem({ actorId: "own1", target: owner(), activeOwners: 5 }),
    /your own account/i
  );
});

test("the last active owner cannot be switched off", () => {
  assert.match(
    deactivateProblem({ actorId: "own2", target: owner(), activeOwners: 1 }),
    /lock the firm out/i
  );
});

test("an ordinary staff member can be switched off", () => {
  assert.equal(deactivateProblem({ actorId: "own1", target: biller(), activeOwners: 1 }), null);
});

test("reactivating is never refused", () => {
  // Turning somebody back on cannot lock a firm out of anything -- including
  // yourself, and including the last owner.
  assert.equal(
    deactivateProblem({ actorId: "own1", target: owner({ active: false }), activeOwners: 0 }),
    null
  );
  assert.equal(
    deactivateProblem({ actorId: "own1", target: biller({ active: false }), activeOwners: 1 }),
    null
  );
});

console.log("\n--- which changes end a session ---");

test("a role change ends the session", () => {
  // Not belt-and-braces: middleware.js decides which PAGES a request may
  // reach from the role in the TOKEN, because it runs at the edge with no
  // database. Until a new token is issued, a promoted biller stays locked out
  // of the ledger page and a demoted accountant still gets past the gate to
  // it. Only a fresh sign-in makes the edge and the database agree.
  assert.equal(needsTokenBump({ before: { role: "biller" }, after: { role: "accountant" } }), true);
  assert.equal(needsTokenBump({ before: { role: "accountant" }, after: { role: "biller" } }), true);
});

test("deactivation ends the session", () => {
  assert.equal(
    needsTokenBump({ before: { role: "biller", active: true }, after: { role: "biller", active: false } }),
    true
  );
});

test("reactivation does not, because there is nothing to end", () => {
  assert.equal(
    needsTokenBump({ before: { role: "biller", active: false }, after: { role: "biller", active: true } }),
    false
  );
});

test("a new password ends the session", () => {
  assert.equal(
    needsTokenBump({ before: { role: "biller" }, after: { role: "biller", passwordChanged: true } }),
    true
  );
});

test("renaming somebody does not sign them out", () => {
  // A bump that fires on every edit would make the feature unusable: fixing a
  // typo in a name would throw the person out of the till.
  assert.equal(
    needsTokenBump({
      before: { role: "biller", active: true },
      after: { role: "biller", active: true },
    }),
    false
  );
});

console.log("\n--- nothing sensitive leaves the server ---");

test("the response shape is built from a whitelist", () => {
  const out = publicStaff({
    _id: "u1",
    name: "Ravi",
    email: "R@Firm.com",
    role: "biller",
    active: true,
    passwordHash: "scrypt$65536$8$1$64$deadbeef$cafe",
    tokenVersion: 7,
    companyId: "c1",
  });
  assert.equal(out.passwordHash, undefined, "a hash must never be copied out");
  assert.equal(out.tokenVersion, undefined);
  assert.equal(out.companyId, undefined, "the firm id is not the browser's business");
  // The values, not only the key list. Both of these survived the first
  // mutation round: a shape test that checks Object.keys and nothing else
  // passes just as happily when every field is wrong.
  assert.equal(out.email, "r@firm.com", "the stored, normalised address");
  assert.equal(out.id, "u1");
  assert.equal(out.name, "Ravi");
  assert.equal(out.role, "biller");
  assert.equal(out.active, true);
  assert.equal(out.mustChangePassword, false, "absent means they have already set one");
  assert.deepEqual(Object.keys(out).sort(), [
    "active",
    "createdAt",
    "email",
    "id",
    "lastLoginAt",
    "mustChangePassword",
    "name",
    "role",
  ]);
});

test("no serialised staff object can carry a hash whatever is thrown at it", () => {
  // The property that matters, stated as a property: whatever the input, the
  // output JSON contains no hash. Built field by field rather than by
  // deleting, because "we remembered to delete it" is the weaker guarantee.
  for (const nasty of [
    { passwordHash: "x" },
    { _id: "1", passwordHash: "scrypt$1$2$3$4$ab$cd", name: "A" },
    { toJSON: () => ({ passwordHash: "sneaky" }) },
  ]) {
    assert.doesNotMatch(JSON.stringify(publicStaff(nasty)), /scrypt|passwordHash|sneaky/);
  }
});

test("an absent account is still a sensible shape", () => {
  const out = publicStaff({});
  assert.equal(out.id, "");
  assert.equal(out.active, true, "absent means active, as the model's default says");
  assert.equal(out.mustChangePassword, false);
});

test("a staff member who owes a password change is reported as owing one", () => {
  // Inverting this flag is invisible on the server and loud on screen: every
  // row would read "has not set their own password yet".
  assert.equal(publicStaff({ mustChangePassword: true }).mustChangePassword, true);
  assert.equal(publicStaff({ mustChangePassword: false }).mustChangePassword, false);
});

console.log("\n--- only owners manage staff ---");

test("user:manage is the owner's alone", () => {
  assert.equal(can("owner", "user:manage"), true);
  assert.equal(can("accountant", "user:manage"), false);
  assert.equal(can("biller", "user:manage"), false);
  // Stated against the role table too, so adding it to a list is caught here
  // and not only through canAccessPath.
  assert.equal(ROLE_PERMISSIONS.accountant.includes("user:manage"), false);
  assert.equal(ROLE_PERMISSIONS.biller.includes("user:manage"), false);
});

test("every staff path demands user:manage", () => {
  for (const path of [
    "/staff",
    "/api/staff",
    "/api/staff-add",
    "/api/staff-alter",
    "/api/staff-status",
  ]) {
    assert.equal(permissionForPath(path), "user:manage", path);
    assert.equal(canAccessPath("owner", path), true, path);
    assert.equal(canAccessPath("accountant", path), false, path);
    assert.equal(canAccessPath("biller", path), false, path);
  }
});

test("each staff route is listed separately, because prefixes do not nest", () => {
  // "/api/staff-add" does not match the "/api/staff" rule -- a rule matches an
  // exact path or one followed by "/". A route left out would fall through to
  // the /api default, which is setup:write: still owner-only, so the mistake
  // fails closed, but by luck rather than design.
  const src = read("../lib/roles.mjs");
  for (const path of ["/api/staff", "/api/staff-add", "/api/staff-alter", "/api/staff-status", "/staff"]) {
    assert.ok(src.includes(`["${path}", "user:manage"]`), `${path} is not in PATH_RULES`);
  }
});

test("changing your own password needs no permission beyond signing in", () => {
  // A biller must be able to replace the password their owner read out. An
  // unlisted /api path would land them on setup:write, which is owner-only.
  assert.equal(permissionForPath("/api/change-password"), null);
  for (const role of ["owner", "accountant", "biller"]) {
    assert.equal(canAccessPath(role, "/api/change-password"), true, role);
    assert.equal(canAccessPath(role, "/change-password"), true, role);
  }
});

console.log("\n--- an owner-set password has to be replaced ---");

test("the allowlist is tiny and holds only what the change needs", () => {
  assert.deepEqual([...PASSWORD_CHANGE_PATHS].sort(), [
    "/api/auth/logout",
    "/api/auth/me",
    "/api/change-password",
    "/change-password",
  ]);
});

test("everything else is closed while a password change is owed", () => {
  for (const path of ["/", "/saleadd", "/api/save-invoice", "/api/staff", "/ledger", "/api/get-customer"]) {
    assert.equal(allowedWhilePasswordChangeDue(path), false, path);
  }
});

test("logout stays open, so somebody who will not set one can still leave", () => {
  assert.equal(allowedWhilePasswordChangeDue("/api/auth/logout"), true);
  assert.equal(allowedWhilePasswordChangeDue("/api/auth/me"), true);
  assert.equal(allowedWhilePasswordChangeDue("/change-password/"), true, "a trailing slash is the same page");
});

test("the gate is in requireAuth, not in the browser", () => {
  // A client-side redirect is a suggestion: the API is reachable with curl
  // and a cookie.
  const src = read("../lib/authServer.mjs");
  assert.ok(/allowedWhilePasswordChangeDue/.test(src));
  assert.ok(/mustChangePassword === true/.test(src));
  assert.ok(/password_change_required/.test(src));
  // Selected, or the flag reads as undefined and the gate never fires.
  assert.match(src, /\.select\("[^"]*mustChangePassword/);
});

test("a created account owes a change, so the owner never knows the live password", () => {
  const src = read("../app/api/staff-add/route.js");
  assert.ok(/mustChangePassword: true/.test(src));
  // And an owner resetting a forgotten password puts the debt back.
  assert.ok(/mustChangePassword = true|mustChangePassword: true/.test(read("../app/api/staff-alter/route.js")));
});

console.log("\n--- the list, the filters and the figures ---");

test("the three figures count everyone, including owners", () => {
  // DELIBERATELY LOPSIDED. With two active and two inactive, `inactive:
  // active` is right by accident and the mutation survived -- the same flaw
  // as a money fixture made of round thousands.
  const list = [
    { id: "1", role: "owner", active: true },
    { id: "2", role: "accountant", active: true },
    { id: "3", role: "biller", active: true },
    { id: "4", role: "biller", active: false },
  ];
  assert.deepEqual(staffSummary(list), {
    total: 4,
    active: 3,
    inactive: 1,
    byRole: { owner: 1, accountant: 1, biller: 2 },
  });
});

test("an absent active flag counts as active", () => {
  assert.equal(staffSummary([{ id: "1", role: "biller" }]).active, 1);
});

test("search looks at the name and the address, case-insensitively", () => {
  const person = { name: "Ravi Kumar", email: "ravi.k@firm.com" };
  assert.equal(matchesSearch(person, "ravi"), true);
  assert.equal(matchesSearch(person, "KUMAR"), true);
  assert.equal(matchesSearch(person, "FIRM.COM"), true);
  assert.equal(matchesSearch(person, "sunita"), false);
  assert.equal(matchesSearch(person, ""), true, "an empty box filters nothing");
  assert.equal(matchesSearch(person, "   "), true);
});

test("the filters combine rather than override each other", () => {
  const list = [
    { id: "1", name: "Ravi", email: "ravi@f.com", role: "biller", active: true },
    { id: "2", name: "Ravi Two", email: "ravi2@f.com", role: "biller", active: false },
    { id: "3", name: "Sunita", email: "s@f.com", role: "accountant", active: true },
    { id: "4", name: "Boss", email: "b@f.com", role: "owner", active: true },
  ];
  // Each one alone.
  assert.deepEqual(filterStaff({ staff: list, role: "biller" }).map((p) => p.id), ["1", "2"]);
  assert.deepEqual(filterStaff({ staff: list, status: "inactive" }).map((p) => p.id), ["2"]);
  assert.deepEqual(filterStaff({ staff: list, search: "ravi" }).map((p) => p.id), ["1", "2"]);
  // Together -- the case a per-filter test cannot see.
  assert.deepEqual(
    filterStaff({ staff: list, search: "ravi", role: "biller", status: "active" }).map((p) => p.id),
    ["1"]
  );
  assert.deepEqual(filterStaff({ staff: list }).map((p) => p.id), ["1", "2", "3", "4"]);
});

test("the status filter has exactly three settings", () => {
  assert.deepEqual(STATUS_FILTERS, ["all", "active", "inactive"]);
});

test("every role has a label, so no row shows a bare code", () => {
  for (const role of ["owner", "accountant", "biller"]) {
    assert.ok(ROLE_LABELS[role], role);
  }
});

console.log("\n--- the screen and the server agree about each row ---");

test("the owner's own row is shown with both controls locked", () => {
  const powers = rowPowers({
    actorId: "own1",
    staff: { id: "own1", role: "owner", active: true },
    activeOwners: 1,
  });
  assert.equal(powers.self, true);
  assert.equal(powers.canChangeRole, false);
  assert.equal(powers.canDeactivate, false);
  // And it says WHY, rather than just greying out -- the lesson from the
  // Against Bill tick, which looked broken for exactly that reason.
  assert.ok(powers.roleReason);
  assert.ok(powers.statusReason);
});

test("an ordinary row is fully editable", () => {
  const powers = rowPowers({
    actorId: "own1",
    staff: { id: "bil1", role: "biller", active: true },
    activeOwners: 1,
  });
  assert.equal(powers.self, false);
  assert.equal(powers.canChangeRole, true);
  assert.equal(powers.canDeactivate, true);
  assert.equal(powers.roleReason, null);
  assert.equal(powers.statusReason, null);
});

test("a deactivated row offers reactivation with no reason against it", () => {
  const powers = rowPowers({
    actorId: "own1",
    staff: { id: "bil1", role: "biller", active: false },
    activeOwners: 1,
  });
  assert.equal(powers.canDeactivate, true);
  assert.equal(powers.statusReason, null);
});

test("what the screen greys out is what the server refuses", () => {
  // The same module both ways, so the two cannot drift. If rowPowers said a
  // row was editable and roleChangeProblem refused it, the owner would get an
  // error from a control that looked live.
  for (const staff of [
    { id: "own1", role: "owner", active: true },
    { id: "own2", role: "owner", active: true },
    { id: "bil1", role: "biller", active: true },
    { id: "acc1", role: "accountant", active: true },
  ]) {
    for (const activeOwners of [1, 2]) {
      const powers = rowPowers({ actorId: "own1", staff, activeOwners });
      const refusal = deactivateProblem({
        actorId: "own1",
        target: { _id: staff.id, role: staff.role, active: staff.active },
        activeOwners,
      });
      assert.equal(
        powers.canDeactivate,
        refusal === null,
        `${staff.id} with ${activeOwners} owner(s): screen says ${powers.canDeactivate}, server says ${refusal}`
      );
    }
  }
});

console.log("\n--- the users collection is reached one way only ---");

const STAFF_ROUTES = [
  "../app/api/staff/route.js",
  "../app/api/staff-add/route.js",
  "../app/api/staff-alter/route.js",
  "../app/api/staff-status/route.js",
  "../app/api/change-password/route.js",
];

test("there are routes to check at all", () => {
  // Guards against the sweep below silently finding nothing and passing.
  for (const route of STAFF_ROUTES) assert.ok(read(route).length > 200, route);
});

test("no staff route touches the User model directly", () => {
  // THE CHECK THIS WHOLE SUITE EXISTS FOR. `users` carries no tenantPlugin, so
  // a bare User.find({}) inside a correctly wrapped handler returns EVERY
  // firm's staff -- no error, nothing in a log. Every read and write goes
  // through lib/staffStore.mjs, which refuses to run without a companyId.
  for (const route of STAFF_ROUTES) {
    const src = read(route);
    assert.doesNotMatch(src, /\bUser\s*\./, `${route} queries User directly`);
    assert.doesNotMatch(src, /from\s+["'].*userModel/, `${route} imports the User model`);
  }
});

test("every staff route establishes its firm through the wrapper", () => {
  for (const route of STAFF_ROUTES) {
    const src = read(route);
    assert.ok(/@\/lib\/tenantRoute\.mjs/.test(src), `${route} does not import tenantRoute`);
    assert.match(src, /export const (GET|POST|PATCH|DELETE) = tenantRoute\(/, route);
    assert.doesNotMatch(
      src,
      /^export\s+async\s+function\s+(GET|POST|PATCH|DELETE)\b/m,
      `${route} exports a bare handler`
    );
  }
});

test("no staff route takes a firm id from the request", () => {
  // The one field a request must never be able to choose. requireAuth reads it
  // off the user record and cross-checks it against the token.
  for (const route of STAFF_ROUTES) {
    const src = read(route);
    assert.doesNotMatch(src, /body\.companyId|searchParams\.get\(\s*["']company/, route);
    assert.ok(/auth\.companyId/.test(src), `${route} never names auth.companyId`);
  }
});

test("the staff routes stayed out of app/api/auth", () => {
  // scripts/tenant-scope.test.mjs exempts app/api/auth from the wrapper
  // requirement and caps it at five files. Putting a staff route there would
  // spend that budget and skip the scoping check.
  for (const route of STAFF_ROUTES) {
    assert.doesNotMatch(route, /api\/auth\//, route);
  }
});

test("the store refuses to query without a firm", () => {
  const src = read("../lib/staffStore.mjs");
  assert.ok(/StaffScopeError/.test(src));
  // Every exported function takes companyId first. Checked on the signatures
  // rather than trusted, because the whole guarantee rests on it.
  const exported = [...src.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
  assert.ok(exported.length >= 6, `only found ${exported.length} store functions`);
  for (const [, name, params] of exported) {
    assert.match(params.trim(), /^companyId\b/, `${name} does not take companyId first`);
  }
  // And each one passes it through the guard rather than straight to Mongo.
  assert.ok(
    (src.match(/scope\(companyId,/g) || []).length >= exported.length,
    "a store function skips the scope() guard"
  );
});

test("the store never reuses findNameClash for the email check", () => {
  // It is generic over the model, so findNameClash(User, "email", ...) looks
  // right and is a cross-tenant leak: with no plugin on the schema it searches
  // every firm, and would report "already in use" because ANOTHER business
  // employs somebody of that name.
  // Comments stripped: the module's own header spells out the call it is NOT
  // making, so even matching on the call shape finds the warning against it.
  const src = stripComments(read("../lib/staffStore.mjs"));
  assert.doesNotMatch(src, /findNameClash/);
  assert.doesNotMatch(src, /from\s+["'][^"']*uniqueName/);
  // It does its own, with the collation the unique index was declared with.
  assert.ok(/strength: 2/.test(src), "the clash check must match the index's collation");
  assert.ok(/collation\(EMAIL_COLLATION\)/.test(src));
});

test("every staff lookup is filtered on the firm as well as the id", () => {
  // So another firm's user id comes back null rather than as their record --
  // the behaviour tenantPlugin gives findById everywhere else.
  // Comments stripped first. The header explains the danger by quoting a bare
  // `User.find({})`, and the sweep cannot tell that from a real query.
  const src = stripComments(read("../lib/staffStore.mjs"));
  const finds = [...src.matchAll(/User\.(findOne|find|countDocuments|findOneAndUpdate)\(\s*\{([^}]*)\}/g)];
  assert.ok(finds.length >= 5, `only found ${finds.length} queries`);
  for (const [, method, filter] of finds) {
    assert.match(filter, /companyId: cid/, `${method} is not scoped: {${filter}}`);
  }
});

test("the hash is asked for by name in exactly one place", () => {
  const src = read("../lib/staffStore.mjs");
  assert.equal(
    (src.match(/\+passwordHash/g) || []).length,
    1,
    "only the password check should select the hash"
  );
  assert.ok(/findStaffForPasswordCheck/.test(src));
  // And the field list used everywhere else does not mention it.
  assert.doesNotMatch(src.slice(src.indexOf("SAFE_FIELDS =")), /^const SAFE_FIELDS.*passwordHash/m);
});

console.log("\n--- deactivation actually locks somebody out ---");

test("requireAuth refuses an inactive user and a stale token", () => {
  // Already true before this feature; asserted here because the staff page is
  // what now relies on it.
  const src = read("../lib/authServer.mjs");
  assert.ok(/user\.active === false/.test(src));
  assert.ok(/tokenVersion \|\| 0\) !== \(claims\.v \|\| 0\)/.test(src));
  // The role comes off the USER, not the token, so a demotion bites at once.
  assert.ok(/permission \?\? permissionForPath/.test(src));
});

test("the status route bumps the token in the same write as the flag", () => {
  // Two writes can half-succeed, and whichever lands first decides which
  // wrong state the firm is left in: an account switched off whose tokens
  // still work, or tokens killed on an account still marked active.
  const store = read("../lib/staffStore.mjs");
  assert.ok(/\$inc = \{ tokenVersion: 1 \}/.test(store));
  const update = store.slice(store.indexOf("export async function updateStaff"));
  assert.ok(
    update.indexOf("$inc") < update.indexOf("findOneAndUpdate"),
    "the bump has to be part of the update, not a second call"
  );
  assert.equal((update.match(/findOneAndUpdate|updateOne/g) || []).length, 1, "one write, not two");
});

test("the status route asks the rules before switching anybody off", () => {
  const src = read("../app/api/staff-status/route.js");
  assert.ok(/deactivateProblem/.test(src));
  assert.ok(/needsTokenBump/.test(src));
  // And only guards the OFF direction, since turning somebody on is safe.
  assert.ok(/if \(!active\)/.test(src));
});

test("a missing active flag is refused rather than defaulted", () => {
  // Defaulting it either way is a silent deactivation or a silent no-op.
  const src = read("../app/api/staff-status/route.js");
  assert.ok(/typeof body\.active !== "boolean"/.test(src));
});

test("there is no delete route, and no delete button", () => {
  // createdBy on BOMs, orders and productions is a plain STRING snapshot, not
  // a reference -- so deleting an account breaks nothing, and that is the
  // problem: let the address be reused a year later and every old createdBy
  // quietly points at the new person.
  assert.throws(() => read("../app/api/staff-delete/route.js"));
  assert.doesNotMatch(read("../app/staff/page.js"), /Delete|staff-delete/);
});

test("a dead session sends the browser to the sign-in page", () => {
  // middleware.js runs at the edge with no database, so a deactivated user
  // still gets the page shell and only the API calls fail. This is the only
  // place the browser finds out.
  const src = read("../components/UserMenu.jsx");
  assert.ok(/res\.status === 401/.test(src));
  assert.ok(/assign\('\/login'\)/.test(src));
  assert.ok(/mustChangePassword/.test(src), "and an unset password goes to the password page");
});

console.log("\n--- the screen offers nothing the server would refuse ---");

test("the form reads its role options from the shared list", () => {
  // Not a hand-written <option value="owner">. A typed-in role could not get
  // past the route, but it could get past review.
  const src = stripComments(read("../components/StaffForm.jsx"));
  assert.ok(/ASSIGNABLE_ROLES\.map/.test(src));
  // There IS one `value="owner"` and it is deliberate: an owner's own row
  // shows their real role in a disabled box, because rendering "Biller"
  // against the owner would be a lie on screen. What matters is that it is
  // only reachable behind the roleLocked guard, and never in the list the
  // dropdown is built from.
  const ownerOptions = [...src.matchAll(/value="owner"/g)];
  assert.equal(ownerOptions.length, 1, "owner should appear once, in the locked case");
  const before = src.slice(0, ownerOptions[0].index);
  assert.ok(
    /roleLocked && </.test(before.slice(-200)),
    "the owner option must sit behind the roleLocked guard"
  );
  assert.doesNotMatch(src, /ASSIGNABLE_ROLES\s*=\s*\[/, "the list is imported, not redefined");
});

test("the form checks with the same functions the route does", () => {
  const src = read("../components/StaffForm.jsx");
  assert.ok(/staffCreateProblems/.test(src));
  assert.ok(/from '@\/lib\/staffRules\.mjs'/.test(src));
  // The password rule comes from passwordRules, which exists so a client
  // component can import it -- password.mjs would drag node:crypto into the
  // browser bundle and break the build.
  assert.ok(/from '@\/lib\/passwordRules\.mjs'/.test(src));
  assert.doesNotMatch(src, /from '@\/lib\/password\.mjs'/);
});

test("the page computes nothing itself", () => {
  const src = read("../app/staff/page.js");
  assert.ok(/staffSummary/.test(src));
  assert.ok(/filterStaff/.test(src));
  // The figures are counted over everyone, not over what the filters left: a
  // total that moves when you type in the search box is not a total.
  assert.ok(
    src.indexOf("staffSummary(staff)") > 0,
    "the summary must be taken from the full list"
  );
  assert.doesNotMatch(src, /staffSummary\(shown\)/);
});

test("sensitive actions are confirmed, and the dialog says what will happen", () => {
  const src = read("../app/staff/page.js");
  assert.ok(/confirming/.test(src));
  assert.ok(/modal-overlay/.test(src));
  assert.ok(/stays in the books|records are untouched|Everything they have recorded stays/.test(src));
});

test("the owner-only tile is cosmetic, and the page does not guard itself", () => {
  // A page that checks its own role is guarding the wrong thing: the gate is
  // middleware.js plus the route's own permission.
  assert.ok(/myRole === 'owner'/.test(read("../app/page.js")));
  const page = read("../app/staff/page.js");
  assert.doesNotMatch(page, /role !== 'owner'|redirect\(/, "the page must not role-check itself");
});

console.log("\n--- nothing else was disturbed ---");

test("no accounting module was touched to make this work", () => {
  // The feature is a flag on `users` and five routes. Anything reaching into
  // posting, tax or stock would be a sign it had been built the wrong way.
  for (const route of STAFF_ROUTES) {
    const src = read(route);
    assert.doesNotMatch(src, /invoicePosting|invoiceGl|itemLedger|runningBalances|gst\.mjs|balance\.mjs/, route);
  }
});

test("the rules module stays runnable under bare node", () => {
  const src = read("../lib/staffRules.mjs");
  assert.doesNotMatch(src, /from "mongoose"|require\("mongoose"\)/);
  assert.doesNotMatch(src, /from\s+["'][^"']*models\//, "the pure module must not import a model");
  // Its one import is the password rule, which has no imports of its own.
  const imports = [...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./passwordRules.mjs"]);
});

test("the store is the only new file that imports the model", () => {
  assert.ok(/from "\.\.\/models\/userModel"/.test(read("../lib/staffStore.mjs")));
  // The import, not the word: staffRules' comments name userModel to explain
  // which stored behaviour they match.
  assert.doesNotMatch(read("../lib/staffRules.mjs"), /from\s+["'][^"']*userModel/);
});

console.log(`\n  ${passed} checks passed\n`);
