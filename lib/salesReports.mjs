/**
 * Sigfa's Sales and Purchase module reports.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/sales-reports.test.mjs directly. Mirrors lib/orderReports.mjs,
 * which does the same job for the order book.
 *
 *
 * WHICH THREE, AND WHY THESE THREE
 * --------------------------------
 * Its menus, read out of SIGFA105.exe (the & is the VB6 accelerator):
 *
 *     &Sales Module            &Purchase Module
 *       &Sales Book              &Purchase Book
 *       &Party Wise Sales        &Party Wise
 *       &Item Wise Sales         &Item Wise
 *
 * Six reports, but three shapes, and the other two are the book's rows
 * totalled by party or by item. Written once and keyed by a view, for the
 * reason the order reports are: three copies of "what counts as a sale" is
 * three chances for the party-wise total to disagree with the book above it.
 *
 *
 * THE BOOK IS A PERIOD SUMMARY, NOT A LIST OF BILLS
 * -------------------------------------------------
 * This was read wrong the first time and corrected from the binary. Sigfa's
 * Sales Book builds its column captions by concatenation, starting from the
 * only pair it always shows:
 *
 *     'Month,Bill Amount'
 *
 * then appending, each one behind a flag in its SetupSB table (sbnet, sbdis,
 * sbpack, sbexcise, sbSamt, sbother, sbround, sbunit, sbaexduty,
 * sbsurcharge):
 *
 *     ',Taxable Amount'  ',Discount'  ',Packing'  ',Excise Duty'
 *     ',Cess Amount'  ',HE Cess'  ',Aex Duty'  ',V A T'  ',C.S.Tax'
 *     ',Surcharge Amount'  ',Others'  ',Rounding'  ',Net Amount'
 *
 * and it runs one query per month:
 *
 *     where S.Mkey in('SI','SR') and Month(S.Vdate)=
 *
 * One row per month, in other words. Clicking a month zooms into the dates
 * inside it -- a second query that drops `Month(...)` for ' group by Vdate'
 * and writes its rows to a table called ZoomD. Sigfa's bill-by-bill register
 * is a different report under a different name, its GST Sales Register.
 *
 * So the book here has a GRAIN: by month as Sigfa opens it, by date as its
 * zoom shows it, or by document, which is the register this module was first
 * written as and which is worth keeping -- it is what anyone looking for one
 * bill actually wants.
 *
 * WHICH OF SIGFA'S COLUMNS SURVIVE. Of the thirteen optional ones, nine are
 * pre-GST tax heads -- Excise Duty, Cess Amount, HE Cess, Aex Duty, V A T,
 * C.S.Tax, Surcharge Amount -- or sundry heads this app has no field for, so
 * `GST` stands where that whole block stood. Rounding is dropped because
 * Vyapaar has no round-off field: `finalAmount` is `totalAmount` plus the
 * party taxes and the freight, exactly, so the column would be zero on every
 * row. Discount is dropped from the BOOK alone, because it lives on the
 * invoice LINES and the book deliberately does not fetch them.
 *
 *
 * WHICH DOCUMENTS: SIGFA ASKS, AND SO DOES THIS
 * --------------------------------------------
 * Its Sales Book screen carries a four-way selector, stored as one of its
 * colon-delimited lists:
 *
 *     ' Sales Book : Sales Return : Sales And Sales Return : Sales Challan : '
 *
 * So the netting below is what its THIRD option does; the plain "Sales Book"
 * is invoices only. Three of the four are offered here -- this app has no
 * challan -- and the netted one is the default, because it is the only one
 * that answers "what did we sell".
 *
 *
 * RETURNS ARE IN THE REPORT, AND THEY SUBTRACT
 * --------------------------------------------
 * Not a judgement call -- Sigfa settles it. Its own SQL, verbatim:
 *
 *     And S.Mkey in ('SI','SR')
 *
 *     Sum(IIF(S.Mkey='SI' or S.Mkey='SC' or S.Mkey='PI' or S.Mkey='PC', Amount, 0))
 *       - Sum(IIF(S.Mkey='SR' Or S.Mkey='PR', Amount, 0))
 *
 * So an invoice adds and a return subtracts, inside ONE report rather than in
 * a register of its own, and every money column is netted the same way --
 * the identical expression appears for Amount, Pamt, ItemDisco and Stonamt.
 * 'SC' and 'PC' are its sale and purchase challans, which this app does not
 * have.
 *
 *
 * ONE THING OF SIGFA'S DELIBERATELY NOT COPIED
 * --------------------------------------------
 * It wraps that subtraction in Abs():
 *
 *     Abs(Sum(IIF(... ,Amount,0)) - Sum(IIF(S.Mkey='SR' ..., Amount, 0)))
 *
 * which turns a net of -500 into +500. A party who returned more than they
 * bought in the period would be reported as having bought 500, with nothing
 * on the page saying otherwise. The netting is kept; the Abs is not, and a
 * negative net prints as a negative.
 */

