/**
 * The chart of accounts: which group an account sits in, and which financial
 * statement that group lands in.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * fixture tests directly. Never import Mongoose in here.
 *
 *
 * WHERE THIS CAME FROM
 * --------------------
 * Sigfa's `GRMAST`, read out of the client's own books. Thirty-five groups,
 * and the two columns that make the statements possible:
 *
 *   TPB    'T' Trading account, 'P' Profit & Loss, 'B' Balance Sheet
 *   LeftP  which side of that statement
 *
 * `LeftP` is worth being precise about, because it means two different things
 * depending on the statement, and getting it backwards produces a balanced
 * sheet with the assets and liabilities swapped:
 *
 *   Balance Sheet   left = LIABILITIES (capital, loans, creditors)
 *                   right = ASSETS (cash, debtors, stock, fixed assets)
 *                   -- the Indian horizontal form, not the IFRS vertical one
 *   Trading / P&L   left = DEBIT side (opening stock, purchases, expenses)
 *                   right = CREDIT side (sales, closing stock, income)
 *
 * THE CODES ARE SIGFA'S, GAPS AND ALL. 1-14 are the primary groups, then 25-44
 * and 50 are sub-groups; 15-24 and 45-49 are unused. They are kept rather than
 * renumbered so that a firm moving off Sigfa can be mapped across by code, and
 * so that anything read out of a `.mdb` lines up without a translation table.
 *
 * WHAT IS NOT HERE. Sigfa's own `GRMAST` also carries ShortName, Colno, SeqNo
 * within the parent and a `TPBGrp` flag that is False on all 35 rows in the
 * client's data -- nothing reads them, so nothing stores them.
 */

const text = (value) => String(value ?? "").trim();
const key = (value) => text(value).toLowerCase();

/** Which statement a group belongs to. Sigfa's TPB column. */
export const STATEMENTS = ["T", "P", "B"];

export const STATEMENT_NAMES = {
  T: "Trading Account",
  P: "Profit & Loss Account",
  B: "Balance Sheet",
};

/**
 * Sigfa's thirty-five groups.
 *
 *   main       a primary group: nothing sits above it
 *   under      the primary group's code, or null for a primary group
 *   statement  T / P / B
 *   left       true for the left-hand column (see the note above)
 *   totalOnly  Sigfa's TrialGrp: show the group's total in the trial balance
 *              rather than listing every account inside it. True on exactly
 *              the three groups where the account count runs to hundreds.
 */
export const ACCOUNT_GROUPS = [
  // --- the fourteen primary groups ---
  { code: 1, name: "Capital A/c", main: true, under: null, statement: "B", left: true },
  { code: 2, name: "Loans(Liabilities)", main: true, under: null, statement: "B", left: true },
  { code: 3, name: "Current Liabilities", main: true, under: null, statement: "B", left: true },
  { code: 4, name: "Suspense A/c", main: true, under: null, statement: "B", left: true },
  { code: 5, name: "Current Assets", main: true, under: null, statement: "B", left: false },
  { code: 6, name: "Investments", main: true, under: null, statement: "B", left: false },
  { code: 7, name: "Fixed Assets", main: true, under: null, statement: "B", left: false },
  { code: 8, name: "Opening Stock", main: true, under: null, statement: "T", left: true },
  { code: 9, name: "Sales Account", main: true, under: null, statement: "T", left: false },
  { code: 10, name: "Purchase Account", main: true, under: null, statement: "T", left: true },
  { code: 11, name: "Direct Expenses", main: true, under: null, statement: "T", left: true },
  { code: 12, name: "Direct Income", main: true, under: null, statement: "T", left: false },
  { code: 13, name: "Indirect Expenses", main: true, under: null, statement: "P", left: true },
  { code: 14, name: "Indirect Income", main: true, under: null, statement: "P", left: false },

  // --- sub-groups, each under one of the above ---
  { code: 25, name: "Cash In Hand", main: false, under: 5, statement: "B", left: false },
  { code: 26, name: "Bank Account", main: false, under: 5, statement: "B", left: false },
  { code: 27, name: "Sundry Debtors", main: false, under: 5, statement: "B", left: false, totalOnly: true },
  { code: 28, name: "Sundry Creditors", main: false, under: 3, statement: "B", left: true, totalOnly: true },
  { code: 29, name: "Duties And Taxes", main: false, under: 3, statement: "B", left: true },
  { code: 30, name: "Petty Cash In Hand", main: false, under: 5, statement: "B", left: false },
  { code: 31, name: "Reserve And Surplus", main: false, under: 1, statement: "B", left: true },
  { code: 32, name: "Bank OD A/c", main: false, under: 2, statement: "B", left: true },
  { code: 33, name: "Secured Loans", main: false, under: 2, statement: "B", left: true },
  { code: 34, name: "Unsecured Loans", main: false, under: 2, statement: "B", left: true },
  { code: 35, name: "Provisions", main: false, under: 3, statement: "B", left: true },
  { code: 36, name: "Stock In Hand", main: false, under: 5, statement: "B", left: false },
  { code: 37, name: "Deposits (Assets)", main: false, under: 5, statement: "B", left: false },
  { code: 38, name: "Loans And Adv. (Assets)", main: false, under: 5, statement: "B", left: false },
  { code: 39, name: "Manufacturing Stock", main: false, under: 8, statement: "T", left: true },
  { code: 40, name: "Local Sales", main: false, under: 9, statement: "T", left: false },
  { code: 41, name: "Central sales", main: false, under: 9, statement: "T", left: false },
  { code: 42, name: "Local Purchase", main: false, under: 10, statement: "T", left: true, totalOnly: true },
  { code: 43, name: "Central Purchase", main: false, under: 10, statement: "T", left: true },
  { code: 44, name: "Petty Cash Expenses", main: false, under: 13, statement: "P", left: true },
  { code: 50, name: "Stock In Progress", main: false, under: 8, statement: "T", left: true },
];

