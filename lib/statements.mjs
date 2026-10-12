/**
 * Customer and supplier statements.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/statements.test.mjs directly. Never import Mongoose in here.
 *
 *
 * THIS IS NOT A SECOND LEDGER
 * ---------------------------
 * lib/accountBooks.mjs already computes the only hard part: an opening
 * balance from everything dated before the window, the movements inside it in
 * `(date, _id)` order, a running balance recomputed rather than read from the
 * `Ledger.balance` cache, and a closing figure. `accountBook()` is called
 * here unchanged, and the closing balance a statement prints is the one the
 * A/C Ledger prints for the same account and dates. That is the point: a
 * statement is what gets EMAILED to the party, and a statement that disagreed
 * with the ledger behind it would be an argument with a customer that the
 * shop loses.
 *
 * So what this module adds is everything around the figures and nothing about
 * them:
 *
 *   - which accounts are a customer and which a supplier, from the chart of
 *     accounts rather than from the sign of a balance;
 *   - what each row IS -- a sales invoice, a return, a receipt -- named from
 *     the contra account the posting path wrote, not guessed;
 *   - the document number, pulled out of the narration (see below);
 *   - the words for a balance, which differ by side;
 *   - the reconciliation check, and the columns the sheet and the two
 *     download formats all share.
 *
 *
 * THE REFERENCE NUMBER COMES OUT OF THE NARRATION, AND THAT IS A LIMITATION
 * ------------------------------------------------------------------------
 * `models/ledgerModel.js` has no document-number field. It has `voucherId`,
 * which points at a Voucher for a receipt and at nothing resolvable for an
 * invoice posting, and it has `narration`, which this app's own posting path
 * writes in exactly three shapes:
 *
 *     "By Invoice No: 12"                     lib/invoicePosting.mjs
 *     "Receipt against Invoice No: 12"        lib/invoicePosting.mjs
 *     "Payment against Invoice No: 12"        lib/invoicePosting.mjs
 *
 * plus whatever the user typed on a voucher, or "Against <account>" when they
 * typed nothing (lib/voucherLedger.mjs).
 *
 * `referenceOf` reads the number out of the first three and returns "" for
 * anything else. It is a parser over text, which is a worse source than a
 * column -- a user who types "Chq No: 4411" into a voucher narration will see
 * 4411 in the Reference column, and that is arguably right but it is not
 * something the schema promised. The honest fix is a `docNo` on the ledger
 * row, written by the posting path; that is a migration and a change to the
 * posting path, which this reporting work is explicitly not allowed to make.
 * Documented here, and in PROJECT_CONTEXT.md, rather than papered over.
 *
 *
 * SIGNS: ONE RULE, TWO SETS OF WORDS
 * ----------------------------------
 * Balances are signed throughout this app -- positive is Dr, negative is Cr
 * (lib/balance.mjs) -- and that does not change by side. What changes is what
 * the sign MEANS to the reader:
 *
 *     customer, Dr   they owe the firm            (a receivable)
 *     customer, Cr   the firm holds their money   (an advance)
 *     supplier, Cr   the firm owes them           (a payable)
 *     supplier, Dr   they hold the firm's money   (an advance paid)
 *
 * `balanceWording` is the only place that knows this. A supplier statement
 * showing a payable as "Dr" because the customer statement did would be the
 * sort of mistake that gets paid twice.
 */

import { modeOf, round2 } from "./balance.mjs";
import { accountBook, inOrder, openingBefore } from "./accountBooks.mjs";
import { resolveGroup } from "./accountGroups.mjs";
import { istDayNumber, istParts } from "./istDate.mjs";
import { periodProblem, periodText } from "./reportPeriods.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/* ──────────────────────────────── the sides ──────────────────────────── */

/**
 * The two statements, and what each knows about its own side.
 *
 * `group` is the chart-of-accounts group an account must resolve to, by code.
 * 27 is Sundry Debtors and 28 Sundry Creditors (lib/accountGroups.mjs), and
 * `resolveGroup` maps the legacy spellings -- "customer", "supplier" -- onto
 * them, which is why an account filed under either still lands on the right
 * side.
 *
 * NOT decided from the sign of the balance. A customer who has paid in
 * advance has a credit balance and is still a customer; a supplier we have
 * overpaid has a debit balance and is still a supplier.
 */