import { round2 } from "./balance.mjs";
import { istDayNumber, istParts } from "./istDate.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** The two modules. The payload's `type` on every invoice. */
export const REPORT_SIDES = ["Sale", "Purchase"];

/** The three report shapes, in Sigfa's menu order. */
export const SALES_VIEWS = ["book", "party", "item"];

export const isReportSide = (side) => REPORT_SIDES.includes(text(side));
export const isSalesView = (view) => SALES_VIEWS.includes(text(view));

/**
 * What a bill with no party on it is filed under.
 *
 * One constant, because two sheets group by party -- `partyWise` and the
 * party-wise book -- and a party-wise book whose blanks said "(blank)" would
 * not reconcile row for row against a Party Wise sheet that said something
 * else.
 */
export const NO_PARTY = "(not named)";

/**
 * Which documents the sheet covers: Sigfa's selector, less its challan.
 *
 * `both` is the netted one -- its "Sales And Sales Return" -- and the
 * default, because it is the only one of the three that answers "what did we
 * sell in March".
 */
export const DOC_SCOPES = ["invoices", "returns", "both"];
export const DEFAULT_SCOPE = "both";
export const isDocScope = (scope) => DOC_SCOPES.includes(text(scope));

/** What Sigfa calls each one, in its own words, per side. */
export const scopeName = (scope, side) => {
  const word = text(side) === "Purchase" ? "Purchase" : "Sales";
  switch (text(scope)) {
    case "invoices":
      return `${word} Book`;
    case "returns":
      return `${word} Return`;
    default:
      return `${word} And ${word} Return`;
  }
};

/**
 * Does this document belong in the sheet?
 *
 * The one place the scope is applied, so the book and the item sheet -- which
 * walk the invoices separately -- cannot disagree about it.
 */
export const inScope = (invoice, scope) => {
  switch (text(scope)) {
    case "invoices":
      return !isReturn(invoice);
    case "returns":
      return isReturn(invoice);
    default:
      // Including an unrecognised value, which is the netted default.
      return true;
  }
};

/**
 * How finely the book is cut: Sigfa opens on the month and zooms to the date.
 *
 * `document` is the third, and not Sigfa's -- its bill-by-bill register is a
 * separate report. It is here because it is what somebody hunting one invoice
 * wants, and because the party and item sheets are built from its rows.
 */
export const BOOK_GRAINS = ["month", "date", "document"];
export const DEFAULT_GRAIN = "month";
export const isBookGrain = (grain) => BOOK_GRAINS.includes(text(grain));

/**
 * Can this sheet be split by party -- and does it need to be?
 *
 * ONE ANSWER, read by the screen (which decides whether to offer the
 * toggle), the route (which decides whether to honour it) and the tests. It
 * used to be written out at all three, and the screen's copy and the route's
 * copy disagreed: the route's gate named the book only, so pressing the
 * toggle on the item sheet set a query parameter nothing acted on.
 *
 * Two sheets are left out, and neither is an oversight:
 *
 *   Bill Wise   one row per document, which already carries the party's name
 *               in a column of its own.
 *   Party Wise  one row per party. There is nothing to split.
 */
export const canSplitByParty = (view, grain) => {
  const sheet = text(view);
  if (sheet === "item") return true;
  return sheet === "book" && text(grain) !== "document";
};

/**
 * What each report is called, in Sigfa's own words.
 *
 * Its Purchase module drops the word -- "Party Wise", not "Party Wise
 * Purchase" -- because the menu it hangs under already says Purchase. Here
 * the three are tabs on one screen with the side chosen separately, so the
 * side is spelled out and nothing is ambiguous when a sheet is printed and
 * put on a desk.
 */
