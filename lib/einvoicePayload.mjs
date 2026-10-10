/**
 * The INV-01 payload — turning one of our invoices into what the IRP accepts.
 *
 * PURE. No network, no Mongoose, no clock of its own. Everything it needs is
 * passed in, which is the only way this is testable at all, and roughly all of
 * the difficulty in e-invoicing lives in exactly this file.
 *
 *     const { payload, problems } = buildEinvoicePayload({ invoice, company });
 *     if (problems.length) return problems;   // never send it
 *
 * WHAT THE IRP REFUSES, and therefore what this has to get right
 *
 *   - Totals must reconcile. `TotInvVal` has to equal the lines plus other
 *     charges plus the rounding adjustment, and each line's `TotItemVal` has
 *     to equal its taxable value plus its taxes. Both within a rupee.
 *   - A line never carries both IGST and CGST/SGST.
 *   - `Pin` is a number, `Stcd` is a string that keeps its leading zero.
 *   - The date is `dd/mm/yyyy`, in IST, never ISO.
 *   - A future-dated invoice is rejected outright.
 *
 * It returns problems rather than throwing, and never a half-built payload: a
 * filing is not something to attempt and see.
 */

import { round2 } from "./balance.mjs";
import { splitGst } from "./gst.mjs";
import { irpMissing } from "./company.mjs";
import { buyerMissing, isB2B } from "./buyerSnapshot.mjs";
import { UQC_DEFAULT, isServcFlag, normalizeUqc } from "./uqc.mjs";
import { editBlockedReason } from "./einvoiceLock.mjs";
import { formatIrpDate, istDayNumber } from "./istDate.mjs";

/** The schema version these shapes are built against. */
export const INV01_VERSION = "1.1";

/** The widest the IRP's totals check will go before it rejects the filing. */
export const RECONCILE_TOLERANCE = 1;

