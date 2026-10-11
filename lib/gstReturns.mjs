/**
 * Sigfa's GST returns.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/gst-returns.test.mjs directly.
 *
 *
 * WHICH FOUR, AND WHY THEIR NAMES READ LIKE THAT
 * ----------------------------------------------
 * Sigfa's menu captions, read out of SIGFA105.exe and kept word for word,
 * square brackets and all, so the client reads the same labels here:
 *
 *     GSTR-1 [ E-Return ]
 *     GSTR-1 [ Outward Supply - Sale ]
 *     GSTR-3 [ Inward And Outward ]
 *     GSTR-3B [ Inward And Outward ]
 *
 * The first is the FILE you upload; the other three are sheets you read. That
 * split is Sigfa's, not an invention here -- its menu lists the e-return as
 * its own item, above the readable one.
 *
 * Its table captions and its internal report codes (GSTR_1_04, GSTR_1_05 ...)
 * came out of the same binary and are kept too, because a return is filed
 * against numbered tables and the numbers are how anyone checks the figures
 * against the portal.
 *
 *
 * FOUR TABLES CANNOT BE FILLED, AND SAY SO
 * ----------------------------------------
 * An invoice here records no export flag, no nil-rated / exempt / non-GST
 * flag, no reverse-charge flag and no tax-paid advances. So EXP (6), EXEMP
 * (8), AT/ATADJ (11) and GSTR-3's reverse-charge table (5) have nothing
 * honest to put in them.
 *
 * They are listed anyway, in Sigfa's numbering, each carrying the field it
 * would need. An empty table that says why is a question answered; a table
 * quietly missing from a return is a liability.
 *
 * In particular a 0% line is NOT filed as exempt. Nil-rated, exempted and
 * non-GST are three different tables on the portal and a zero rate does not
 * say which -- guessing would put figures in the wrong one, which is worse
 * than leaving it blank.
 *
 *
 * WHAT IS READ, AND WHAT IS NOT RE-DERIVED
 * ----------------------------------------
 * `taxType` ('local' or 'central') decides IGST against CGST+SGST. It is
 * decided when the bill is raised, from the place of supply, and stored --
 * so it is READ here rather than worked out again. A return that re-derived
 * it could disagree with the invoice the client already printed and sent.
 *
 * The halving of a local tax uses lib/gst.mjs's `splitGst`, which the printed
 * invoice and the e-invoice payload already use. Splitting in paise matters:
 * `(tax / 2).toFixed(2)` twice is a paisa out whenever the tax lands on an
 * odd number of paise, and a return whose CGST and SGST do not add back to
 * the tax charged is a return the portal rejects.
 */

import { round2 } from "./balance.mjs";
import { normalizeStateCode, splitGst } from "./gst.mjs";
import { istDayNumber, istParts } from "./istDate.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** The four returns, as Sigfa's menu names them. */
export const GST_RETURNS = [
  {
    key: "gstr1-ereturn",
    code: "GSTR1_ER",
    title: "GSTR-1 [ E-Return ]",
    blurb: "The JSON to upload to the portal.",
  },
  {
    key: "gstr1",
    code: "GSTR_1",
    title: "GSTR-1 [ Outward Supply - Sale ]",
    blurb: "Outward supplies, table by table.",
  },
  {
    key: "gstr3",
    code: "GSTR_3",
    title: "GSTR-3 [ Inward And Outward ]",
    blurb: "Turnover, outward supplies and input credit.",
  },
  {
    key: "gstr3b",
    code: "GSTR3B",
    title: "GSTR-3B [ Inward And Outward ]",
    blurb: "The monthly summary return.",
  },
];

export const RETURN_KEYS = GST_RETURNS.map((r) => r.key);
export const isReturnKey = (key) => RETURN_KEYS.includes(text(key));
export const returnTitle = (key) =>
  GST_RETURNS.find((r) => r.key === text(key))?.title ?? "GST Return";