export const reportName = (view, side) => {
  const sales = text(side) !== "Purchase";
  switch (text(view)) {
    case "book":
      return sales ? "Sales Book" : "Purchase Book";
    case "party":
      return sales ? "Party Wise Sales" : "Party Wise Purchase";
    case "item":
      return sales ? "Item Wise Sales" : "Item Wise Purchase";
    default:
      return sales ? "Sales Report" : "Purchase Report";
  }
};

/**
 * Is this document a return?
 *
 * The `return` flag on the invoice, which is what `save-invoice` stores and
 * what lib/invoicePosting.mjs reverses the signs on. Sigfa says the same
 * thing with its MKEY -- 'SR' against 'SI'.
 */
export const isReturn = (invoice) => invoice?.return === true;

/**
 * The sign a document carries in a total: +1 for an invoice, -1 for a return.
 *
 * The whole of Sigfa's netting rule, in one function, so no report can total
 * returns the wrong way round by writing the subtraction out again.
 */
export const documentSign = (invoice) => (isReturn(invoice) ? -1 : 1);

/**
 * The taxable value of an invoice: its total before GST.
 *
 * `totalAmount` IS TAX-INCLUSIVE, whatever its name suggests. The billing
 * screen sums the lines' `total`, and lib/billingMath.mjs computes a line's
 * total as `taxableAmount + gstAmount`. An earlier version of this module
 * read the field at face value and printed the gross in the Taxable column
 * on every sheet.
 *
 * `finalAmount` is that same figure plus the party taxes and the freight, so
 * it is the fallback rather than the first choice: on a bill carrying
 * overheads it is too big by exactly those overheads.
 */
export const taxableOf = (invoice) => {
  const gross = num(invoice?.totalAmount) || num(invoice?.finalAmount);
  return round2(gross - num(invoice?.gst));
};

/**
 * The bill's own net: what the items came to, GST included.
 *
 * Sigfa's `NetAmt`, and the figure its Net Amount column totals.
 */
export const netOf = (invoice) =>
  round2(num(invoice?.totalAmount) || num(invoice?.finalAmount));

/**
 * Everything charged on top of the items: the party taxes and the freight.
 *
 * Sigfa keeps a column per head -- Packing, Surcharge, Others -- because it
 * has a field per head. Here they are one array (`partyTaxes`) plus freight,
 * added after tax by the billing screen, so they are one column.
 *
 * Derived from the difference rather than by summing the array, because the
 * book does not fetch `partyTaxes` and `finalAmount - totalAmount` is that
 * sum by construction. Floored at nothing: a negative would mean the two
 * stored figures disagree, and the honest thing is to show it.
 */
export const othersOf = (invoice) => {
  const gross = num(invoice?.totalAmount);
  if (!gross) return 0;
  return round2(num(invoice?.finalAmount) - gross);
};

/** One row of the book: a document, as the register lists it. */
export const bookRow = (invoice) => {
  const sign = documentSign(invoice);
  const taxable = taxableOf(invoice);
  const gst = round2(num(invoice?.gst));
  const net = netOf(invoice);
  const others = othersOf(invoice);
  const total = round2(num(invoice?.finalAmount));
  const parts = istParts(invoice?.date);

  return {
    invoiceNo: num(invoice?.invoiceNo),
    // What the bill PRINTS as -- a series bill's "26-27/1" (lib/series.mjs).
    // Shown in the book and its exports; `invoiceNo` stays the sort and the
    // span, because only it runs unbroken across every series.
    voucherNo: text(invoice?.voucherNo),
    date: invoice?.date ?? null,
    day: istDayNumber(invoice?.date),
    // The period this document falls in, as the book groups by. Taken from
    // the IST parts rather than from the day number, because a day number
    // cannot be cut into months without knowing where the months start.
    month: parts ? `${parts.year}-${String(parts.month).padStart(2, "0")}` : null,
    party: text(invoice?.customer?.name),
    gstin: text(invoice?.customer?.gstin),
    state: text(invoice?.stateOfSupply),
    taxType: text(invoice?.taxType),
    isReturn: isReturn(invoice),
    // The figures AS PRINTED on the document -- always positive, because a
    // credit note for 500 is a credit note for 500, not for -500.
    taxable,
    gst,
    // Sigfa's Net Amount: the items, GST included, before the overheads.
    net,
    // And its Packing/Surcharge/Others block, which here is one column.
    others,
    total,
    received: round2(num(invoice?.received)),
    balanceDue: round2(num(invoice?.balanceDue)),
    // And the figures AS TOTALLED, which carry the sign. Keeping both is what
    // lets the book show a return at its face value and still add up.
    signedTaxable: round2(sign * taxable),
    signedGst: round2(sign * gst),
    signedNet: round2(sign * net),
    signedOthers: round2(sign * others),
    signedTotal: round2(sign * total),
    sign,
  };
};