export const STATEMENT_SIDES = {
  customer: {
    key: "customer",
    label: "Customer Statement",
    party: "Customer",
    groupCode: 27,
    groupName: "Sundry Debtors",
    // What a positive (Dr) closing balance means on this side.
    owingWord: "receivable",
    owingPhrase: "owed to you",
    advancePhrase: "held as advance",
    documents: "sales invoices and returns",
  },
  supplier: {
    key: "supplier",
    label: "Supplier Statement",
    party: "Supplier",
    groupCode: 28,
    groupName: "Sundry Creditors",
    owingWord: "payable",
    owingPhrase: "owed by you",
    advancePhrase: "paid in advance",
    documents: "purchase bills and returns",
  },
};

export const STATEMENT_SIDE_KEYS = Object.keys(STATEMENT_SIDES);

export const isStatementSide = (side) => text(side) in STATEMENT_SIDES;

export const statementSide = (side) => STATEMENT_SIDES[text(side)] || null;

/** Which side this account belongs to, from its group. Null for neither. */
export const sideOfAccount = (account) => {
  const group = resolveGroup(text(account?.group));
  if (!group) return null;
  for (const key of STATEMENT_SIDE_KEYS) {
    if (STATEMENT_SIDES[key].groupCode === group.code) return key;
  }
  return null;
};

/**
 * The accounts a statement may be drawn for, on one side.
 *
 * Returned with the resolved group beside the stored one, so the picker can
 * show plainly what an account was taken to be rather than quietly filing an
 * account named "Mumbai Party" wherever it guessed.
 */
