/**
 * Purchase M.R.I. -- SIGFA's material receipt note on the purchase side.
 *
 * Pure: `node scripts/mri.test.mjs` runs it bare. The Mongoose half is
 * lib/mriSave.mjs.
 *
 *
 * WHAT SIGFA DOES, AND WHAT THIS COPIES
 * -------------------------------------
 * Read out of SIGFA105.exe. An MRI is not a document of its own: it is a
 * Purchase Invoice or a Purchase Challan flagged as one (SALPUR.Subkey = 'MI',
 * its menus "Purchase Invoice & MRI" / "Purchase Challan & MRI"), with its own
 * number series (MRINo, "MRI Series") and a remark ("MRI Remark"). Each line
 * carries the quantity RECEIVED beside the quantity ACCEPTED, and the
 * difference is the REJECTED quantity:
 *
 *     "Accepted Qty. Is More Than Received Qty. !"
 *
 * Only the accepted quantity is the purchase: SIGFA finds an MRI with
 * rejected material by `RCQty > Qty`, so Qty -- the quantity the bill is
 * priced on and the stock moves by -- is the ACCEPTED one. That is what this
 * app does too: `quantity` on the line stays what it always was (billed,
 * stocked, taxed), and `receivedQty` is stored beside it. Nothing about the
 * posting changes, which is the point -- an MRI adds an inspection record, it
 * does not add a second way to move money or stock.
 *
 * Rejected material that comes back is taken in on a RE-MRI ("Re-MRI No",
 * Subkey 'RMI') raised AGAINST the earlier MRI ("Ag. MRI No."). SIGFA's
 * "List Of Pending MRI [ Alt + H ]" is every MRI with rejected material that
 * no Re-MRI has been raised against yet:
 *
 *     ... Subkey='MI' and RCQty>Qty and MRINO not in
 *         (Select AgMRINo from Salpur where ... AgmriNo<>'')
 *
 * which is `pendingMris` below, rule for rule. The reports are its "Rejected
 * Material Register" and "Party Wise Rejected Material".
 *
 * NOT COPIED: SIGFA can pass a Debit Note for (bill amount - accepted
 * purchase). This app has no debit note voucher yet, and the bill here is
 * priced on the accepted quantity already, so there is no difference left to
 * post. When debit notes exist, the rejected value is `rejectedValue`.
 */

const text = (value) => String(value ?? "").trim();
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const QTY_EPSILON = 0.0001;
export const roundQty = (value) => Math.round(num(value) * 1000) / 1000;
const round2 = (value) => Math.round(num(value) * 100) / 100;

export const MRI_LABEL = "M.R.I.";
export const MRI_COUNTER = "mriNo";
export const MAX_MRI_NO = 1e9;
export const MRI_REMARK_MAX = 300;

/** Where an MRI can be raised: a purchase bill (not a return) or a purchase challan. */
export const MRI_SOURCES = {
  invoice: { label: "Purchase bill", short: "Bill" },
  challan: { label: "Purchase challan", short: "Challan" },
};

/** Only the purchase side takes goods in for inspection. */
export const isMriSide = ({ type, isReturn = false } = {}) => text(type) === "Purchase" && !isReturn;

/* ───────────────────────────── one line ──────────────────────────────── */

/**
 * THREE QUANTITIES, AND ONLY TWO OF THEM ARE SIGFA'S.
 *
 * `challanQty` is this app's own addition and is marked as such: nothing read
 * out of SIGFA105.exe mentions it, and the header above quotes what that
 * binary does say. It is here because an inspection against two figures can
 * only tell you what failed, never what never turned up:
 *
 *   challanQty   what the supplier's challan said it was sending
 *   receivedQty  what actually arrived    -> SHORT    = challan - received
 *   quantity     what passed inspection   -> REJECTED = received - accepted
 *
 * Short and rejected are different arguments with a supplier -- one is a
 * delivery that never came, the other is goods sent back -- and a bill priced
 * on the accepted quantity settles neither on its own.
 *
 * Blank when the bill was not drawn from a challan, and then nothing is
 * claimed: `shortQty` is nought rather than reading the absence as a
 * shortfall of everything.
 */
export const challanOf = (line) =>
  isBlank(line?.challanQty) ? 0 : roundQty(line.challanQty);