/**
 * The documents a report covers, oldest first.
 *
 * Filtered on the side, the period and the scope. `from` and `to` are IST
 * calendar days, compared the way every date in this app is -- the container
 * runs Asia/Calcutta and Vercel runs UTC, so a local-clock comparison puts a
 * late-evening invoice in the wrong month.
 *
 * The scope defaults to Sigfa's netted one, so a caller that does not ask
 * gets invoices AND returns.
 */
export const documentsFor = ({ invoices = [], side, from, to, scope } = {}) => {
  const wanted = text(side);
  const start = from ? istDayNumber(from) : null;
  const end = to ? istDayNumber(to) : null;

  return invoices
    .filter(Boolean)
    .filter((inv) => (wanted ? text(inv.type) === wanted : true))
    .filter((inv) => inScope(inv, scope))
    .filter((inv) => {
      const day = istDayNumber(inv.date);
      if (day === null) return false;
      if (start !== null && day < start) return false;
      if (end !== null && day > end) return false;
      return true;
    })
    .map(bookRow)
    .sort((a, b) => a.day - b.day || a.invoiceNo - b.invoiceNo);
};

/** The totals under any of the three sheets. */
export const totalsOf = (rows = []) => ({
  documents: rows.length,
  returns: rows.filter((r) => r.isReturn).length,
  taxable: round2(rows.reduce((t, r) => t + num(r.signedTaxable), 0)),
  gst: round2(rows.reduce((t, r) => t + num(r.signedGst), 0)),
  net: round2(rows.reduce((t, r) => t + num(r.signedNet), 0)),
  others: round2(rows.reduce((t, r) => t + num(r.signedOthers), 0)),
  total: round2(rows.reduce((t, r) => t + num(r.signedTotal), 0)),
});

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Which period a document falls in, at this grain. */
export const periodKey = (row, grain) => {
  if (text(grain) === "date") {
    const p = istParts(row?.date);
    return p ? `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` : null;
  }
  return row?.month ?? null;
};

/** That period as it is printed: "Mar 2026", or "15 Mar 2026". */
export const periodLabel = (key) => {
  const parts = text(key).split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!year || !month || month < 1 || month > 12) return text(key);
  const name = `${MONTH_NAMES[month - 1]} ${year}`;
  if (parts.length < 3) return name;
  const day = Number(parts[2]);
  return day ? `${day} ${name}` : name;
};

/**
 * The book at a period grain: one row per month, or per date.
 *
 * Sigfa runs a query per month and this folds one list instead, which is the
 * same answer without twelve round trips. Oldest first, because a book is
 * read forwards.
 *
 * Every money column carries the sign, so a month whose returns outweigh its
 * sales shows a negative -- see the module header on the Abs() that is
 * deliberately not copied.
 */
