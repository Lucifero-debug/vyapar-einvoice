/**
 * Who may do what.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * fixture test directly and so the edge middleware can import it too.
 *
 * TWO SEPARATE QUESTIONS
 * ----------------------
 *   1. Are you signed in, and to which firm?   -> lib/session.mjs
 *   2. Is your role allowed to do this?        -> here
 *
 * Keeping them apart matters: a signed-in biller is a real user with a valid
 * session who still must not reach the ledger or the danger zone.
 *
 * Permissions are named after what they protect rather than after a page, so a
 * new page that touches invoices inherits the right rule by naming it.
 */

export const ROLES = ["owner", "accountant", "biller"];

export const PERMISSIONS = [
  "invoice:read",
  "invoice:write",
  "voucher:read",
  "voucher:write",
  "ledger:read",
  "master:read",
  "master:write",
  "report:read",
  // Setup covers the danger zone, so it is deliberately owner-only: a wrong
  // click there empties the books.
  "setup:write",
  "user:manage",
];

const ACCOUNTANT = [
  "invoice:read",
  "invoice:write",
  "voucher:read",
  "voucher:write",
  "ledger:read",
  "master:read",
  "master:write",
  "report:read",
];

export const ROLE_PERMISSIONS = {
  owner: [...PERMISSIONS],
  accountant: ACCOUNTANT,
  // A biller writes bills. Reading the masters is unavoidable -- you cannot
  // pick a customer or an item without it -- but the ledger, the vouchers and
  // anything that changes a master are not theirs.
  biller: ["invoice:read", "invoice:write", "master:read"],
};

/** Does this role hold this permission? Unknown role or permission: no. */
export const can = (role, permission) =>
  (ROLE_PERMISSIONS[role] || []).includes(permission);

/**
 * Paths anybody may reach, signed in or not. Everything else needs a session.
 *
 * Kept as an explicit list rather than a prefix rule: a bug that makes one
 * page public is the kind nobody notices.
 */
export const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
];

/**
 * The only paths a signed-in user may reach while they still owe a password
 * change.
 *
 * Read by `requireAuth` in lib/authServer.mjs, which refuses everything else
 * for such a user. Kept here, with the other path rules, because this module
 * is the pure one -- the edge middleware imports it, and the test can run it
 * under bare node.
 *
 * Deliberately tiny, and deliberately an explicit list. `/api/auth/me` is on
 * it because the screen has to be able to ask who it is talking to in order
 * to send them to the right place, and logout because somebody who does not
 * want to set a password must still be able to leave.
 */
export const PASSWORD_CHANGE_PATHS = [
  "/change-password",
  "/api/change-password",
  "/api/auth/me",
  "/api/auth/logout",
];

/** May a user who owes a password change reach this path? */
export const allowedWhilePasswordChangeDue = (pathname) =>
  PASSWORD_CHANGE_PATHS.includes(normalizePath(pathname));

/** Is this path reachable without signing in? */
export const isPublicPath = (pathname) => {
  const path = normalizePath(pathname);
  return PUBLIC_PATHS.includes(path);
};

const normalizePath = (pathname) => {
  const path = String(pathname || "").split("?")[0];
  // "/ledger/" and "/ledger" are the same page.
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
};

/**
 * Which permission a path demands, or null when being signed in is enough.
 *
 * Longest prefix wins, so "/api/auth/me" is not caught by a shorter rule. The
 * default at the bottom is the important part: anything unrecognised under
 * /api demands `setup:write`, the most restrictive permission there is. A new
 * route that nobody remembered to list is then reachable only by an owner,
 * rather than being wide open -- which is the failure this whole exercise is
 * about.
 */
