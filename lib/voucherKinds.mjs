/**
 * The six vouchers: Receipt, Payment, Journal, Contra, Credit Note and
 * Debit Note.
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
 * THE NAMES BELOW ARE THIS APP'S, NOT SIGFA'S. No MKEY for a journal, a
 * contra or either note was read out of the binary, and none is invented
 * here.
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
 * A RECEIPT'S DIRECTION IS A FACT. A NOTE'S IS ONLY A HABIT.
 * ---------------------------------------------------------
 * Receipt, Payment and Contra are locked to one column because the direction
 * IS what the kind means: the money came in, or it went out. Somebody who
 * types a receipt into the debit column has not entered a different kind of
 * voucher, they have entered a wrong one, and it reads as correct afterwards.
 *
 * The two notes were given that same lock when they were added, earlier on
 * 18 Oct 2026, and it was wrong. A note moves no money: it is an adjustment,
 * and an adjustment honestly has both sides -- a credit note that is part
 * discount and part rate difference, one that moves a balance from one party
 * to another, one correcting an earlier note. Locking the column made those
 * unenterable, and made the screen refuse figures that were not mistakes.
 *
 * So the notes are free-sided, like a JOURNAL. What makes a credit note a
 * credit note is the head it is booked to and the name on the voucher, not a
 * disabled input -- which is how the ledgers this app is modelled on have
 * always treated them, and how Sigfa's own note screens behave. That last
 * part is the user's reading of their own screen, reported 18 Oct 2026, and
 * is recorded as such like every other Sigfa claim in this file.
 *
 * THE "BOOKED TO" ACCOUNT WENT ON 18 OCT 2026, at the user's request. A
 * note used to name one head (Discount Allowed, Rejected Material) that
 * absorbed the net of its lines, so its lines did not have to balance. Now
 * the head is simply one of the lines -- party credited, Discount Allowed
 * debited -- and a note balances on its own, exactly as a journal does. It
 * is still a credit or debit note by name and number; it just has no
 * separate account box.
 *
 * Notes saved while the box existed keep their `acName`, and THAT STILL
 * POSTS: `postsAccount` below lets a stored head absorb the net, so deleting
 * or editing one of those reverses exactly what it posted. Only a new save
 * is refused one.
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
 *   CREDIT_NOTE  the party owes us LESS. Party credited, and a discount,
 *             rebate or write-off head debited -- both as lines, balancing.
 *   DEBIT_NOTE the party owes us MORE, or we owe them less. Party debited,
 *             the head credited, both as lines. This is the one the M.R.I. wants: Sigfa
 *             passes a debit note for (bill amount - accepted purchase) when
 *             material is rejected, and lib/mri.mjs has been carrying that as
 *             a recorded gap with `rejectedValue` waiting for it.
 *
 *
 * THE TWO NOTES CARRY NO GST, ON PURPOSE
 * --------------------------------------
 * They are book adjustments and they reach no return. That is a decision
 * taken deliberately (18 Oct 2026), not an omission:
 *
 * A GST credit note against a sale ALREADY EXISTS in this app -- it is a
 * sale return. lib/gstReturns.mjs reads `isCreditNote = invoice.return ===
 * true` and files it into CDNR or CDNUR, and the B2CS table is already net
 * of credit notes. Giving these vouchers tax fields as well would put the
 * same adjustment into GSTR-1 from two unrelated places, and the second one
 * would be invisible to the first.
 *
 * So: a taxable adjustment to a supply goes through a return, which is a
 * document with lines and tax. A note here moves money between two accounts
 * and nothing else -- a discount allowed, a rebate, a rejected-material
 * charge back to a supplier, a balance written off. If a note ever does need
 * to be filed, the thing to change is NOT this file but the question of how
 * the two sources are kept from double-counting.
 *
 *
 * WHERE THE TWO NOTES COME FROM
 * -----------------------------
 * Asked for on 18 Oct 2026, as "from sigfa receipts and payment". Sigfa's
 * Receipts & Payments menu is reported to carry them; that is the user's
 * reading of their own screen, not a string read out of SIGFA105.exe, and it
 * is recorded here as such. The one Sigfa statement about notes that IS a
 * finding is the M.R.I. debit note quoted in lib/mri.mjs.
 *
 * THE FIELDS BELOW ARE THEREFORE THIS APP'S, like the four above. If Sigfa's
 * own Credit Note screen turns out to have a different shape -- an against-
 * bill link, a reason code, its own numbering -- that screen is the thing to
 * build to, and this is the file to correct.
 *
 * A JOURNAL AND THE TWO NOTES MUST BALANCE THEMSELVES. Receipt, payment and
 * contra have an account absorbing the opposite of their lines
 * (lib/voucherLedger.mjs), so they net to zero by construction. The other
 * three have no such account, so their own lines have to: total debit must
 * equal total credit, or the entry would move the trial balance out of
 * balance and there would be nothing to blame.
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
 * The six kinds.
 *
 *   needsAccount  has an `acName` -- one account absorbing the opposite of
 *                 every line, so the entry nets to zero without its own
 *                 lines having to balance.
 *   needsPaymentType  that account is reached through a cash/bank
 *                 instrument, so `paymentType` is required too.
 *
 * THOSE TWO USED TO BE ONE FLAG, and the credit and debit notes are why
 * they are not. A note has a contra account (Discount Allowed, Rejected
 * Material) but no cash or bank leg, which the old single flag could not
 * express: `needsAccount` demanded a paymentType, and turning it off took
 * `acName` away as well and left the note with nothing to post against.
 *
 *   side          which column every line must put its figure in, or null
 *                 when the kind is free to use either.
 *   mustBalance   the lines must total Dr = Cr on their own.
 *   lineLabel     what the line column is called on the form and the sheet.
 *   ownAccounts   the lines name our OWN cash/bank accounts, not a party.
 *   billAdjustable  a line can be set "Against Bill" -- a receipt, a payment
 *                 and the two notes have a party with bills; a journal and a
 *                 contra do not.
 *   storedAccountPosts  an `acName` saved on an OLD voucher of this kind
 *                 still absorbs its net, though a new one may not carry one
 *                 (the notes, after "Booked to" was removed).
 *   short         the two letters a narrow report column shows.
 *
 * `short` is THIS APP'S abbreviation, like the four kinds themselves. Sigfa
 * splits its money vouchers by instrument -- 'CA' and 'BA' -- so there is no
 * MKEY for a receipt, a payment, a journal or a contra to borrow. Added
 * 18 Oct 2026 for the ledger's Type column; presentation only, and nothing
 * is stored by it (rows store `voucherKind`, the long code).
 */