export const periodWise = (rows = [], grain = "month", { byParty = false } = {}) => {
  const groups = new Map();

  for (const row of rows) {
    const period = periodKey(row, grain);
    if (period === null) continue;

    // Unnamed the same way partyWise names it, so a party-wise book and a
    // party-wise sheet of the same period do not disagree about who the
    // blank-named bills belong to.
    const party = byParty ? row.party || NO_PARTY : "";
    // A party name may hold anything a keyboard can type, so the one
    // character it cannot is what joins the two halves of the key. A hyphen
    // here and "Mar 2026" for "Shah - Delhi" collides with "Mar" for
    // "2026 - Shah - Delhi".
    const key = byParty ? `${period}\u0000${party}` : period;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        // The period on its own, whatever the key carries around it. The
        // zoom and the distinct-period count both need it back, and with a
        // party in the key they cannot read it off that.
        period,
        // The month a date row belongs to, so a zoomed sheet knows where it
        // came from and a month row knows what to zoom into.
        month: row.month ?? null,
        label: periodLabel(period),
        ...(byParty ? { party, gstin: row.gstin || "" } : {}),
        documents: 0,
        // The numbers this period covers, lowest and highest. A register is
        // read to find a bill, so the span is what a reader wants from a
        // month row -- and a gap between one month's last and the next
        // month's first is the thing a register exists to make visible.
        //
        // `documents` is still counted beside them: the footer totals it and
        // the sheet's meta line prints it. Only the COLUMN changed.
        firstNo: null,
        lastNo: null,
        returns: 0,
        taxable: 0,
        gst: 0,
        net: 0,
        others: 0,
        total: 0,
        balanceDue: 0,
      });
    }

    const g = groups.get(key);
    g.documents += 1;
    // Returns carry their own numbers and belong in the span: a credit note
    // is a document in the book, and leaving it out would show a gap where
    // there is none.
    const no = num(row.invoiceNo);
    if (no) {
      g.firstNo = g.firstNo === null ? no : Math.min(g.firstNo, no);
      g.lastNo = g.lastNo === null ? no : Math.max(g.lastNo, no);
    }
    if (row.isReturn) g.returns += 1;
    g.taxable = round2(g.taxable + row.signedTaxable);
    g.gst = round2(g.gst + row.signedGst);
    g.net = round2(g.net + row.signedNet);
    g.others = round2(g.others + row.signedOthers);
    g.total = round2(g.total + row.signedTotal);
    g.balanceDue = round2(g.balanceDue + row.sign * row.balanceDue);
    // Backfilled, not taken from the first document: that one may be the
    // bill saved before the party's GSTIN was filled in. partyWise carries
    // the same line for the same reason.
    if (byParty && !g.gstin && row.gstin) g.gstin = row.gstin;
  }

  const out = [...groups.values()];
  const byPeriod = (a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0);
  if (!byParty) return out.sort(byPeriod);
  // Periods forwards, because a book is read forwards; inside one period the
  // biggest party first, which is how partyWise sorts.
  return out.sort((a, b) => byPeriod(a, b) || b.total - a.total || a.party.localeCompare(b.party));
};

/**
 * The dates inside one month: Sigfa's zoom, which it writes to a ZoomD table.
 *
 * Takes the book rows already in hand rather than asking again, so opening a
 * month costs nothing and cannot disagree with the row that was clicked.
 */
export const zoomInto = (rows = [], monthKey, options = {}) => {
  const wanted = text(monthKey);
  if (!wanted) return [];
  // The split travels into the zoom: opening a month on a party-wise book
  // must not quietly drop the party column the row that was clicked had.
  return periodWise(rows.filter((row) => text(row?.month) === wanted), "date", options);
};

/**
 * The bill numbers a period covers, as the register prints them.
 *
 * "1 – 7" for a span, "4" for a single bill, "—" for a period whose
 * documents carry no number at all. An en dash, not a hyphen: these are
 * numbers either side of it and a hyphen reads as a minus.
 *
 * Pure and exported so the CSV column and the screen print the same string
 * rather than each formatting it, which is how a downloaded sheet and the
 * page it came from come to disagree.
 */
export const billNoRange = (row = {}) => {
  const first = num(row?.firstNo);
  const last = num(row?.lastNo);
  if (!first && !last) return "—";
  if (!first || !last || first === last) return String(first || last);
  return `${first} – ${last}`;
};

/** The totals under a period sheet. */
export const periodTotals = (rows = []) => ({
  // Distinct periods, not rows: party-wise, one month is several rows, and
  // "3 periods" under a sheet covering one month would be wrong.
  periods: new Set(rows.map((r) => text(r?.period) || text(r?.key))).size,
  // Only meaningful on a party-wise sheet, where it is the count the footer
  // prints; nought on a plain period sheet, which has no party dimension.
  parties: new Set(rows.filter((r) => text(r?.party)).map((r) => text(r.party))).size,
  documents: rows.reduce((t, r) => t + num(r.documents), 0),
  returns: rows.reduce((t, r) => t + num(r.returns), 0),
  taxable: round2(rows.reduce((t, r) => t + num(r.taxable), 0)),
  gst: round2(rows.reduce((t, r) => t + num(r.gst), 0)),
  net: round2(rows.reduce((t, r) => t + num(r.net), 0)),
  others: round2(rows.reduce((t, r) => t + num(r.others), 0)),
  total: round2(rows.reduce((t, r) => t + num(r.total), 0)),
  balanceDue: round2(rows.reduce((t, r) => t + num(r.balanceDue), 0)),
});

