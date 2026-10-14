/**
 * The four money vouchers: Receipt, Payment, Journal and Contra.
 *
 * Pure and dependency-free apart from balance.mjs, like the rest of
 * lib/*.mjs, so `node` can run scripts/voucher-kinds.test.mjs directly. What
 * a voucher POSTS stays in lib/voucherLedger.mjs; what is here is which kind
 * a voucher is, what each kind is allowed to look like, and nothing else.
 *
 *
 * WHAT SIGFA ACTUALLY SAYS, AND WHAT IT DOES NOT
 * ----------------------------------------------
 * The one thing read out of SIGFA105.exe about its money vouchers is already
 * recorded in lib/stockVoucher.mjs, and it is this:
 *
 *     Its money vouchers -- 'CA' Cash and 'BA' Bank -- live somewhere else
 *     entirely, in JOURNAL.
 *
 * So Sigfa keeps its money vouchers in a table called JOURNAL and tells them
 * apart by an MKEY of 'CA' or 'BA'. That is a split by INSTRUMENT -- cash or
 * bank -- and this app already had exactly those two: /voucheradd headed
 * itself "Cash Voucher" or "Bank Voucher" off `paymentType`.
 *
 * THE FOUR NAMES BELOW ARE THIS APP'S, NOT SIGFA'S. No MKEY for a journal
 * voucher or a contra was read out of the binary, and none is invented here.
 * Every other Sigfa claim in this project is a quotation; this is a design
 * decision taken on top of the one quotation available, and it is written
 * down as such so nobody later mistakes it for a finding. If Sigfa's own
 * Journal menu turns out to name these differently, the labels are the only
 * thing that has to move.
 *
 *
 * WHY SPLIT BY DIRECTION AT ALL
 * -----------------------------
 * Cash-or-bank says which account the money went through. It does not say
 * which way it went: that was decided only by which column an operator typed
 * the figure into, debit or credit. Nothing on the screen or in the routes
 * objected to a receipt entered as a payment, and the entry posts cleanly
 * either way -- it just moves the party's balance, the cash book and the
 * trial balance in the wrong direction, and reads as a correct entry
 * afterwards. Naming the direction and enforcing it is the whole point of
 * Receipt and Payment being separate kinds.
 *
 *
 * WHAT EACH KIND IS
 * -----------------
 *   RECEIPT   money in.  Party is credited, the cash/bank account debited.
 *   PAYMENT   money out. Party is debited, the cash/bank account credited.
 *   CONTRA    money between two of our OWN accounts -- cash banked, cash
 *             drawn. `acName` is where it lands, the single line is where it
 *             came from, so it posts exactly as a receipt does.
 *   JOURNAL   no money at all. Dr any account, Cr any account: depreciation,
 *             a bad debt written off, discount allowed, a provision, a
 *             rectification. It is the one entry this app could not make --
 *             `paymentType` was required and every voucher wrote a cash or
 *             bank leg -- and it is why the trial balance had no way to carry
 *             an adjustment.
 *
 * A JOURNAL IS THE ONLY KIND THAT MUST BALANCE ITSELF. The other three have
 * an account absorbing the opposite of their lines (lib/voucherLedger.mjs),
 * so they net to zero by construction. A journal has no such account, so its
 * own lines have to: total debit must equal total credit, or it would move
 * the trial balance out of balance and there would be nothing to blame.
 *
 *
 * AN ENTRY SAVED BEFORE THIS EXISTED
 * ----------------------------------
 * ...carries no `kind` at all, and nothing rewrites it. `kindOf` reads an
 * absent one off the figures, the same way `kindOf` in lib/stockVoucher.mjs
 * reads an absent MKEY as Production: every one of them has a cash or bank
 * leg and party lines, so the side those lines sit on is the direction the
 * money went. A backfill was considered and rejected -- the figures already
 * answer the question, and a migration that stamps a guess onto live rows
 * turns a reading into a stored fact.
 */

import { round2 } from "./balance.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * The four kinds.
 *
 *   needsAccount  has a cash/bank leg: `acName` plus `paymentType`.
 *   side          which column every line must put its figure in, or null
 *                 when the kind is free to use either.
 *   mustBalance   the lines must total Dr = Cr on their own.
 *   lineLabel     what the line column is called on the form and the sheet.
 *   ownAccounts   the lines name our OWN cash/bank accounts, not a party.
 */
export const VOUCHER_KINDS = {
  RECEIPT: {
    code: "RECEIPT",
    label: "Receipt",
    blurb: "Money in. The party is credited and the cash or bank account debited.",
    needsAccount: true,
    side: "credit",
    mustBalance: false,
    lineLabel: "Received from",
    ownAccounts: false,
  },
  PAYMENT: {
    code: "PAYMENT",
    label: "Payment",
    blurb: "Money out. The party is debited and the cash or bank account credited.",
    needsAccount: true,
    side: "debit",
    mustBalance: false,
    lineLabel: "Paid to",
    ownAccounts: false,
  },
  JOURNAL: {
    code: "JOURNAL",
    label: "Journal",
    blurb:
      "No money moves. Debit one account and credit another -- depreciation, a write-off, an adjustment.",
    needsAccount: false,
    side: null,
    mustBalance: true,
    lineLabel: "Account",
    ownAccounts: false,
  },
  CONTRA: {
    code: "CONTRA",
    label: "Contra",
    blurb: "Between your own accounts: cash banked, or cash drawn from the bank.",
    needsAccount: true,
    // The line is the account the money LEFT, so it is credited, and
    // `acName` -- where it landed -- absorbs the debit. Identical posting to
    // a receipt; only what the line is allowed to name differs.
    side: "credit",
    mustBalance: false,
    lineLabel: "Moved from",
    ownAccounts: true,
  },
};