const BY_CODE = new Map(ACCOUNT_GROUPS.map((g) => [g.code, g]));
const BY_NAME = new Map(ACCOUNT_GROUPS.map((g) => [key(g.name), g]));

/** A group by its Sigfa code, or null. */
export const groupByCode = (code) => BY_CODE.get(Number(code)) || null;

/**
 * A group by name, case-insensitively.
 *
 * Case-insensitive because every name join in this app is (lib/uniqueName.mjs)
 * and because the existing account records were typed by hand.
 */
export const groupByName = (name) => BY_NAME.get(key(name)) || null;

/** The fourteen groups nothing sits above, in Sigfa's order. */
export const primaryGroups = () => ACCOUNT_GROUPS.filter((g) => g.main);

/** The sub-groups under one primary group, in Sigfa's order. */
export const subGroupsOf = (code) =>
  ACCOUNT_GROUPS.filter((g) => !g.main && g.under === Number(code));

/** The primary group a group rolls up into -- itself, when it is primary. */
export const primaryOf = (group) => {
  const g = typeof group === "object" ? group : groupByName(group) || groupByCode(group);
  if (!g) return null;
  return g.main ? g : groupByCode(g.under);
};

/* ------------------------------------------------------------------ *
 *  Which accounts are cash, and which are bank
 * ------------------------------------------------------------------ */

/**
 * The groups the Cash Book and the Bank Book draw from.
 *
 * Bank OD is in the bank list on purpose: an overdraft account is still an
 * account the bank sends a statement for, and leaving it out would mean a firm
 * running on an OD limit had no bank book at all.
 */
export const CASH_GROUP_CODES = [25, 30];
export const BANK_GROUP_CODES = [26, 32];

/**
 * Names this app may already be storing, mapped to the canonical group.
 *
 * Accounts today carry free text in `group` -- `lib/paymentType.mjs` writes
 * the literal 'cash' and 'bank', and anything else was typed by hand. Both
 * spellings have to keep working: the books are shipping before the groups are
 * seeded onto the account master, so for a while a cash account is whichever
 * of the two it happens to say.
 *
 * This is also the table the seeding step will use, so the mapping exists in
 * exactly one place rather than being decided twice.
 */
export const LEGACY_GROUPS = {
  cash: "Cash In Hand",
  "cash in hand": "Cash In Hand",
  "petty cash": "Petty Cash In Hand",
  "petty cash in hand": "Petty Cash In Hand",
  bank: "Bank Account",
  "bank account": "Bank Account",
  "bank a/c": "Bank Account",
  "bank od": "Bank OD A/c",
  "bank od a/c": "Bank OD A/c",
  debtor: "Sundry Debtors",
  debtors: "Sundry Debtors",
  customer: "Sundry Debtors",
  customers: "Sundry Debtors",
  "sundry debtors": "Sundry Debtors",
  creditor: "Sundry Creditors",
  creditors: "Sundry Creditors",
  supplier: "Sundry Creditors",
  suppliers: "Sundry Creditors",
  "sundry creditors": "Sundry Creditors",
};

/**
 * The canonical group for whatever an account currently says, or null.
 *
 * Tried in order: the real group names, then the legacy spellings. Returns
 * null rather than guessing for anything unrecognised -- an account filed
 * under "Mumbai Party" is not evidence of anything, and silently calling it a
 * debtor would put it on the balance sheet as an asset.
 */
export const resolveGroup = (name) => {
  const direct = groupByName(name);
  if (direct) return direct;
  const mapped = LEGACY_GROUPS[key(name)];
  return mapped ? groupByName(mapped) : null;
};

const inCodes = (name, codes) => {
  const g = resolveGroup(name);
  return Boolean(g && codes.includes(g.code));
};

/** Does an account in this group belong in the Cash Book? */
export const isCashGroup = (name) => inCodes(name, CASH_GROUP_CODES);

/** Does an account in this group belong in the Bank Book? */
export const isBankGroup = (name) => inCodes(name, BANK_GROUP_CODES);

/**
 * The accounts one book covers, from the account master.
 *
 * `kind` is 'cash', 'bank' or 'ledger'. A cash or bank book shows only the
 * accounts of that kind; the A/C Ledger will show any account, so it returns
 * everything and lets the user pick.
 *
 * Sorted by name, so the book opens on the same account every time rather
 * than on whichever row the database handed back first.
 */
export const accountsForBook = (accounts = [], kind = "ledger") => {
  // Anything that is not a cash or bank book accepts every account, which is
  // what makes the A/C Ledger the A/C Ledger. Expressed in this predicate
  // rather than as a second `kind === "ledger"` check below, because two
  // places deciding the same thing is one place too many -- and the second
  // one was unreachable.
  const want =
    kind === "cash" ? isCashGroup : kind === "bank" ? isBankGroup : () => true;

  return accounts
    .filter((a) => a && text(a.name))
    .filter((a) => want(a.group))
    .sort((a, b) => text(a.name).localeCompare(text(b.name)));
};