/**
 * Party Wise: the same documents, one row per party.
 *
 * Sorted by value descending -- the party you most want to see first is the
 * one you have sold the most to, which is also how the order reports sort.
 */
export const partyWise = (rows = []) => {
  const groups = new Map();

  for (const row of rows) {
    const key = row.party || NO_PARTY;
    if (!groups.has(key)) {
      groups.set(key, {
        party: key,
        gstin: row.gstin,
        state: row.state,
        documents: 0,
        returns: 0,
        taxable: 0,
        gst: 0,
        net: 0,
        others: 0,
        total: 0,
        balanceDue: 0,
      });
    }
    const g = groups.get(key);
    g.documents += 1;
    if (row.isReturn) g.returns += 1;
    g.taxable = round2(g.taxable + row.signedTaxable);
    g.gst = round2(g.gst + row.signedGst);
    g.net = round2(g.net + row.signedNet);
    g.others = round2(g.others + row.signedOthers);
    g.total = round2(g.total + row.signedTotal);
    // What is still owed on the documents in this period, not the party's
    // whole balance -- that is the ledger's answer, not this report's.
    g.balanceDue = round2(g.balanceDue + row.sign * row.balanceDue);
    if (!g.gstin && row.gstin) g.gstin = row.gstin;
  }

  return [...groups.values()].sort(
    (a, b) => b.total - a.total || a.party.localeCompare(b.party)
  );
};

/**
 * Item Wise: one row per item, across every document in the period.
 *
 * Reads the invoice LINES, which is why this takes the documents rather than
 * the book rows: a book row is one document, and an item-wise sheet needs
 * inside it.
 *
 * The line's own stored figures are used -- `taxableAmount`, `gstAmount` and
 * `total`, as the billing screen computed and the server stored them. Not
 * recomputed here: the stored line money is what the invoice says, and a
 * report that recalculated it could disagree with the printed bill.
 */
export const itemWise = ({ invoices = [], side, from, to, scope, byParty = false } = {}) => {
  const wanted = text(side);
  const start = from ? istDayNumber(from) : null;
  const end = to ? istDayNumber(to) : null;
  const groups = new Map();

  for (const invoice of invoices.filter(Boolean)) {
    if (wanted && text(invoice.type) !== wanted) continue;
    if (!inScope(invoice, scope)) continue;
    const day = istDayNumber(invoice.date);
    if (day === null) continue;
    if (start !== null && day < start) continue;
    if (end !== null && day > end) continue;

    const sign = documentSign(invoice);

    // The party the LINE was billed to. Read off the document rather than the
    // line, because a line has no party of its own -- which is also why an
    // item-wise sheet had no name on it until this split existed.
    const party = byParty ? text(invoice?.customer?.name) || NO_PARTY : "";
    const partyGstin = byParty ? text(invoice?.customer?.gstin) : "";

    for (const line of invoice.items || []) {
      const name = text(line?.name);
      if (!name) continue;
      // A NUL joins the two halves, as it does on the period sheet: it cannot
      // occur in an item name or a party name, so "A" + "B C" and "A B" + "C"
      // cannot collide into one row.
      const key = byParty
        ? `${name.toLowerCase()}\u0000${party.toLowerCase()}`
        : name.toLowerCase();

      if (!groups.has(key)) {
        groups.set(key, {
          item: name,
          ...(byParty ? { party, gstin: partyGstin } : {}),
          // The HSN and the unit are filled in below rather than here, on
          // this line and every later one: the FIRST line of the first
          // document may be the one that was saved without them. Written
          // twice -- once at creation and once as a backfill -- it was the
          // same rule in two places, and the creation copy was dead.
          hsn: "",
          unit: "",
          documents: new Set(),
          quantity: 0,
          taxable: 0,
          gst: 0,
          total: 0,
        });
      }

      const g = groups.get(key);
      g.documents.add(`${text(invoice.type)}#${num(invoice.invoiceNo)}`);
      g.quantity = round2(g.quantity + sign * num(line?.quantity));
      g.taxable = round2(g.taxable + sign * num(line?.taxableAmount));
      g.gst = round2(g.gst + sign * num(line?.gstAmount));
      g.total = round2(g.total + sign * num(line?.total));
      // Backfilled on every line, not only the first: the earliest document
      // for a party may be the one saved before their GSTIN was entered.
      if (byParty && !g.gstin && partyGstin) g.gstin = partyGstin;
      if (!g.hsn) g.hsn = text(line?.hsn);
      // UQC is the GST code and `unit` is whatever was typed into the item
      // master. The code is preferred: it is the one that has to agree with
      // the return, and the only one a portal will accept.
      if (!g.unit) g.unit = text(line?.uqc) || text(line?.unit);
    }
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      documents: g.documents.size,
      // The average rate actually achieved: value over quantity. Null rather
      // than a division by zero when a period's returns cancel the sales out.
      rate: g.quantity ? round2(g.taxable / g.quantity) : null,
    }))
    .sort(
      (a, b) =>
        b.total - a.total ||
        a.item.localeCompare(b.item) ||
        text(a.party).localeCompare(text(b.party))
    );
};