/**
 * Sigfa's GSTR-1 tables, in its numbering and its words.
 *
 * `filled: false` carries `needs`: the field an invoice would have to record
 * before the table could be built. The screen prints it.
 */
export const GSTR1_SECTIONS = [
  { no: "4", tag: "B2B", code: "GSTR_1_04", filled: true,
    title: "4. Taxable Sale To A Registered Person (B2B)" },
  { no: "5", tag: "B2CL", code: "GSTR_1_05", filled: true,
    title: "5. Inter-State Sale To Un-Reg. Persons Inv.Value Above Rs 2.5 Lakh (B2CL)" },
  { no: "6", tag: "EXP", code: "GSTR_1_06", filled: false,
    needs: "an export or deemed-export flag on the invoice",
    title: "6. Zero Rated Supplies And Deemed Exports (EXP)" },
  { no: "7", tag: "B2CS", code: "GSTR_1_07", filled: true,
    title: "7. Taxable Supplies (Net Of Debit And Credit Notes) To Un-Reg. Persons (B2CS)" },
  { no: "8", tag: "EXEMP", code: "GSTR_1_08", filled: false,
    needs: "a nil-rated / exempted / non-GST flag -- a 0% line could be any of the three, and they are three different tables",
    title: "8. Nil Rated, Exempted And Non GST Outward Supplies (EXEMP)" },
  { no: "9", tag: "CDNR", code: "GSTR_1_09", filled: true,
    title: "9. Sales Return For Register Persons (CDNR)" },
  { no: "10", tag: "CDNUR", code: "GSTR_1_10", filled: true,
    title: "10. Sales Return For Un-Register Persons (CDNUR)" },
  { no: "11", tag: "AT", code: "GSTR_1_11", filled: false,
    needs: "advance receipts carrying tax, and their adjustment against later bills",
    title: "11. Advances Received/Advance Adjusted (AT,ATADJ)" },
  { no: "12", tag: "HSN", code: "GSTR_1_12", filled: true,
    title: "12. HSN-wise Summary Of Outward Supplies (HSN)" },
  { no: "13", tag: "DOCS", code: "GSTR_Documents", filled: true,
    title: "13. Documents" },
];

/** Sigfa's GSTR-3 tables. */
export const GSTR3_SECTIONS = [
  { no: "3", code: "GSTR_3_03", filled: true, title: "3. Turnover Details" },
  { no: "4", code: "GSTR_3_04", filled: true,
    title: "4. Outward supplies (Net Supply for the month)" },
  { no: "5", code: "GSTR_3_05", filled: false,
    needs: "a reverse-charge flag on the purchase",
    title: "5. Inward supplies on which tax is payable on reverse charge basis" },
  { no: "6", code: "GSTR_3_06", filled: true, title: "6. Input tax credit" },
  { no: "8", code: "GSTR_3_08", filled: true, title: "8. Total tax liability" },
];

/**
 * GSTR-3B's tables.
 *
 * Sigfa's menu names the return and not its tables, so these are the
 * portal's own numbering and wording rather than Sigfa's -- which is the
 * right source anyway, since 3B is filed against exactly these rows.
 */
export const GSTR3B_SECTIONS = [
  { no: "3.1(a)", filled: true,
    title: "3.1(a) Outward taxable supplies (other than zero rated, nil rated and exempted)" },
  { no: "3.1(b)", filled: false, needs: "an export flag on the invoice",
    title: "3.1(b) Outward taxable supplies (zero rated)" },
  { no: "3.1(c)", filled: false, needs: "a nil-rated / exempted flag on the invoice",
    title: "3.1(c) Other outward supplies (nil rated, exempted)" },
  { no: "3.1(d)", filled: false, needs: "a reverse-charge flag on the purchase",
    title: "3.1(d) Inward supplies (liable to reverse charge)" },
  { no: "3.1(e)", filled: false, needs: "a non-GST flag on the invoice",
    title: "3.1(e) Non-GST outward supplies" },
  { no: "3.2", filled: true,
    title: "3.2 Of the supplies in 3.1(a), inter-State supplies to unregistered persons" },
  { no: "4", filled: true, title: "4. Eligible ITC" },
  { no: "5", filled: false, needs: "an exempt / nil-rated marker on the purchase",
    title: "5. Values of exempt, nil rated and non-GST inward supplies" },
];