const PATH_RULES = [
  ["/api/auth/me", null],

  ["/api/clear-all-data", "setup:write"],
  ["/api/clear-transactions", "setup:write"],
  ["/setup", "setup:write"],

  // Reading the firm's own letterhead is something every role needs -- a
  // biller cannot print a bill without it. Changing it is the owner's.
  ["/api/company", null],
  ["/api/company-update", "setup:write"],
  // The logo is part of the firm's profile, so it takes the profile's
  // permission -- owner only. A separate route because a 200KB body should
  // not ride along with every profile save, NOT because it is a different
  // kind of thing; the two permissions must stay equal, and a test asserts
  // it. The firm comes from the session either way, so there is no company
  // id in the body to tamper with.
  ["/api/company-logo", "setup:write"],
  ["/company", "setup:write"],

  // Staff management. Owner-only through `user:manage`, which no other role
  // holds. Each route is listed separately because a rule only matches an
  // exact path or one followed by "/" -- "/api/staff-add" does NOT match the
  // "/api/staff" rule, exactly as noted for the order routes below.
  //
  // Forgetting one fails closed rather than open: an unlisted path under /api
  // falls through to `setup:write`, which is also owner-only. That is luck
  // rather than design, so they are listed anyway.
  ["/api/staff", "user:manage"],
  ["/api/staff-add", "user:manage"],
  ["/api/staff-alter", "user:manage"],
  ["/api/staff-status", "user:manage"],
  ["/staff", "user:manage"],

  // Changing YOUR OWN password needs no permission beyond being signed in --
  // a biller must be able to do it, and `setup:write` is where an unlisted
  // /api path would otherwise land them.
  ["/api/change-password", null],
  ["/change-password", null],

  // Kept although nothing serves them: /users was wired for this feature
  // before it was built, and an unlisted PAGE path demands only a session.
  ["/api/users", "user:manage"],
  ["/users", "user:manage"],

  ["/api/ledger", "ledger:read"],
  ["/ledger", "ledger:read"],
  ["/api/item-ledger", "ledger:read"],
  ["/item-ledger", "ledger:read"],
  // Cash Book, Bank Book and A/C Ledger. One route, one page -- they are the
  // same sheet with a different account chosen (lib/accountBooks.mjs). Filed
  // with the other ledgers rather than under report:read, for the same reason
  // the order reports were: the accountant who most needs a cash book is the
  // one a stricter rule would lock out, and a biller is already kept out of
  // /api/ledger.
  ["/api/account-book", "ledger:read"],
  ["/account-book", "ledger:read"],
  // Customer and supplier statements. Filed with the ledgers, not under
  // report:read, and for the same reason: a statement IS one account's
  // history -- lib/statements.mjs calls `accountBook()` to build it -- so the
  // rule that governs the A/C Ledger must govern the statement, or a role
  // kept out of one would get the other to hand them the same rows. The
  // export is the same route with `format=`, so it inherits this entry
  // rather than needing one of its own (see lib/reportHttp.js).
  ["/api/statement", "ledger:read"],
  ["/statement", "ledger:read"],
  // The financial statements. Under report:read, not ledger:read: a trial
  // balance and a balance sheet are the firm's position rather than one
  // account's history, and the roles that hold report:read are exactly the
  // two that should see them. A biller holds neither.
  // Sigfa's Sales and Purchase module reports: the book, party-wise and
  // item-wise. Read-only, and under report:read with the financial
  // statements rather than invoice:read -- a sales book is the firm's
  // trading position for a period, not one bill.
  ["/api/sales-report", "report:read"],
  ["/sales-report", "report:read"],
  ["/api/gst-return", "report:read"],
  ["/gst-return", "report:read"],
  ["/api/analytics", "report:read"],
  ["/dashboard", "report:read"],

  ["/api/financials", "report:read"],
  ["/financials", "report:read"],

  // The Reports hub is a page of links and holds no figures. Under
  // report:read rather than left unlisted, because an unlisted PAGE demands
  // only a session and a biller has no business being shown the way to the
  // trial balance -- even though every tile behind it would refuse them. The
  // hub greys the tiles a role cannot open; this is the rule that keeps the
  // hub itself out of their hands.
  ["/reports", "report:read"],

  ["/api/voucher", "voucher:read"],
  ["/api/get-voucher", "voucher:read"],
  // The bill picker. Read-only, but it is part of writing a voucher and
  // shows what a party still owes, so it sits with the voucher permissions
  // rather than under invoice:read -- a biller who cannot raise a voucher
  // has no reason to be shown the outstanding ledger behind one.
  ["/api/open-bills", "voucher:write"],
  ["/api/voucher-add", "voucher:write"],
  ["/api/voucher-alter", "voucher:write"],
  ["/api/delete-voucher", "voucher:write"],
  ["/voucheradd", "voucher:write"],
  ["/voucher", "voucher:read"],

  ["/api/save-invoice", "invoice:write"],
  ["/api/sale-alter", "invoice:write"],
  ["/api/delete-invoice", "invoice:write"],
  ["/api/invoice", "invoice:read"],
  ["/api/invoices-by-date", "invoice:read"],
  // The reminder popup, which sits in the root layout and so is asked for
  // by every role that can open any page at all.
  ["/api/todays-orders", "invoice:read"],
  ["/api/get-invoice", "invoice:read"],
  ["/api/next-invoice-no", "invoice:write"],

  // Sales and purchase orders. They carry no tax and post nothing to the
  // ledger, so they sit under the invoice permissions rather than earning
  // their own: anyone who may raise a bill may take the order it comes from,
  // and a biller who may do neither is not stopped by a second rule.
  //
  // Note the prefix matching here (permissionForPath below): "/api/order-add"
  // does not match the "/api/order" rule, because a rule only matches an
  // exact path or one followed by a "/". Each route is therefore listed.
  ["/api/order", "invoice:read"],
  ["/api/get-order", "invoice:read"],
  ["/api/order-pending", "invoice:read"],
  ["/api/next-order-no", "invoice:write"],
  ["/api/order-add", "invoice:write"],
  ["/api/order-alter", "invoice:write"],
  ["/api/delete-order", "invoice:write"],
  // Cancelling writes to the order, so it sits with the other writes. It is
  // deliberately NOT under setup:write: calling off the balance of an order a
  // customer has dropped is ordinary daily work, not a danger-zone action.
  ["/api/order-cancel", "invoice:write"],
  ["/orderadd", "invoice:write"],
  ["/order", "invoice:read"],

  // Bills of material. A formula is MASTER data -- Sigfa keeps its own
  // "Bill of Material" under Masters > Misc, and its BOMAlter user right sits
  // beside ItemAlter and ACCAlter in the same list. So a biller who may not
  // change an item may not change a recipe either, while anyone who can pick
  // an item off a form can read one.
  ["/api/bom", "master:read"],
  ["/api/get-bom", "master:read"],
  ["/api/bom-explode", "master:read"],
  ["/api/bom-add", "master:write"],
  ["/api/bom-alter", "master:write"],
  ["/api/delete-bom", "master:write"],
  ["/bom", "master:read"],
  ["/bomadd", "master:write"],

  // Production, on the other hand, MOVES STOCK. It is a voucher, not a
  // master -- Sigfa numbers it in its own series (MKEY 'FR') alongside
  // invoices -- so it sits under the voucher permissions, and a biller is
  // deliberately kept out: issuing fifty thousand rupees of steel against a
  // job is not a billing action.
  ["/api/production", "voucher:read"],
  ["/api/get-production", "voucher:read"],
  ["/api/production-add", "voucher:write"],
  // Altering an entry rewrites the stock it moved, so it sits with the other
  // writes. Listed explicitly: a prefix rule only matches an exact path or one
  // followed by "/", so "/api/production-alter" does NOT match "/api/production".
  ["/api/production-alter", "voucher:write"],
  ["/api/delete-production", "voucher:write"],
  ["/api/next-production-no", "voucher:write"],
  ["/production", "voucher:read"],

  // The order reports. All read-only, and all under invoice:read rather than
  // report:read -- the accountant who most needs a pending-order list is the
  // one who would be locked out by a stricter rule, and a biller who can
  // already open an order can hardly be kept from a list of them.
  ["/api/order-report", "invoice:read"],
  ["/api/order-reconcile", "invoice:read"],
  ["/order-report", "invoice:read"],

  // Production planning. Read-only, and it reads the order book, the
  // formulas and the stock -- so it sits with the order reports rather than
  // under master:read or voucher:read. It writes nothing, which is why it
  // needs no write permission even though it talks about purchase orders.
  ["/api/production-plan", "invoice:read"],
  ["/production-plan", "invoice:read"],

  ["/saleadd", "invoice:write"],
  ["/purchaseadd", "invoice:write"],
  ["/salereturn", "invoice:write"],
  ["/purchasereturn", "invoice:write"],
  ["/invoice-range", "invoice:read"],
  ["/invoice", "invoice:read"],

  // Reading a master is what any billing screen needs; changing one is not.
  ["/api/get-customer", "master:read"],
  ["/api/get-item", "master:read"],
  ["/api/get-hsn", "master:read"],
  ["/api/get-group", "master:read"],
  ["/api/get-state", "master:read"],
  ["/api/get-price-list", "master:read"],
  ["/api/item-stock", "master:read"],
  ["/api/customer", "master:read"],
  ["/api/item", "master:read"],

  ["/api/customer-add", "master:write"],
  ["/api/customer-alter", "master:write"],
  ["/api/delete-cust", "master:write"],
  ["/api/item-add", "master:write"],
  ["/api/item-alter", "master:write"],
  ["/api/delete-item", "master:write"],
  ["/api/hsn-add", "master:write"],
  ["/api/hsn-update", "master:write"],
  ["/api/delete-hsn", "master:write"],
  ["/api/group-add", "master:write"],
  ["/api/group-update", "master:write"],
  ["/api/delete-group", "master:write"],
  ["/api/state-add", "master:write"],
  ["/api/state-update", "master:write"],
  ["/api/delete-state", "master:write"],
  ["/api/price-list-add", "master:write"],
  ["/api/price-list-update", "master:write"],
  ["/api/delete-price-list", "master:write"],
  ["/customeradd", "master:write"],
  ["/itemadd", "master:write"],
  ["/upload", "master:write"],

  ["/api/send-email", "invoice:read"],
];

/**
 * `rules` is a parameter so the test can prove the longest-prefix behaviour
 * with a nested pair. The real table has no nesting today, which means first
 * match and longest match happen to agree -- and that is exactly how a rule
 * added later, nested under an existing one, would silently take the wrong
 * permission.
 */
export function permissionForPath(pathname, rules = PATH_RULES) {
  const path = normalizePath(pathname);

  let best = null;
  let bestLength = -1;
  for (const [prefix, permission] of rules) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      if (prefix.length > bestLength) {
        bestLength = prefix.length;
        best = permission;
      }
    }
  }
  if (bestLength >= 0) return best;

  // Unlisted API route: owner only, rather than open to anyone signed in.
  if (path === "/api" || path.startsWith("/api/")) return "setup:write";

  // Unlisted page (the dashboard, say): signing in is enough.
  return null;
}

/** May this role open this path at all? */
export const canAccessPath = (role, pathname, rules = PATH_RULES) => {
  const needed = permissionForPath(pathname, rules);
  return needed === null ? ROLES.includes(role) : can(role, needed);
};
