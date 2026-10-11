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
  ["/company", "setup:write"],

  ["/api/users", "user:manage"],
  ["/users", "user:manage"],

  ["/api/ledger", "ledger:read"],
  ["/ledger", "ledger:read"],
  ["/api/item-ledger", "ledger:read"],
  ["/item-ledger", "ledger:read"],

  ["/api/voucher", "voucher:read"],
  ["/api/get-voucher", "voucher:read"],
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