/** Table 5's threshold, in rupees. Sigfa says so in its own caption. */
export const B2CL_THRESHOLD = 250000;

/* ─────────────────────────── classification ─────────────────────────── */

/** Is the buyer registered? The GSTIN on the invoice's own buyer snapshot. */
export const isRegistered = (invoice) => Boolean(text(invoice?.customer?.gstin));

/**
 * Is this an inter-State supply?
 *
 * Read off the stored `taxType`, not worked out again from the states. See
 * the module header.
 */
export const isInterState = (invoice) => text(invoice?.taxType) === "central";

/** Is this document a credit note rather than a bill? */
export const isCreditNote = (invoice) => invoice?.return === true;

/** The place of supply, two digits, as the portal wants it. */
export const placeOf = (invoice) => normalizeStateCode(invoice?.stateCode);

/** The invoice value: what the party was charged. */
export const invoiceValue = (invoice) => round2(num(invoice?.finalAmount));

/** `dd-mm-yyyy`, the only date format the portal's JSON accepts. */
export const portalDate = (value) => {
  const p = istParts(value);
  if (!p) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(p.day)}-${pad(p.month)}-${p.year}`;
};

/** `mmyyyy`, the portal's tax period. Taken from the period's FIRST day. */
export const taxPeriod = (from) => {
  const p = istParts(from);
  if (!p) return "";
  return `${String(p.month).padStart(2, "0")}${p.year}`;
};

/**
 * Which of Sigfa's tables a sales document belongs in.
 *
 * One function, so no two tables can claim the same bill and none can drop
 * it. The order is the portal's own logic: a credit note is filed as a
 * credit note whatever its value, and only then does registration decide.
 */
export const tableFor = (invoice) => {
  if (isCreditNote(invoice)) return isRegistered(invoice) ? "CDNR" : "CDNUR";
  if (isRegistered(invoice)) return "B2B";
  if (isInterState(invoice) && invoiceValue(invoice) > B2CL_THRESHOLD) return "B2CL";
  return "B2CS";
};

/* ──────────────────────────── the tax split ─────────────────────────── */

/**
 * One rate's worth of tax, split the way the supply was taxed.
 *
 * An inter-State supply is all IGST; an intra-State one is halved into CGST
 * and SGST by lib/gst.mjs, in paise. Cess is always nothing: this app has no
 * cess field, and a zero is the truthful answer rather than a gap.
 */
export const taxSplit = (gstAmount, interState) => {
  const tax = round2(num(gstAmount));
  if (interState) return { iamt: tax, camt: 0, samt: 0, csamt: 0 };
  const { cgst, sgst } = splitGst(tax);
  return { iamt: 0, camt: cgst, samt: sgst, csamt: 0 };
};

/** Two splits added together, so a group of lines totals exactly once. */
const addTax = (a, b) => ({
  iamt: round2(a.iamt + b.iamt),
  camt: round2(a.camt + b.camt),
  samt: round2(a.samt + b.samt),
  csamt: round2(a.csamt + b.csamt),
});

export const ZERO_TAX = { iamt: 0, camt: 0, samt: 0, csamt: 0 };

/**
 * An invoice's lines grouped by GST rate, as every table needs them.
 *
 * The portal files a rate at a time: one invoice with 5% and 18% lines is
 * two `itms` entries. The taxable value and the tax come off the LINES as
 * stored, never recomputed -- the stored figures are what the printed bill
 * says, and a return that disagreed with the bill is the one thing a client
 * cannot explain to an officer.
 *
 * The split is applied ONCE PER GROUP rather than per line, so the odd paisa
 * is carried once for the group. Per line it would be carried per line, and
 * CGST + SGST would drift from the tax charged.
 */
export const rateGroups = (invoice) => {
  const interState = isInterState(invoice);
  const groups = new Map();

  for (const line of invoice?.items || []) {
    const rt = num(line?.gstRate);
    if (!groups.has(rt)) groups.set(rt, { rt, txval: 0, gst: 0 });
    const g = groups.get(rt);
    g.txval = round2(g.txval + num(line?.taxableAmount));
    g.gst = round2(g.gst + num(line?.gstAmount));
  }

  return [...groups.values()]
    .sort((a, b) => a.rt - b.rt)
    .map((g, index) => ({
      num: index + 1,
      itm_det: { rt: g.rt, txval: g.txval, ...taxSplit(g.gst, interState) },
    }));
};

/** Every rate group's tax and taxable value, added up. */
export const groupTotals = (groups = []) =>
  groups.reduce(
    (total, g) => ({
      txval: round2(total.txval + num(g.itm_det?.txval)),
      ...addTax(total, {
        iamt: num(g.itm_det?.iamt),
        camt: num(g.itm_det?.camt),
        samt: num(g.itm_det?.samt),
        csamt: num(g.itm_det?.csamt),
      }),
    }),
    { txval: 0, ...ZERO_TAX }
  );

/* ───────────────────────── which documents ──────────────────────────── */

/**
 * The sales or purchase documents a return covers, oldest first.
 *
 * IST calendar days, like every other date comparison in this app: the
 * container runs Asia/Calcutta and Vercel runs UTC, so a local-clock
 * comparison files a late-evening invoice in the wrong month -- which on a
 * return means filing it in the wrong period.
 */
export const documentsIn = ({ invoices = [], side = "Sale", from, to } = {}) => {
  const wanted = text(side);
  const start = from ? istDayNumber(from) : null;
  const end = to ? istDayNumber(to) : null;

  return invoices
    .filter(Boolean)
    .filter((inv) => text(inv.type) === wanted)
    .filter((inv) => {
      const day = istDayNumber(inv.date);
      if (day === null) return false;
      if (start !== null && day < start) return false;
      if (end !== null && day > end) return false;
      return true;
    })
    .sort((a, b) => istDayNumber(a.date) - istDayNumber(b.date) || num(a.invoiceNo) - num(b.invoiceNo));
};

/* ──────────────────────────── the tables ────────────────────────────── */

/** Table 4: one block per buyer GSTIN, their invoices inside it. */
export const b2bBlocks = (documents = []) => {
  const byCtin = new Map();

  for (const invoice of documents) {
    if (tableFor(invoice) !== "B2B") continue;
    const ctin = text(invoice.customer?.gstin).toUpperCase();
    if (!byCtin.has(ctin)) byCtin.set(ctin, { ctin, party: text(invoice.customer?.name), inv: [] });
    byCtin.get(ctin).inv.push({
      inum: String(num(invoice.invoiceNo)),
      idt: portalDate(invoice.date),
      val: invoiceValue(invoice),
      pos: placeOf(invoice),
      // No reverse-charge field on an invoice here, so every bill is filed
      // as not liable -- which is what it is, absent a flag saying otherwise.
      rchrg: "N",
      // "R" is a regular invoice. The portal's other types (SEZ with and
      // without payment, deemed export) need the flags table 6 needs.
      inv_typ: "R",
      itms: rateGroups(invoice),
    });
  }

  return [...byCtin.values()].sort((a, b) => a.ctin.localeCompare(b.ctin));
};

/** Table 5: one block per place of supply, inter-State and over the limit. */
export const b2clBlocks = (documents = []) => {
  const byPos = new Map();

  for (const invoice of documents) {
    if (tableFor(invoice) !== "B2CL") continue;
    const pos = placeOf(invoice);
    if (!byPos.has(pos)) byPos.set(pos, { pos, inv: [] });
    byPos.get(pos).inv.push({
      inum: String(num(invoice.invoiceNo)),
      idt: portalDate(invoice.date),
      val: invoiceValue(invoice),
      itms: rateGroups(invoice),
    });
  }

  return [...byPos.values()].sort((a, b) => a.pos.localeCompare(b.pos));
};

/**
 * Table 7: not invoices at all, but one row per place, supply type and rate.
 *
 * NET OF CREDIT NOTES, which is what Sigfa's own caption says -- "(Net Of
 * Debit And Credit Notes)". So an unregistered buyer's credit note is
 * subtracted here as well as appearing in table 10, and that is not double
 * counting: the portal asks for table 7 net and table 10 itemised.
 */
export const b2csRows = (documents = []) => {
  const rows = new Map();

  for (const invoice of documents) {
    const table = tableFor(invoice);
    const credit = table === "CDNUR";
    // A CDNUR against a small intra-State sale nets off table 7; one against
    // a B2CL-sized inter-State sale belongs only in table 10.
    if (table !== "B2CS" && !(credit && !(isInterState(invoice) && invoiceValue(invoice) > B2CL_THRESHOLD))) {
      continue;
    }

    const sign = credit ? -1 : 1;
    const pos = placeOf(invoice);
    const sply_ty = isInterState(invoice) ? "INTER" : "INTRA";

    for (const group of rateGroups(invoice)) {
      const d = group.itm_det;
      const key = `${sply_ty}|${pos}|${d.rt}`;
      if (!rows.has(key)) {
        rows.set(key, { sply_ty, pos, typ: "OE", rt: d.rt, txval: 0, ...ZERO_TAX });
      }
      const row = rows.get(key);
      row.txval = round2(row.txval + sign * d.txval);
      row.iamt = round2(row.iamt + sign * d.iamt);
      row.camt = round2(row.camt + sign * d.camt);
      row.samt = round2(row.samt + sign * d.samt);
      row.csamt = round2(row.csamt + sign * d.csamt);
    }
  }

  return [...rows.values()].sort(
    (a, b) => a.sply_ty.localeCompare(b.sply_ty) || a.pos.localeCompare(b.pos) || a.rt - b.rt
  );
};

/** Table 9: credit notes to registered buyers, one block per GSTIN. */
export const cdnrBlocks = (documents = []) => {
  const byCtin = new Map();

  for (const invoice of documents) {
    if (tableFor(invoice) !== "CDNR") continue;
    const ctin = text(invoice.customer?.gstin).toUpperCase();
    if (!byCtin.has(ctin)) byCtin.set(ctin, { ctin, party: text(invoice.customer?.name), nt: [] });
    byCtin.get(ctin).nt.push({
      // "C" is a credit note. A debit note would be "D", and this app raises
      // credit notes -- a sales return -- rather than debit notes.
      ntty: "C",
      nt_num: String(num(invoice.invoiceNo)),
      nt_dt: portalDate(invoice.date),
      // Pre-GST: no. Every document here is raised under GST.
      p_gst: "N",
      val: invoiceValue(invoice),
      pos: placeOf(invoice),
      itms: rateGroups(invoice),
    });
  }

  return [...byCtin.values()].sort((a, b) => a.ctin.localeCompare(b.ctin));
};

/** Table 10: credit notes to unregistered buyers, listed flat. */
export const cdnurRows = (documents = []) =>
  documents
    .filter((invoice) => tableFor(invoice) === "CDNUR")
    .map((invoice) => ({
      // B2CL where the original was over the limit and inter-State, EWPWOP/
      // EWPWP being the export cases this app cannot identify.
      typ: isInterState(invoice) && invoiceValue(invoice) > B2CL_THRESHOLD ? "B2CL" : "B2CS",
      ntty: "C",
      nt_num: String(num(invoice.invoiceNo)),
      nt_dt: portalDate(invoice.date),
      p_gst: "N",
      val: invoiceValue(invoice),
      pos: placeOf(invoice),
      itms: rateGroups(invoice),
    }));

/**
 * Table 12: one row per HSN, per rate.
 *
 * Per RATE as well as per HSN, because the portal files a rate at a time --
 * and because this app's own `hsnTotals` keeps only the first line's rate
 * for a group, a known defect recorded in lib/billingMath.mjs. Built from
 * the LINES instead, so the return is right even where the printed summary
 * on the bill is not.
 *
 * Credit notes subtract, which is what "summary of outward supplies" means.
 */
export const hsnRows = (documents = []) => {
  const rows = new Map();

  for (const invoice of documents) {
    const sign = isCreditNote(invoice) ? -1 : 1;
    const interState = isInterState(invoice);

    for (const line of invoice?.items || []) {
      const hsn = text(line?.hsn);
      const rt = num(line?.gstRate);
      const key = `${hsn}|${rt}`;
      if (!rows.has(key)) {
        rows.set(key, {
          hsn_sc: hsn,
          desc: text(line?.name),
          uqc: text(line?.uqc) || text(line?.unit),
          rt,
          qty: 0,
          val: 0,
          txval: 0,
          ...ZERO_TAX,
        });
      }
      const row = rows.get(key);
      const split = taxSplit(num(line?.gstAmount), interState);
      row.qty = round2(row.qty + sign * num(line?.quantity));
      row.txval = round2(row.txval + sign * num(line?.taxableAmount));
      row.val = round2(row.val + sign * num(line?.total));
      row.iamt = round2(row.iamt + sign * split.iamt);
      row.camt = round2(row.camt + sign * split.camt);
      row.samt = round2(row.samt + sign * split.samt);
      row.csamt = round2(row.csamt + sign * split.csamt);
    }
  }

  return [...rows.values()]
    .sort((a, b) => a.hsn_sc.localeCompare(b.hsn_sc) || a.rt - b.rt)
    .map((row, index) => ({ num: index + 1, ...row }));
};

/**
 * Table 13: the document series issued in the period.
 *
 * Invoices and credit notes are separate series on the portal (nature 1 and
 * 5), and the numbers are continuous here, so each is reported as one range
 * from its lowest to its highest. `cancel` is nothing: this app does not
 * cancel an invoice number, it alters or deletes the document, and a deleted
 * one leaves no row to count.
 */
export const DOC_NATURES = [
  { nature: 1, label: "Invoices for outward supply", credit: false },
  { nature: 5, label: "Credit note", credit: true },
];

export const docIssueRows = (documents = []) =>
  DOC_NATURES.map(({ nature, label, credit }) => {
    const numbers = documents
      .filter((invoice) => isCreditNote(invoice) === credit)
      .map((invoice) => num(invoice.invoiceNo))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    if (!numbers.length) return null;

    return {
      doc_num: nature,
      doc_typ: label,
      docs: [
        {
          num: 1,
          from: String(numbers[0]),
          to: String(numbers[numbers.length - 1]),
          totnum: numbers.length,
          cancel: 0,
          net_issue: numbers.length,
        },
      ],
    };
  }).filter(Boolean);

/* ──────────────────────────── the sheets ────────────────────────────── */

/**
 * GSTR-1, table by table, for reading on screen.
 *
 * Every one of Sigfa's ten appears. The four that cannot be built carry the
 * field they would need instead of rows.
 */
export const gstr1Sheet = ({ invoices = [], from, to } = {}) => {
  const documents = documentsIn({ invoices, side: "Sale", from, to });

  const tables = {
    B2B: b2bBlocks(documents),
    B2CL: b2clBlocks(documents),
    B2CS: b2csRows(documents),
    CDNR: cdnrBlocks(documents),
    CDNUR: cdnurRows(documents),
    HSN: hsnRows(documents),
    DOCS: docIssueRows(documents),
  };

  return {
    period: taxPeriod(from),
    documents: documents.length,
    sections: GSTR1_SECTIONS.map((section) => ({
      ...section,
      rows: section.filled ? tables[section.tag] || [] : [],
    })),
    totals: outwardTotals(documents),
  };
};

/**
 * The outward figures every summary return needs, in one place.
 *
 * Credit notes subtract, the same rule the sales book follows and for the
 * same reason: a return is a reduction of outward supply, not a supply of
 * its own.
 */
export const outwardTotals = (documents = []) => {
  let taxable = 0;
  let tax = { ...ZERO_TAX };
  let value = 0;

  for (const invoice of documents) {
    const sign = isCreditNote(invoice) ? -1 : 1;
    const groups = groupTotals(rateGroups(invoice));
    taxable = round2(taxable + sign * groups.txval);
    value = round2(value + sign * invoiceValue(invoice));
    tax = addTax(tax, {
      iamt: sign * groups.iamt,
      camt: sign * groups.camt,
      samt: sign * groups.samt,
      csamt: sign * groups.csamt,
    });
  }

  return { taxable, value, ...tax, tax: round2(tax.iamt + tax.camt + tax.samt + tax.csamt) };
};

/**
 * The same figures for the purchase side: the input credit.
 *
 * Purchase returns subtract, and the result is what GSTR-3's table 6 and
 * GSTR-3B's table 4 call eligible ITC. "Eligible" is the portal's word and
 * not a judgement made here: this app records no ineligible-credit marker,
 * so every input tax on a purchase in the period is reported.
 */
export const inwardTotals = (documents = []) => outwardTotals(documents);

/** Sigfa's GSTR-3, table by table. */
export const gstr3Sheet = ({ invoices = [], from, to } = {}) => {
  const sales = documentsIn({ invoices, side: "Sale", from, to });
  const purchases = documentsIn({ invoices, side: "Purchase", from, to });
  const outward = outwardTotals(sales);
  const inward = inwardTotals(purchases);

  const liability = round2(outward.tax);

  const figures = {
    GSTR_3_03: [
      { label: "Taxable turnover", value: outward.taxable },
      { label: "Total turnover (invoice value)", value: outward.value },
    ],
    GSTR_3_04: [
      { label: "Taxable value", value: outward.taxable },
      { label: "IGST", value: outward.iamt },
      { label: "CGST", value: outward.camt },
      { label: "SGST", value: outward.samt },
    ],
    GSTR_3_06: [
      { label: "Taxable value of inward supplies", value: inward.taxable },
      { label: "IGST", value: inward.iamt },
      { label: "CGST", value: inward.camt },
      { label: "SGST", value: inward.samt },
    ],
    GSTR_3_08: [
      { label: "Tax on outward supplies", value: liability },
      { label: "Less: input tax credit", value: round2(inward.tax) },
      { label: "Net tax payable", value: round2(liability - inward.tax) },
    ],
  };

  return {
    period: taxPeriod(from),
    documents: sales.length + purchases.length,
    sections: GSTR3_SECTIONS.map((section) => ({
      ...section,
      rows: section.filled ? figures[section.code] || [] : [],
    })),
  };
};

/** GSTR-3B, table by table, in the portal's numbering. */
export const gstr3bSheet = ({ invoices = [], from, to } = {}) => {
  const sales = documentsIn({ invoices, side: "Sale", from, to });
  const purchases = documentsIn({ invoices, side: "Purchase", from, to });
  const outward = outwardTotals(sales);
  const inward = inwardTotals(purchases);

  // Table 3.2 is a subset of 3.1(a), not an addition to it: the inter-State
  // part of what unregistered buyers were supplied.
  const unregisteredInterState = sales.filter(
    (invoice) => !isRegistered(invoice) && isInterState(invoice)
  );
  const subset = outwardTotals(unregisteredInterState);

  const figures = {
    "3.1(a)": [
      { label: "Taxable value", value: outward.taxable },
      { label: "Integrated tax", value: outward.iamt },
      { label: "Central tax", value: outward.camt },
      { label: "State/UT tax", value: outward.samt },
      { label: "Cess", value: outward.csamt },
    ],
    "3.2": [
      { label: "Place of supply (inter-State, unregistered)", value: null,
        note: `${unregisteredInterState.length} document(s)` },
      { label: "Taxable value", value: subset.taxable },
      { label: "Integrated tax", value: subset.iamt },
    ],
    4: [
      { label: "ITC available — Integrated tax", value: inward.iamt },
      { label: "ITC available — Central tax", value: inward.camt },
      { label: "ITC available — State/UT tax", value: inward.samt },
      { label: "Net ITC available", value: round2(inward.tax) },
    ],
  };

  return {
    period: taxPeriod(from),
    documents: sales.length + purchases.length,
    sections: GSTR3B_SECTIONS.map((section) => ({
      ...section,
      rows: section.filled ? figures[section.no] || [] : [],
    })),
  };
};

/* ─────────────────────────── the e-return ───────────────────────────── */

/**
 * The GSTR-1 upload, in the portal's own JSON.
 *
 * Shaped for the government's offline utility, which is also what the
 * portal's direct upload takes: `gstin`, `fp` as mmyyyy, then one key per
 * table, each omitted entirely when it has no rows. An empty array is not
 * the same as an absent key to the utility -- it reports an empty section as
 * an error rather than as nothing to file.
 *
 * The four tables this app cannot build are absent for the same reason, and
 * `missing` names them so the screen can say so before anybody uploads.
 */
export const gstr1Json = ({ company = {}, invoices = [], from, to } = {}) => {
  const documents = documentsIn({ invoices, side: "Sale", from, to });

  const b2b = b2bBlocks(documents);
  const b2cl = b2clBlocks(documents);
  const b2cs = b2csRows(documents);
  const cdnr = cdnrBlocks(documents);
  const cdnur = cdnurRows(documents);
  const hsn = hsnRows(documents);
  const docs = docIssueRows(documents);

  const payload = {
    gstin: text(company?.gstin).toUpperCase(),
    fp: taxPeriod(from),
  };

  // The party name is carried on the blocks for the screen to show; the
  // portal has no field for it, and an unknown key fails validation.
  if (b2b.length) payload.b2b = b2b.map(({ party, ...block }) => block);
  if (b2cl.length) payload.b2cl = b2cl;
  if (b2cs.length) payload.b2cs = b2cs;
  if (cdnr.length) payload.cdnr = cdnr.map(({ party, ...block }) => block);
  if (cdnur.length) payload.cdnur = cdnur;
  if (hsn.length) payload.hsn = { data: hsn };
  if (docs.length) payload.doc_issue = { doc_det: docs.map(({ doc_typ, ...det }) => det) };

  return payload;
};

/** What the e-return could not include, and the field each would need. */
export const eReturnGaps = () =>
  GSTR1_SECTIONS.filter((section) => !section.filled).map((section) => ({
    no: section.no,
    tag: section.tag,
    title: section.title,
    needs: section.needs,
  }));

/** Why this e-return cannot be filed yet, or null. */
export const eReturnProblem = ({ company = {}, from } = {}) => {
  if (!text(company?.gstin)) return "Add the firm's GSTIN to the company profile first.";
  if (!taxPeriod(from)) return "Pick a period before building the e-return.";
  return null;
};

/** The filename the upload carries. */
export const jsonFilename = (company = {}, from) =>
  `GSTR1-${text(company?.gstin).toUpperCase() || "NOGSTIN"}-${taxPeriod(from) || "period"}.json`;