export const VOUCHER_KINDS = {
  RECEIPT: {
    code: "RECEIPT",
    label: "Receipt",
    short: "RC",
    blurb: "Money in. The party is credited and the cash or bank account debited.",
    needsAccount: true,
    needsPaymentType: true,
    side: "credit",
    mustBalance: false,
    lineLabel: "Received from",
    ownAccounts: false,
    billAdjustable: true,
  },
  PAYMENT: {
    code: "PAYMENT",
    label: "Payment",
    short: "PY",
    blurb: "Money out. The party is debited and the cash or bank account credited.",
    needsAccount: true,
    needsPaymentType: true,
    side: "debit",
    mustBalance: false,
    lineLabel: "Paid to",
    ownAccounts: false,
    billAdjustable: true,
  },
  JOURNAL: {
    code: "JOURNAL",
    label: "Journal",
    short: "JV",
    blurb:
      "No money moves. Debit one account and credit another -- depreciation, a write-off, an adjustment.",
    needsAccount: false,
    needsPaymentType: false,
    side: null,
    mustBalance: true,
    lineLabel: "Account",
    ownAccounts: false,
    billAdjustable: false,
  },
  CONTRA: {
    code: "CONTRA",
    label: "Contra",
    // 'CT', not 'CN'. CN was this file's code for a contra for about two
    // hours on 18 Oct 2026, until the credit note arrived and wanted it --
    // and in Indian books CN means Credit Note to practically everybody.
    // Nothing is stored by these letters (they are presentation, as the
    // note above says), so the swap costs nothing but is worth recording.
    short: "CT",
    blurb: "Between your own accounts: cash banked, or cash drawn from the bank.",
    needsAccount: true,
    needsPaymentType: true,
    // The line is the account the money LEFT, so it is credited, and
    // `acName` -- where it landed -- absorbs the debit. Identical posting to
    // a receipt; only what the line is allowed to name differs.
    side: "credit",
    mustBalance: false,
    lineLabel: "Moved from",
    ownAccounts: true,
    billAdjustable: false,
  },
  CREDIT_NOTE: {
    code: "CREDIT_NOTE",
    label: "Credit Note",
    short: "CN",
    blurb:
      "The party owes you less: a discount, a rebate, an allowance. Credit the party and debit the head, as two lines. No GST -- a taxable adjustment is a sale return.",
    // No account of its own any more ("Booked to" was removed on 18 Oct
    // 2026): the head is one of the lines, so the lines balance.
    needsAccount: false,
    needsPaymentType: false,
    // Either column, like a journal. "credit" until 18 Oct 2026 -- the note
    // above on a receipt's direction being a fact and a note's a habit.
    side: null,
    mustBalance: true,
    // "Credit to" while the lock was on, and it had to go with it: a column
    // headed "Credit to" above an enterable Debit box is a screen
    // contradicting itself. Which way a credit note usually runs is in the
    // blurb, where it is a description rather than a promise.
    lineLabel: "Account",
    ownAccounts: false,
    billAdjustable: true,
    storedAccountPosts: true,
  },
  DEBIT_NOTE: {
    code: "DEBIT_NOTE",
    label: "Debit Note",
    short: "DN",
    blurb:
      "The party owes you more: material rejected, a short supply, an overcharge by a supplier. Debit the party and credit the head, as two lines.",
    needsAccount: false,
    needsPaymentType: false,
    // Either column, for the same reason as the credit note above.
    side: null,
    mustBalance: true,
    lineLabel: "Account",
    ownAccounts: false,
    billAdjustable: true,
    storedAccountPosts: true,
  },
};