export const accountsForSide = (accounts = [], side) => {
  const want = statementSide(side);
  if (!want) return [];
  return (accounts || [])
    .filter((a) => text(a?.name) && sideOfAccount(a) === want.key)
    .map((a) => ({
      _id: text(a._id ?? a.id),
      name: text(a.name),
      group: text(a.group),
      // `gstIn` is the master's spelling (models/custModel.js); `gstin` is
      // the invoice snapshot's (lib/buyerSnapshot.mjs). Both read, because a
      // statement header that silently drops the party's GSTIN is a statement
      // their accounts department sends back.
      gstin: text(a.gstIn ?? a.gstin),
      phone: text(a.phone),
      city: text(a.city),
      state: text(a.state),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/* ─────────────────────── what each row is, and its number ────────────── */

/**
 * The document number in a narration, or "".
 *
 * Reads "...No: 12" and "...No. 12" and "...No 12". Bounded to digits, so a
 * narration ending in a date does not become a reference. See the header for
 * why this is a parser and not a column.
 */
export const referenceOf = (narration) => {
  const m = /\bno\.?\s*:?\s*(\d{1,12})\b/i.exec(text(narration));
  return m ? m[1] : "";
};

/**
 * Does this row's narration name one of OUR invoice postings?
 *
 * Only then is the reference an invoice number this app can link to. A
 * voucher narration that happens to contain "No: 4411" is a cheque number,
 * not an invoice, and linking it to invoice 4411 would open a stranger's bill.
 */
export const invoiceNoOf = (row) => {
  const narration = text(row?.narration);
  if (!/^(?:by|receipt against|payment against)\s+(?:invoice|purchase)\s+no/i.test(narration)) {
    return "";
  }
  return referenceOf(narration);
};

/**
 * What to print in Particulars.
 *
 * Named from the CONTRA ACCOUNT, which the posting path writes and which is
 * therefore evidence rather than inference: only an invoice posting puts
 * "Sales Account" or "Purchase Account" opposite a party.
 *
 * Which of the pair it is -- a bill or a return -- is read off the SIDE the
 * movement landed on, and that is sound for one specific reason: the posting
 * path puts a return on the opposite side of the document it reverses, by
 * construction (`sides(deltas.docDelta)` in lib/invoicePosting.mjs, over
 * `invoiceDelta` in lib/balance.mjs). A sales return is the only thing that
 * credits a customer against the Sales Account.
 *
 * Everything else keeps what the A/C Ledger already shows -- the contra
 * account's own name -- rather than being given a category this app does not
 * record. A voucher receipt against "HDFC Bank" reads "HDFC Bank", with the
 * user's narration in its own column. Guessing "Receipt" from the sign would
 * be exactly the invented category the spec forbids.
 *
 * TAKES NO SIDE, deliberately. It had a `side` parameter that nothing read,
 * because the contra account settles the question on its own: only a sale
 * posts against the Sales Account, whichever statement is being drawn. A
 * parameter that does not change the answer is a lie about what the function
 * depends on, and a mutation test is how it was found -- replacing the
 * argument with a constant changed nothing.
 */
export const particularsOf = (row) => {
  const contra = text(row?.account);
  const debit = num(row?.debit);
  const credit = num(row?.credit);
  const narration = text(row?.narration);

  if (/^sales account$/i.test(contra)) {
    return debit > 0 ? "Sales Invoice" : credit > 0 ? "Sales Return" : "Sales";
  }
  if (/^purchase account$/i.test(contra)) {
    return credit > 0 ? "Purchase Bill" : debit > 0 ? "Purchase Return" : "Purchase";
  }
  // These two ARE named by the narration our own posting path wrote, so they
  // are evidence too -- "Receipt against Invoice No: 12" says receipt.
  if (/^receipt against\b/i.test(narration)) return "Receipt";
  if (/^payment against\b/i.test(narration)) return "Payment";

  return contra || "(no contra account)";
};

/** Is this row one of the documents, as opposed to money moving? */
export const isDocumentRow = (row) =>
  /^(?:sales|purchase) account$/i.test(text(row?.account));

/* ───────────────────────────── the statement ─────────────────────────── */

/**
 * The words for a signed balance, on one side.
 *
 * Returns the magnitude, the Dr/Cr mode and a sentence, because a statement
 * that prints "-4,500.00" and leaves the reader to work out whose money that
 * is has not done its job.
 */
export const balanceWording = (signed, side = "customer") => {
  const config = statementSide(side) || STATEMENT_SIDES.customer;
  const value = round2(num(signed));
  const mode = modeOf(value);
  const magnitude = Math.abs(value);

  if (magnitude === 0) {
    return { value, mode, magnitude, phrase: "Nothing outstanding", owing: false };
  }

  // Dr is owed to the firm on both sides of the book. On the customer side
  // that is the ordinary case and on the supplier side it is an advance the
  // firm has paid out -- see the header's table.
  const owing = config.key === "customer" ? mode === "Dr" : mode === "Cr";
  const phrase = owing ? config.owingPhrase : config.advancePhrase;

  return { value, mode, magnitude, phrase, owing };
};

/**
 * One account's statement.
 *
 * `rows` are its Ledger rows -- ALL of them, not only the ones in the window,
 * because the opening balance is computed from the ones before it. `account`
 * carries the party's master record, for the header and the opening figure.
 *
 * Built by calling `accountBook` and then labelling its lines. The balances,
 * the ordering and the opening are entirely its work.
 */
export const statement = ({
  account,
  side = "customer",
  rows = [],
  from,
  to,
  generatedAt = Date.now(),
} = {}) => {
  const config = statementSide(side) || STATEMENT_SIDES.customer;

  const book = accountBook({
    account,
    rows,
    // Signed, as stored. `openingMode` is a display cache and is deliberately
    // not consulted -- the same decision /api/account-book makes.
    openingBal: account?.openingBal,
    from,
    to,
  });

  const lines = book.lines.map((line, index) => {
    const source = { account: line.particulars, debit: line.debit, credit: line.credit, narration: line.narration };
    return {
      // The serial a printed statement numbers its rows with. 1-based, over
      // the window, so it reads as a document rather than as a query result.
      srNo: index + 1,
      _id: line._id,
      date: line.date,
      day: istDayNumber(line.date),
      particulars: particularsOf(source),
      // The contra account, kept as its own column. The A/C Ledger shows this
      // in Particulars; a statement shows the document kind there and the
      // account here, so nothing is lost.
      account: line.particulars,
      reference: referenceOf(line.narration),
      invoiceNo: invoiceNoOf(source),
      narration: line.narration,
      paymentType: line.paymentType,
      voucherId: line.voucherId ?? null,
      document: isDocumentRow(source),
      debit: line.debit,
      credit: line.credit,
      balance: line.balance,
      mode: line.mode,
    };
  });

  const opening = balanceWording(book.opening, config.key);
  const closing = balanceWording(book.closing, config.key);

  return {
    side: config.key,
    sideLabel: config.label,
    partyWord: config.party,
    account: book.account,
    group: book.group,
    resolvedGroup: resolveGroup(text(account?.group))?.name || null,
    party: {
      name: book.account,
      gstin: text(account?.gstIn ?? account?.gstin),
      phone: text(account?.phone),
      email: text(account?.email),
      address: text(account?.address),
      city: text(account?.city),
      state: text(account?.state),
      stateCode: text(account?.stateCode),
      pincode: text(account?.pincode),
    },
    from: book.from,
    to: book.to,
    period: periodText(from, to),
    generatedAt: new Date(generatedAt).toISOString(),
    opening: book.opening,
    openingMode: book.openingMode,
    openingWording: opening,
    lines,
    totals: book.totals,
    closing: book.closing,
    closingMode: book.closingMode,
    closingWording: closing,
    // Nothing happened in the window. Said explicitly rather than left for
    // the screen to infer from an empty array, because "no transactions" and
    // "no balance" are different answers and a party with an opening balance
    // and no movement must still get a statement showing what they owe.
    quiet: lines.length === 0,
    reconciliation: reconcile(book),
  };
};

/**
 * Does the closing figure follow from the opening and the movements?
 *
 * opening + debits - credits = closing, to the paisa. This cannot fail while
 * `accountBook` computes all four, which is the reason to check it: the day
 * it does fail, something has started rounding twice or summing a column the
 * running balance did not walk, and a statement is the last place anybody
 * would notice by eye.
 *
 * Returned rather than thrown. A statement that is one paisa out is still
 * worth showing, with the discrepancy printed, over an error page.
 */
export const reconcile = (book) => {
  const expected = round2(num(book?.opening) + num(book?.totals?.debit) - num(book?.totals?.credit));
  const closing = round2(num(book?.closing));
  const difference = round2(closing - expected);
  return { expected, closing, difference, balanced: difference === 0 };
};

/* ──────────────────────────── the month summary ──────────────────────── */

export const STATEMENT_FORMATS = ["detailed", "monthly"];

export const STATEMENT_FORMAT_LABELS = {
  detailed: "Every entry",
  monthly: "Month by month",
};

export const isStatementFormat = (format) => STATEMENT_FORMATS.includes(text(format));

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * One row per calendar month, for a statement covering a year.
 *
 * The same device lib/accountBooks.mjs's `dayWise` uses, and it is safe for
 * the same reason: the closing balance of a month is the running balance
 * after its LAST entry, so collapsing the rows cannot change the closing
 * figure. A test asserts that, because a summary that quietly differs from
 * its detail is worse than no summary.
 *
 * Months with no entries are not invented. A gap in a statement is
 * information -- it says nothing was bought and nothing was paid.
 */
export const monthWise = (statementOrLines) => {
  const lines = Array.isArray(statementOrLines)
    ? statementOrLines
    : statementOrLines?.lines || [];

  const months = new Map();

  for (const line of lines) {
    const p = istParts(line?.date);
    if (!p) continue;
    const key = p.year * 100 + p.month;
    if (!months.has(key)) {
      months.set(key, {
        month: key,
        label: `${MONTH_NAMES[p.month - 1]} ${p.year}`,
        entries: 0,
        debit: 0,
        credit: 0,
        balance: 0,
        mode: "Dr",
      });
    }
    const row = months.get(key);
    row.entries += 1;
    row.debit = round2(row.debit + num(line.debit));
    row.credit = round2(row.credit + num(line.credit));
    // The running balance after this line, so the month's last entry wins.
    row.balance = num(line.balance);
    row.mode = modeOf(row.balance);
  }

  return [...months.values()].sort((a, b) => a.month - b.month);
};

/* ─────────────────────────────── validation ──────────────────────────── */

/**
 * Why this statement cannot be drawn, or null. CHECKED ON THE SERVER.
 *
 * The party is checked against the side, not merely for existence: drawing a
 * "customer statement" for a supplier would print purchase bills under
 * headings that say sales, and the wording for the closing balance would be
 * the wrong way round.
 */
export const statementProblem = ({ side, account, from, to, format } = {}) => {
  const config = statementSide(side);
  if (!config) return "Pick a customer or a supplier statement.";
  if (!text(account?.name ?? account)) return `Pick a ${config.party.toLowerCase()}.`;

  if (typeof account === "object" && account) {
    const belongs = sideOfAccount(account);
    if (belongs && belongs !== config.key) {
      return `"${text(account.name)}" is filed under ${
        STATEMENT_SIDES[belongs].groupName
      }, so it takes a ${STATEMENT_SIDES[belongs].label.toLowerCase()}.`;
    }
    if (!belongs) {
      return `"${text(account.name)}" is filed under "${text(
        account.group
      )}", which is not a group in the chart of accounts.`;
    }
  }

  if (text(format) && !isStatementFormat(format)) {
    return `"${text(format)}" is not a statement format.`;
  }

  return periodProblem({ from, to });
};

/* ───────────────────────────── the columns ───────────────────────────── */

/**
 * The columns the screen, the CSV and the workbook all read.
 *
 * ONE list, with a `type` the .xlsx writer uses for number formats and a
 * `width` it uses for the column. The printed sheet and the two downloads
 * cannot disagree about what a column is called, which is the mistake
 * lib/salesReports.mjs's CSV_COLUMNS comment was written about after it
 * happened there.
 */
export const STATEMENT_COLUMNS = [
  { key: "date", label: "Date", type: "date", width: 12 },
  { key: "particulars", label: "Particulars", type: "text", width: 20 },
  { key: "reference", label: "Reference", type: "text", width: 12 },
  { key: "account", label: "Against", type: "text", width: 22 },
  { key: "narration", label: "Narration", type: "text", width: 30 },
  { key: "debit", label: "Debit", type: "money", width: 14 },
  { key: "credit", label: "Credit", type: "money", width: 14 },
  { key: "balance", label: "Balance", type: "money", width: 14 },
  { key: "mode", label: "Dr/Cr", type: "text", width: 7 },
];

export const MONTHLY_COLUMNS = [
  { key: "label", label: "Month", type: "text", width: 14 },
  { key: "entries", label: "Entries", type: "int", width: 10 },
  { key: "debit", label: "Debit", type: "money", width: 14 },
  { key: "credit", label: "Credit", type: "money", width: 14 },
  { key: "balance", label: "Closing", type: "money", width: 14 },
  { key: "mode", label: "Dr/Cr", type: "text", width: 7 },
];

/**
 * The metadata block above a downloaded or printed statement.
 *
 * The firm comes from the `companies` record the caller passes in -- never a
 * hardcoded name. `company.mjs`'s `companyAddress` builds the address line
 * the invoice print already uses, and is passed in rather than imported so
 * this module stays free of anything that formats for a screen.
 */
export const statementMeta = ({ statement: sheet, company, companyAddressLine = "" } = {}) => {
  const rows = [
    { label: "Firm", value: text(company?.name) },
    { label: "Address", value: text(companyAddressLine) },
    { label: "GSTIN", value: text(company?.gstin) },
    { label: sheet?.partyWord || "Party", value: text(sheet?.party?.name) },
    { label: `${sheet?.partyWord || "Party"} GSTIN`, value: text(sheet?.party?.gstin) },
    { label: "Period", value: text(sheet?.period) },
    { label: "Opening", value: balanceLine(sheet?.openingWording) },
    { label: "Closing", value: balanceLine(sheet?.closingWording) },
    { label: "Currency", value: "INR" },
    { label: "Generated", value: text(sheet?.generatedAt) },
  ];
  return rows.filter((r) => text(r.value));
};

/** "4,500.00 Cr (owed by you)" -- a balance with its words. */
export const balanceLine = (wording) => {
  if (!wording) return "";
  if (wording.magnitude === 0) return wording.phrase;
  return `${wording.magnitude.toFixed(2)} ${wording.mode} (${wording.phrase})`;
};

/**
 * The sheets a statement downloads as.
 *
 * Two worksheets, which is the spec's "separate worksheets for summary and
 * detailed records": the month summary first because it is what a person
 * reads, the entries second because it is what they check. The CSV takes the
 * first sheet only, so a CSV of a statement is the month summary -- the
 * detail belongs in a format that can hold two tables.
 */
export const statementSheets = ({ statement: sheet, company, companyAddressLine = "", format = "detailed" } = {}) => {
  const meta = statementMeta({ statement: sheet, company, companyAddressLine });
  const months = monthWise(sheet);

  const detail = {
    name: "Entries",
    title: `${sheet?.sideLabel || "Statement"} -- ${text(sheet?.account)}`,
    meta,
    columns: STATEMENT_COLUMNS,
    rows: sheet?.lines || [],
    totals: { debit: sheet?.totals?.debit ?? 0, credit: sheet?.totals?.credit ?? 0 },
    totalsLabel: "Period total",
  };

  const summary = {
    name: "Month summary",
    title: `${sheet?.sideLabel || "Statement"} -- ${text(sheet?.account)}`,
    meta,
    columns: MONTHLY_COLUMNS,
    rows: months,
    totals: { debit: sheet?.totals?.debit ?? 0, credit: sheet?.totals?.credit ?? 0 },
    totalsLabel: "Period total",
  };

  // Whichever the user asked to SEE goes first, so a CSV download matches the
  // table on the screen.
  return text(format) === "monthly" ? [summary, detail] : [detail, summary];
};