/** The codes, in the order a menu should offer them. */
export const VOUCHER_KIND_CODES = ["RECEIPT", "PAYMENT", "JOURNAL", "CONTRA"];

export const isVoucherKind = (code) => Object.hasOwn(VOUCHER_KINDS, text(code));

/** Totals of a voucher's lines, rounded the way every figure here is. */
export const lineTotals = (customers = []) => {
  let debit = 0;
  let credit = 0;
  for (const line of customers || []) {
    debit = round2(debit + num(line?.debit));
    credit = round2(credit + num(line?.credit));
  }
  return { debit, credit };
};

/**
 * Which kind an entry saved before this feature existed is.
 *
 * Only ever RECEIPT or PAYMENT: every such entry has a cash or bank leg, so
 * it cannot be a journal, and a contra was not expressible. Read off the net
 * of the lines, because that IS the direction the money went -- credit lines
 * mean the party was credited, which happens when they paid us.
 *
 * A voucher of zero, or one whose debits and credits cancel, is reported as a
 * RECEIPT. That is arbitrary and is a label on an entry that moved nothing;
 * `inferredFrom` below is how a caller can tell it was a reading rather than
 * a stored value, and mark it.
 */
export const inferredKind = (voucher) => {
  const { debit, credit } = lineTotals(voucher?.customers);
  return credit >= debit ? VOUCHER_KINDS.RECEIPT : VOUCHER_KINDS.PAYMENT;
};

/** The kind of a voucher: its own, or read off its figures. Never null. */
export const kindOf = (voucher) =>
  VOUCHER_KINDS[text(voucher?.kind)] ?? inferredKind(voucher);

/** True when the kind was READ rather than stored -- for a "(from the figures)" mark. */
export const inferredFrom = (voucher) => !isVoucherKind(voucher?.kind);

/**
 * The form's own heading, as /voucheradd shows it.
 *
 * A kind nobody recognises is headed plainly rather than built up from a
 * fallback label -- "Voucher Voucher" is how a bad kind reaches a printed
 * sheet looking like a typo instead of like the bug it is.
 */
export const voucherTitle = (code) => {
  const spec = VOUCHER_KINDS[text(code)];
  return spec ? `${spec.label} Voucher` : "Voucher";
};

/**
 * Is this line's figure on the side its kind allows?
 *
 * One figure per line, on one side. Both columns filled is not an entry
 * anybody means -- it is a half-corrected mistake -- and neither is a line
 * with a name and no figure.
 */
export const lineProblem = (line, kind) => {
  const name = text(line?.name);
  const debit = num(line?.debit);
  const credit = num(line?.credit);

  if (!name) return "Every line needs an account.";
  if (debit < 0 || credit < 0) return `${name}: a figure cannot be negative.`;
  if (debit && credit) return `${name}: put the figure in one column, not both.`;
  if (!debit && !credit) return `${name}: enter an amount.`;

  const side = VOUCHER_KINDS[text(kind)]?.side;
  if (side === "credit" && debit) {
    return `${name}: a ${VOUCHER_KINDS[text(kind)].label.toLowerCase()} credits the account, so the figure goes in Credit.`;
  }
  if (side === "debit" && credit) {
    return `${name}: a ${VOUCHER_KINDS[text(kind)].label.toLowerCase()} debits the account, so the figure goes in Debit.`;
  }
  return null;
};

/**
 * Everything wrong with a voucher, in the order a person should fix it.
 *
 * ONE validator, called by the screen before it saves and by both routes
 * before they write. The screen's copy is a courtesy -- the routes' is the
 * rule -- and a second implementation is how the two come to disagree about
 * what a journal is.
 */
export const voucherProblems = ({
  kind,
  acName,
  paymentType,
  customers = [],
} = {}) => {
  const problems = [];

  if (!isVoucherKind(kind)) {
    return [`"${text(kind) || "(none)"}" is not a voucher kind.`];
  }
  const spec = VOUCHER_KINDS[text(kind)];

  if (spec.needsAccount) {
    if (!text(acName)) problems.push(`A ${spec.label.toLowerCase()} needs an account.`);
    if (!text(paymentType)) problems.push("Pick cash or bank.");
  } else {
    // Not merely unnecessary: a journal that carried a cash leg would post
    // one, and the entry would move money that never moved.
    if (text(acName)) problems.push("A journal has no cash or bank account.");
    if (text(paymentType)) problems.push("A journal is not paid by cash or bank.");
  }

  const lines = customers || [];
  if (!lines.length) problems.push("A voucher needs at least one line.");

  for (const line of lines) {
    const problem = lineProblem(line, kind);
    if (problem) problems.push(problem);
  }

  // Paying yourself, or banking cash into the same account it came from.
  for (const line of lines) {
    if (spec.needsAccount && text(line?.name) && text(line.name) === text(acName)) {
      problems.push(`${text(line.name)} is the voucher's own account.`);
    }
  }

  if (spec.code === "CONTRA" && lines.length > 1) {
    problems.push("A contra moves money between two accounts, so it has one line.");
  }

  if (spec.mustBalance) {
    if (lines.length < 2) {
      problems.push("A journal needs at least two lines: one debited, one credited.");
    }
    const { debit, credit } = lineTotals(lines);
    if (debit !== credit) {
      // The figure is spelled out because "does not balance" without it is
      // the least useful error a ledger can give you.
      problems.push(
        `A journal must balance. Debit ${debit.toFixed(2)}, credit ${credit.toFixed(2)} -- out by ${Math.abs(round2(debit - credit)).toFixed(2)}.`
      );
    }
  }

  return problems;
};