/** What the challan promised and did not arrive. Never negative. */
export const shortQty = (line) => {
  const promised = challanOf(line);
  // No challan figure, no claim. An absent challan quantity is "not drawn
  // from a challan", not "nothing was sent".
  if (!(promised > 0)) return 0;
  const short = roundQty(promised - receivedOf(line));
  return short > QTY_EPSILON ? short : 0;
};

/**
 * Did MORE arrive than the challan said?
 *
 * Reported rather than refused. It happens -- a supplier sends a replacement
 * in the same lot -- and a receipt that silently capped the received figure
 * at the challan's would hide goods the firm is now holding.
 */
export const excessQty = (line) => {
  const promised = challanOf(line);
  if (!(promised > 0)) return 0;
  const over = roundQty(receivedOf(line) - promised);
  return over > QTY_EPSILON ? over : 0;
};

/** What came in. A line with no received figure received what it accepted. */
export const receivedOf = (line) =>
  isBlank(line?.receivedQty) ? roundQty(line?.quantity) : roundQty(line.receivedQty);

/** What was turned away: received less accepted, never negative. */
export const rejectedQty = (line) => {
  const r = roundQty(receivedOf(line) - roundQty(line?.quantity));
  return r > QTY_EPSILON ? r : 0;
};

/**
 * The rejected quantity at the line's own net rate -- rate less discount,
 * before GST, the way `taxableAmount` is worked. What a debit note would be
 * raised for.
 */
export const rejectedValue = (line) => {
  const rate = num(line?.cost) * (1 - num(line?.discount) / 100);
  return round2(rejectedQty(line) * rate);
};

/**
 * A line's received quantity, checked against its accepted one.
 *
 * Returns `{ value }` -- the received quantity to store -- or `{ error }`.
 * `mriOn` is whether the document is an MRI at all: a received figure on an
 * ordinary bill is refused rather than silently kept, because it would show
 * in no register and mean nothing.
 *
 * On an MRI a blank received quantity means "received what was accepted",
 * and is stored as that, so every MRI line has both figures.
 */
export const checkReceived = (raw, accepted, { mriOn, label = "This line" } = {}) => {
  const given = raw?.receivedQty;
  if (!mriOn) {
    if (!isBlank(given) && num(given) !== 0) {
      return { error: `${label}: a received quantity is only kept on an M.R.I.` };
    }
    return { value: undefined };
  }
  if (isBlank(given)) {
    if (!(accepted > 0)) return { error: `${label}: enter the quantity received.` };
    return { value: roundQty(accepted) };
  }
  if (typeof given !== "number" && typeof given !== "string") {
    return { error: `${label}: the received quantity must be a number.` };
  }
  const value = Number(typeof given === "string" ? given.trim() : given);
  if (!Number.isFinite(value) || value < 0) {
    return { error: `${label}: the received quantity must be a number, not below zero.` };
  }
  if (value > 1e9) return { error: `${label}: the received quantity is too large.` };
  // SIGFA's own words.
  if (roundQty(accepted) - roundQty(value) > QTY_EPSILON) {
    return { error: `${label}: Accepted Qty. Is More Than Received Qty.` };
  }
  if (!(value > 0)) return { error: `${label}: nothing was received.` };
  return { value: roundQty(value) };
};

/**
 * May this line's accepted quantity be zero? Only on an MRI, and only when
 * something was received -- a lot rejected outright is still a line of the
 * MRI, with nothing billed and nothing stocked.
 */
export const zeroAcceptedAllowed = (raw, { mriOn } = {}) =>
  Boolean(mriOn) && !isBlank(raw?.receivedQty) && num(raw.receivedQty) > 0;

/* ──────────────────────────── the header ─────────────────────────────── */

/**
 * The MRI block a request carries: `{ on, remark, againstMriNo }`, or nothing.
 *
 * Returns `{ mri }` -- with `on: false` when it is not an MRI -- or
 * `{ error }`. The MRI NUMBER is never taken from a request: the server
 * reserves it (lib/mriSave.mjs), and an edit keeps the one already stored.
 */