/**
 * The totals under the item-wise sheet.
 *
 * `items` counts DISTINCT ITEMS, not rows. Split by party there is a row per
 * item per party, so counting rows would report eleven items for a sheet
 * holding four -- the same mistake the period sheet's `periods` count had to
 * be fixed for.
 */
export const itemTotals = (rows = []) => ({
  items: new Set(rows.map((r) => text(r?.item).toLowerCase()).filter(Boolean)).size,
  // 0 on an unsplit sheet, where no row carries a party.
  parties: new Set(rows.map((r) => text(r?.party)).filter(Boolean)).size,
  quantity: round2(rows.reduce((t, r) => t + num(r.quantity), 0)),
  taxable: round2(rows.reduce((t, r) => t + num(r.taxable), 0)),
  gst: round2(rows.reduce((t, r) => t + num(r.gst), 0)),
  total: round2(rows.reduce((t, r) => t + num(r.total), 0)),
});

/** The totals under the party-wise sheet. */
export const partyTotals = (rows = []) => ({
  parties: rows.length,
  taxable: round2(rows.reduce((t, r) => t + num(r.taxable), 0)),
  gst: round2(rows.reduce((t, r) => t + num(r.gst), 0)),
  total: round2(rows.reduce((t, r) => t + num(r.total), 0)),
  balanceDue: round2(rows.reduce((t, r) => t + num(r.balanceDue), 0)),
});

/**
 * The columns of these sheets that hold words rather than figures.
 *
 * Read by `sheetHeadings` to decide alignment. Keyed rather than positional
 * because a sheet may carry a text column that is not its first -- the
 * party-wise book carries two.
 */
const TEXT_COLUMNS = new Set([
  "label",
  "date",
  "party",
  "gstin",
  "state",
  "kind",
  "item",
  "hsn",
  "unit",
]);