const num = (value) => {
  // `freight` is a String in the schema, and party taxes arrive as strings
  // from the form, so every figure goes through here.
  const n = Number(String(value ?? "").trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/* ------------------------------------------------------------------ lines -- */

/**
 * One item line, with its taxes split the same way the printed bill splits
 * them -- `splitGst()`, so the e-invoice and the paper invoice agree to the
 * paisa rather than to the rupee.
 */
export const buildLine = (item, index, { taxType }) => {
  const qty = num(item?.quantity);
  const unitPrice = round2(num(item?.cost));
  const gstRate = num(item?.gstRate ?? item?.gst);

  const totAmt = round2(unitPrice * qty);
  // `discount` is a PERCENTAGE everywhere in this project -- the billing form
  // computes the money from it the same way.
  const discount = round2((totAmt * num(item?.discount)) / 100);
  const assAmt = round2(totAmt - discount);

  const tax = round2((assAmt * gstRate) / 100);
  const local = taxType !== "central";
  const { cgst, sgst } = local ? splitGst(tax) : { cgst: 0, sgst: 0 };
  const igst = local ? 0 : tax;

  return {
    SlNo: String(index + 1),
    IsServc: isServcFlag(item),
    HsnCd: text(item?.hsn),
    Qty: qty,
    Unit: normalizeUqc(item?.uqc) || UQC_DEFAULT,
    UnitPrice: unitPrice,
    TotAmt: totAmt,
    Discount: discount,
    AssAmt: assAmt,
    GstRt: gstRate,
    CgstAmt: cgst,
    SgstAmt: sgst,
    IgstAmt: igst,
    TotItemVal: round2(assAmt + cgst + sgst + igst),
  };
};

/** Freight and the party-tax overheads, which the IRP calls other charges. */
export const otherCharges = (invoice) => {
  const taxes = (invoice?.partyTaxes || []).reduce(
    (sum, row) => sum + num(row?.total ?? row?.Amount ?? row?.amount),
    0
  );
  return round2(num(invoice?.freight) + taxes);
};

/* --------------------------------------------------------------- problems -- */

const DOC_NO = /^[A-Z0-9/-]{1,16}$/;

/**
 * Everything that would make this filing fail, or make it wrong to attempt.
 *
 * `now` is a parameter so "is this future-dated" is testable without waiting.
 */
export const payloadProblems = ({ invoice, company, now = Date.now() } = {}) => {
  const problems = [];
  const add = (message) => problems.push(message);

  if (!invoice) return ["There is no invoice to report."];

  /* --- is this even a document the IRP wants --- */

  const type = text(invoice.type).toLowerCase();
  if (type !== "sale") {
    add("Only sales are reported to the IRP. A purchase bill is the supplier's filing, not yours.");
  }

  const blocked = editBlockedReason(invoice, now);
  if (blocked) add(blocked);

  const buyer = invoice.customer || {};
  if (!isB2B(buyer)) {
    add(
      `${buyer.name || "This buyer"} has no GSTIN on record, so this is a B2C sale. ` +
        "B2C invoices are not reported."
    );
  } else {
    const missing = buyerMissing(buyer);
    if (missing.length) add(`The buyer's ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`);
  }

  /* --- is our own side complete --- */

  const sellerMissing = irpMissing(company);
  if (sellerMissing.length) {
    add(`Your firm's ${sellerMissing.join(", ")} must be filled in on the business profile first.`);
  }

  /* --- the document's own details --- */

  const docNo = text(invoice.invoiceNo);
  if (!docNo) add("The invoice has no number.");
  else if (!DOC_NO.test(docNo.toUpperCase())) {
    add(`Invoice number "${docNo}" is not one the IRP accepts: up to 16 of A-Z, 0-9, / and - only.`);
  } else if (/^[0/-]/.test(docNo)) {
    add(`An invoice number cannot start with "${docNo[0]}".`);
  }

  const day = istDayNumber(invoice.date);
  if (day === null) add("The invoice has no usable date.");
  else if (day > istDayNumber(now)) add("The invoice is dated in the future, which the IRP refuses.");

  /* --- the lines --- */

  const items = invoice.items || [];
  if (!items.length) add("The invoice has no items.");
  items.forEach((item, i) => {
    if (!text(item?.hsn)) add(`Line ${i + 1} (${item?.name || "unnamed"}) has no HSN code.`);
    if (num(item?.quantity) <= 0) add(`Line ${i + 1} (${item?.name || "unnamed"}) has no quantity.`);
  });

  /* --- and does it add up --- */

  const totals = reconcile({ invoice, items });
  if (Math.abs(totals.remainder) > RECONCILE_TOLERANCE) {
    add(
      `The invoice does not add up: the lines and charges come to ` +
        `${totals.lineTotal.toFixed(2)} but the invoice total is ` +
        `${totals.invoiceTotal.toFixed(2)}.`
    );
  }

  return problems;
};

/**
 * What the lines come to, against what the invoice says it comes to.
 *
 * The difference is the rounding adjustment -- a paisa or two on a normal
 * bill, and a sign that something is wrong when it is more.
 */
export const reconcile = ({ invoice, items }) => {
  const lines = (items || invoice?.items || []).map((item, i) =>
    buildLine(item, i, { taxType: invoice?.taxType })
  );

  const sum = (pick) => round2(lines.reduce((total, line) => total + pick(line), 0));

  const assVal = sum((l) => l.AssAmt);
  const cgstVal = sum((l) => l.CgstAmt);
  const sgstVal = sum((l) => l.SgstAmt);
  const igstVal = sum((l) => l.IgstAmt);
  const othChrg = otherCharges(invoice);

  const lineTotal = round2(sum((l) => l.TotItemVal) + othChrg);
  const invoiceTotal = round2(num(invoice?.finalAmount));

  return {
    lines,
    assVal,
    cgstVal,
    sgstVal,
    igstVal,
    othChrg,
    lineTotal,
    invoiceTotal,
    // Positive when the invoice asks for more than the lines come to.
    remainder: round2(invoiceTotal - lineTotal),
  };
};

/* ---------------------------------------------------------------- payload -- */

const sellerBlock = (company) => ({
  Gstin: text(company?.gstin).toUpperCase(),
  LglNm: text(company?.name),
  Addr1: text(company?.address),
  Loc: text(company?.city),
  Pin: num(company?.pincode),
  Stcd: text(company?.stateCode),
});

const buyerBlock = (buyer) => ({
  Gstin: text(buyer?.gstin).toUpperCase(),
  LglNm: text(buyer?.name),
  // The place of supply. The buyer's own state for a normal supply; a bill
  // delivered elsewhere would need this to follow the delivery, which is a
  // case this app does not record yet, so it is the buyer's state.
  Pos: text(buyer?.stateCode),
  Addr1: text(buyer?.address),
  Loc: text(buyer?.city),
  Pin: num(buyer?.pincode),
  Stcd: text(buyer?.stateCode),
});

/**
 * Build the payload, or say why not.
 *
 * Always returns both keys. `payload` is null whenever there are problems --
 * there is no such thing as a payload that is nearly right.
 */
export const buildEinvoicePayload = ({ invoice, company, now = Date.now() } = {}) => {
  const problems = payloadProblems({ invoice, company, now });
  if (problems.length) return { payload: null, problems };

  const totals = reconcile({ invoice });

  const payload = {
    Version: INV01_VERSION,
    TranDtls: {
      TaxSch: "GST",
      SupTyp: "B2B",
      RegRev: "N",
      IgstOnIntra: "N",
    },
    DocDtls: {
      // A sale return is a credit note as far as the IRP is concerned.
      Typ: invoice.return ? "CRN" : "INV",
      No: text(invoice.invoiceNo).toUpperCase(),
      Dt: formatIrpDate(invoice.date),
    },
    SellerDtls: sellerBlock(company),
    BuyerDtls: buyerBlock(invoice.customer),
    ItemList: totals.lines,
    ValDtls: {
      AssVal: totals.assVal,
      CgstVal: totals.cgstVal,
      SgstVal: totals.sgstVal,
      IgstVal: totals.igstVal,
      OthChrg: totals.othChrg,
      // The remainder, so the totals reconcile exactly. It is only ever the
      // paisa the shop rounded off; `payloadProblems` has already refused
      // anything bigger than a rupee.
      RndOffAmt: totals.remainder,
      TotInvVal: totals.invoiceTotal,
    },
  };

  return { payload, problems: [] };
};