export const parseMriHeader = (raw, side = {}) => {
  const off = { on: false, remark: "", againstMriNo: null };
  if (isBlank(raw) || raw === false) return { mri: off };
  if (!isPlainObject(raw)) return { error: "The M.R.I. details are not valid." };

  for (const key of Object.keys(raw)) {
    if (!["on", "remark", "againstMriNo"].includes(key)) {
      return { error: `"${key}" is not an M.R.I. field.` };
    }
  }
  if (raw.on !== undefined && typeof raw.on !== "boolean") {
    return { error: "M.R.I. must be on or off." };
  }
  if (raw.on !== true) return { mri: off };

  if (!isMriSide(side)) {
    return { error: "Only a purchase bill or a purchase challan can be an M.R.I." };
  }

  let remark = "";
  if (!isBlank(raw.remark)) {
    if (typeof raw.remark !== "string") return { error: "The M.R.I. remark must be text." };
    remark = raw.remark.trim();
    if (remark.length > MRI_REMARK_MAX) {
      return { error: `The M.R.I. remark is too long (at most ${MRI_REMARK_MAX} characters).` };
    }
  }

  let againstMriNo = null;
  if (!isBlank(raw.againstMriNo) && Number(raw.againstMriNo) !== 0) {
    const n = Number(raw.againstMriNo);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MRI_NO) {
      return { error: "Ag. MRI No. must be an M.R.I. number." };
    }
    againstMriNo = n;
  }

  return { mri: { on: true, remark, againstMriNo } };
};

/* ─────────────────────────── one document ────────────────────────────── */

/** Received, accepted and rejected over a document's lines. */
export const mriTotals = (items = []) => {
  let received = 0;
  let accepted = 0;
  let rejected = 0;
  let value = 0;
  for (const line of items || []) {
    received += receivedOf(line);
    accepted += roundQty(line?.quantity);
    rejected += rejectedQty(line);
    value += rejectedValue(line);
  }
  return {
    received: roundQty(received),
    accepted: roundQty(accepted),
    rejected: roundQty(rejected),
    rejectedValue: round2(value),
  };
};

/** Does this MRI turn anything away? */
export const hasRejection = (doc) => (doc?.items || []).some((line) => rejectedQty(line) > 0);

/** Is this document an MRI? It has an MRI number. */
export const isMri = (doc) => Number(doc?.mriNo) > 0;

/**
 * Whether a document may be raised against an earlier MRI (a Re-MRI).
 *
 *   target    the MRI named in "Ag. MRI No.", or null when there is none
 *   party     this document's supplier, as stored
 *   self      this document's own MRI number, when it already has one
 *   claimedBy a document (other than this one) already raised against the
 *             target, or null
 *
 * Returns a sentence, or null when it is allowed.
 */
export const againstMriProblem = ({ againstMriNo, target, party, self, claimedBy } = {}) => {
  if (!againstMriNo) return null;
  if (!target) return `M.R.I. ${againstMriNo} was not found.`;
  if (self && Number(self) === Number(againstMriNo)) return "An M.R.I. cannot be raised against itself.";
  if (text(target.customer?.name).toLowerCase() !== text(party).toLowerCase()) {
    return `M.R.I. ${againstMriNo} is from ${text(target.customer?.name) || "another party"}, not ${text(party)}.`;
  }
  if (!hasRejection(target)) return `M.R.I. ${againstMriNo} rejected nothing, so there is nothing to re-inspect.`;
  if (claimedBy) {
    return `A Re-M.R.I. is already raised against M.R.I. ${againstMriNo} (${describeMri(claimedBy)}).`;
  }
  return null;
};

/** An MRI named in words: "M.R.I. 4 -- Purchase bill 23". */
export const describeMri = (doc) => {
  const source = MRI_SOURCES[doc?.source] || MRI_SOURCES[doc?.challanNo ? "challan" : "invoice"];
  const number = doc?.source === "challan" || doc?.challanNo ? doc?.challanNo : doc?.invoiceNo;
  const head = isMri(doc) ? `${MRI_LABEL} ${doc.mriNo} -- ` : "";
  return `${head}${source.label} ${number ?? ""}`.trim();
};

/**
 * Why an MRI may not stop being one, or be deleted: a Re-MRI points at it.
 * Returns a sentence or null.
 */
export const referencedReason = (doc, reMri) =>
  reMri
    ? `Can't change it, used in Re-M.R.I.: ${describeMri(reMri)} is raised against ${MRI_LABEL} ${doc?.mriNo}. Alter or delete that first.`
    : null;