/** The column sets each sheet downloads as. */
export const CSV_COLUMNS = {
  // The period sheets, at either grain, in Sigfa's order and Sigfa's
  // spelling. `Month` and `Bill Amount` are the pair it always shows; the
  // rest sit behind its SetupSB flags, and the nine pre-GST heads it can
  // also show have no field here -- the module header says which and why.
  //
  // THE SCREEN READS THIS LIST TOO, for its own column headings. It used to
  // carry a second copy of the captions under its own name, which is how the
  // printed sheet and the download come to disagree about what a column is
  // called.
  period: [
    { key: "label", label: "Month" },
    // The numbers, not how many: a register is read to find a bill. The
    // count is still on the row and still totalled under the sheet.
    { key: "billNo", label: "Bill No", value: billNoRange },
    { key: "returns", label: "Returns" },
    { key: "taxable", label: "Taxable Amount" },
    { key: "gst", label: "GST" },
    { key: "net", label: "Net Amount" },
    { key: "others", label: "Others" },
    { key: "total", label: "Bill Amount" },
  ],
  // The period sheet split by party: one row per party per period, which is
  // what puts a NAME on a month's figures. Sigfa has no such sheet -- its
  // book is periods and its Party Wise is the whole range in one row each,
  // and neither answers "who did we sell to in March". Party and GSTIN sit
  // straight after the period, where a reader looks for them.
  periodParty: [
    { key: "label", label: "Month" },
    { key: "party", label: "Party" },
    { key: "gstin", label: "GSTIN" },
    // Split by party, the span is that PARTY's bills inside the period, so
    // it is not the whole month's -- which is what makes it worth printing
    // on a split sheet rather than repeating the month's own span.
    { key: "billNo", label: "Bill No", value: billNoRange },
    { key: "returns", label: "Returns" },
    { key: "taxable", label: "Taxable Amount" },
    { key: "gst", label: "GST" },
    { key: "net", label: "Net Amount" },
    { key: "others", label: "Others" },
    { key: "total", label: "Bill Amount" },
  ],
  book: [
    { key: "date", label: "Date" },
    // The number printed on the bill, as Sigfa's book lists its Voucher.
    { key: "invoiceNo", label: "Invoice No", value: (r) => r.voucherNo || r.invoiceNo },
    { key: "party", label: "Party" },
    { key: "gstin", label: "GSTIN" },
    { key: "state", label: "State" },
    { key: "kind", label: "Document", value: (r) => (r.isReturn ? "Return" : "Invoice") },
    { key: "taxable", label: "Taxable Amount" },
    { key: "gst", label: "GST" },
    { key: "net", label: "Net Amount" },
    { key: "others", label: "Others" },
    { key: "total", label: "Bill Amount" },
    { key: "received", label: "Received" },
    { key: "balanceDue", label: "Balance Due" },
  ],
  party: [
    { key: "party", label: "Party" },
    { key: "gstin", label: "GSTIN" },
    { key: "state", label: "State" },
    { key: "documents", label: "Documents" },
    { key: "returns", label: "Returns" },
    { key: "taxable", label: "Taxable" },
    { key: "gst", label: "GST" },
    { key: "total", label: "Total" },
    { key: "balanceDue", label: "Balance Due" },
  ],
  item: [
    { key: "item", label: "Item" },
    { key: "hsn", label: "HSN" },
    { key: "unit", label: "Unit" },
    { key: "documents", label: "Documents" },
    { key: "quantity", label: "Quantity" },
    { key: "rate", label: "Avg Rate", value: (r) => (r.rate === null ? "" : r.rate) },
    { key: "taxable", label: "Taxable" },
    { key: "gst", label: "GST" },
    { key: "total", label: "Total" },
  ],
  // The item sheet split by party: one row per item per party, which is what
  // answers "who bought the 10mm plate". Sigfa's Item Wise is the whole range
  // one row per item and cannot say; nor could this one, which is why an
  // item-wise sheet was the last table here with no name on it anywhere.
  //
  // Party and GSTIN sit after the item's own identity -- the item is what
  // the sheet is sorted and read by, and the name qualifies it.
  itemParty: [
    { key: "item", label: "Item" },
    { key: "hsn", label: "HSN" },
    { key: "unit", label: "Unit" },
    { key: "party", label: "Party" },
    { key: "gstin", label: "GSTIN" },
    { key: "documents", label: "Documents" },
    { key: "quantity", label: "Quantity" },
    { key: "rate", label: "Avg Rate", value: (r) => (r.rate === null ? "" : r.rate) },
    { key: "taxable", label: "Taxable" },
    { key: "gst", label: "GST" },
    { key: "total", label: "Total" },
  ],
};

/**
 * The captions a sheet shows, taken off its download columns.
 *
 * `first` relabels the leading one, which is the only caption that changes
 * with the grain: Sigfa's is Month, and its zoom shows dates.
 */
export const sheetHeadings = (view, first) => {
  const columns = CSV_COLUMNS[text(view)] || [];
  return columns.map((column, index) => ({
    key: column.key,
    label: index === 0 && text(first) ? text(first) : column.label,
    // By key, not by position. Positional, it right-aligned the party name
    // and the GSTIN the moment a sheet carried a text column that was not
    // its first one.
    numeric: !TEXT_COLUMNS.has(column.key),
  }));
};

/**
 * The filename a download carries.
 *
 * The grain goes in it when one is given, because a month sheet and a bill
 * sheet of the same month would otherwise land in the downloads folder under
 * one name and overwrite each other.
 */
export const csvFilename = (view, side, from, to, grain, { byParty = false } = {}) => {
  const stem = reportName(view, side).toLowerCase().replace(/\s+/g, "-");
  const cut = text(grain) && text(grain) !== "document" ? `-${text(grain)}` : "";
  // The split goes in it too, for the same reason the grain does: a month
  // sheet and a party-wise month sheet of the same period would otherwise
  // land in the downloads folder under one name.
  const split = byParty ? "-party-wise" : "";
  return `${stem}${cut}${split}-${from || "all"}-to-${to || "all"}.csv`;
};