/**
 * Does this voucher's `acName` absorb the net of its lines?
 *
 * Always for a receipt, payment or contra. For a note, only when one was
 * STORED -- a note saved while "Booked to" existed. The posting, the
 * balance deltas and every reversal ask this one question, so an old note
 * is undone exactly as it was posted and a new one posts only its lines.
 */
export const postsAccount = (spec, acName) =>
  Boolean(spec?.needsAccount || (spec?.storedAccountPosts && text(acName)));

/** The codes, in the order a menu should offer them. */
export const VOUCHER_KIND_CODES = [
  "RECEIPT",
  "PAYMENT",
  "JOURNAL",
  "CONTRA",
  "CREDIT_NOTE",
  "DEBIT_NOTE",
];

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
    if (spec.needsPaymentType) {
      if (!text(paymentType)) problems.push("Pick cash or bank.");
    } else if (text(paymentType)) {
      // A note that carried one would post a cash leg for an adjustment
      // where no money moved -- the same mistake a journal with an account
      // would make, one field along.
      problems.push(`A ${spec.label.toLowerCase()} is not paid by cash or bank.`);
    }
  } else if (spec.code === "JOURNAL") {
    // Not merely unnecessary: a journal that carried a cash leg would post
    // one, and the entry would move money that never moved.
    if (text(acName)) problems.push("A journal has no cash or bank account.");
    if (text(paymentType)) problems.push("A journal is not paid by cash or bank.");
  } else {
    // A note. A new save naming a head would have it absorb the net and let
    // the lines go unbalanced -- the "Booked to" box this replaced.
    if (text(acName)) {
      problems.push(`A ${spec.label.toLowerCase()} has no account of its own: put the head in the lines.`);
    }
    if (text(paymentType)) problems.push(`A ${spec.label.toLowerCase()} is not paid by cash or bank.`);
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
      problems.push(`A ${spec.label.toLowerCase()} needs at least two lines: one debited, one credited.`);
    }
    const { debit, credit } = lineTotals(lines);
    if (debit !== credit) {
      // The figure is spelled out because "does not balance" without it is
      // the least useful error a ledger can give you.
      problems.push(
        `A ${spec.label.toLowerCase()} must balance. Debit ${debit.toFixed(2)}, credit ${credit.toFixed(2)} -- out by ${Math.abs(round2(debit - credit)).toFixed(2)}.`
      );
    }
  }

  return problems;
};