/* ────────────────────────────── registers ────────────────────────────── */

/**
 * One row per MRI. `docs` are invoices and challans that carry an `mriNo`,
 * each tagged with `source: "invoice" | "challan"`.
 *
 * `status`:
 *   clear     nothing rejected
 *   pending   rejected material, and no Re-MRI against it yet
 *   re-mri    rejected material, and a Re-MRI has been raised
 */
export const mriRegister = (docs = []) => {
  const reMriFor = new Map();
  for (const d of docs) {
    if (Number(d?.againstMriNo) > 0) reMriFor.set(Number(d.againstMriNo), d);
  }
  return docs
    .filter(isMri)
    .map((d) => {
      const totals = mriTotals(d.items);
      const re = reMriFor.get(Number(d.mriNo)) || null;
      const status = totals.rejected > 0 ? (re ? "re-mri" : "pending") : "clear";
      return {
        mriNo: Number(d.mriNo),
        date: d.date || null,
        source: d.source,
        documentNo: d.source === "challan" ? d.challanNo : d.invoiceNo,
        documentLabel: MRI_SOURCES[d.source]?.label || "",
        party: text(d.customer?.name),
        partyBillNo: text(d.partyBillNo || d.partyChallanNo),
        remark: text(d.mriRemark),
        againstMriNo: Number(d.againstMriNo) || null,
        ...totals,
        status,
        reMriNo: re ? Number(re.mriNo) || null : null,
      };
    })
    .sort((a, b) => b.mriNo - a.mriNo);
};

/** SIGFA's "List Of Pending MRI": rejected material with no Re-MRI yet. */
export const pendingMris = (docs = []) => mriRegister(docs).filter((r) => r.status === "pending");

export const MRI_STATUS_LABELS = {
  clear: "Nothing rejected",
  pending: "Rejection pending",
  "re-mri": "Re-M.R.I. raised",
};

/** The Rejected Material Register: one row per rejected line. */
export const rejectedMaterial = (docs = []) => {
  const status = new Map(mriRegister(docs).map((r) => [r.mriNo, r.status]));
  const rows = [];
  for (const d of docs) {
    if (!isMri(d)) continue;
    for (const line of d.items || []) {
      const rejected = rejectedQty(line);
      if (!(rejected > 0)) continue;
      rows.push({
        mriNo: Number(d.mriNo),
        date: d.date || null,
        source: d.source,
        documentNo: d.source === "challan" ? d.challanNo : d.invoiceNo,
        party: text(d.customer?.name),
        item: text(line.name),
        unit: text(line.uqc),
        received: receivedOf(line),
        accepted: roundQty(line.quantity),
        rejected,
        rate: round2(num(line.cost) * (1 - num(line.discount) / 100)),
        value: rejectedValue(line),
        status: status.get(Number(d.mriNo)) || "pending",
      });
    }
  }
  return rows.sort((a, b) => b.mriNo - a.mriNo || a.item.localeCompare(b.item));
};

/** Party Wise Rejected Material: the register summed per supplier and item. */
export const partyWiseRejected = (rows = []) => {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.party.toLowerCase()}\u0000${r.item.toLowerCase()}`;
    const cur = byKey.get(key) || {
      party: r.party,
      item: r.item,
      received: 0,
      rejected: 0,
      value: 0,
      mris: 0,
      pending: 0,
    };
    cur.received = roundQty(cur.received + r.received);
    cur.rejected = roundQty(cur.rejected + r.rejected);
    cur.value = round2(cur.value + r.value);
    cur.mris += 1;
    if (r.status === "pending") cur.pending += 1;
    byKey.set(key, cur);
  }
  return [...byKey.values()].sort(
    (a, b) => a.party.localeCompare(b.party) || b.value - a.value || a.item.localeCompare(b.item)
  );
};

export const MRI_VIEWS = ["register", "pending", "rejected", "party"];
export const MRI_VIEW_LABELS = {
  register: "M.R.I. register",
  pending: "Pending M.R.I.",
  rejected: "Rejected material",
  party: "Party wise rejected",
};
export const isMriView = (v) => MRI_VIEWS.includes(text(v));
