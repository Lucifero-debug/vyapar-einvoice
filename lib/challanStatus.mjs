/**
 * Sales and purchase challans: the rules, with no database in here.
 *
 * Pure and dependency-light, like the rest of lib/*.mjs, so
 * `node scripts/challans.test.mjs` runs it bare. The writes are
 * app/api/challan-*\/route.js and lib/challanClaims.mjs.
 *
 *
 * WHAT SIGFA DOES, AND THEREFORE WHAT THIS DOES
 * ---------------------------------------------
 * Read out of SIGFA105.exe (PROJECT_CONTEXT.md §6.19):
 *
 *   - Two documents of their own, with their own series:
 *       Insert Into MkeyMaster(Mkey,MkeyName) Values('SC','Sales Challan')
 *       Insert Into MkeyMaster(Mkey,MkeyName) Values('PC','Purchase Challan')
 *     Printed as "SALES CHALLAN" / "PURCHASE CHALLAN", menu "Sales &Challan"
 *     and "Purchase &Challan" (Ctl+B / Ctl+E).
 *
 *   - A STOCK-EFFECT flag per challan, its `Dsale`. The stock query counts a
 *     line only where it is set:
 *       ... from Salpur1 Where Mkey in('SI','SC','SR','PI','PC','PR','IS','RS')
 *           and Dsale='Y'
 *     So a challan with stock effect moves the goods when it is saved, and
 *     the invoice later made from it does NOT move them again. One without
 *     it moves nothing, and its invoice moves the stock as any bill does.
 *     ("Stock Effect With Challan" is the setup switch that defaults it.)
 *
 *   - An invoice line names the challan line it bills (Salpur1.Challan +
 *     ChRefNo), and what is still to bill is the challan quantity less what
 *     invoices have taken:
 *       select sum(qty),cbrcode,challan,ChRefNo,Mkey,COpng from Salpur1
 *       where Mkey='SI' and Challan in(...) Group by cbrcode,challan,ChrefNo...
 *     A challan is pending while any line is unposted (`chpost=false`).
 *
 *   - "Pending Challan [ Alt + H ]" on the invoice screen pulls those lines
 *     in; "Please Select Challans With Same Effect Value !" -- one bill does
 *     not mix challans that did and did not move stock.
 *
 *   - "Can't Delete, Used In ..." / "Quantity Is Less Than Quantity Entered
 *     Against This Challan." -- a challan an invoice has drawn on cannot be
 *     deleted, nor cut below what was billed.
 *
 * A challan carries the goods' value and GST (rule 55 asks for both on a
 * delivery challan), but it POSTS NOTHING to the accounts: no ledger row, no
 * party balance. The invoice made from it does that.
 *
 * Not taken from SIGFA (yet): its Transfer Challan (branches, which this app
 * has not got), carrying pending challans into a new year, and returns
 * against a challan.
 */

import { recalcItem } from "./billingMath.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/* ───────────────────────────── the two kinds ─────────────────────────── */

export const CHALLAN_TYPES = ["Sale", "Purchase"];

/** Everything that differs between the two, in one place. */
export const CHALLAN_KINDS = {
  Sale: {
    type: "Sale",
    mkey: "SC",
    label: "Sales Challan",
    printTitle: "SALES CHALLAN",
    // The stock-ledger key prefix. Distinct from the stock vouchers'
    // PRD-/GI-/GR- (lib/stockVoucher.mjs) and from invoices, whose keys are
    // bare digits, so a challan's rows never collide with either.
    prefix: "SC-",
    voucher: "Sale Challan",
    // Goods leave on a sales challan, arrive on a purchase one.
    inward: false,
    partyRole: "customer",
    route: "/challanadd?type=Sale",
  },
  Purchase: {
    type: "Purchase",
    mkey: "PC",
    label: "Purchase Challan",
    printTitle: "PURCHASE CHALLAN",
    prefix: "PC-",
    voucher: "Purchase Challan",
    inward: true,
    partyRole: "supplier",
    route: "/challanadd?type=Purchase",
  },
};

export const isChallanType = (type) => CHALLAN_TYPES.includes(text(type));

/** The kind, or a thrown error: a typo must not post a sale as a purchase. */
export const challanKind = (type) => {
  const kind = CHALLAN_KINDS[text(type)];
  if (!kind) throw new Error(`Not a challan type: "${type}". Expected Sale or Purchase.`);
  return kind;
};

/** The stock-ledger key for one challan: "SC-12", "PC-3". */
export const challanLedgerKey = (type, challanNo) =>
  `${challanKind(type).prefix}${Math.trunc(num(challanNo))}`;

export const CHALLAN_PREFIXES = CHALLAN_TYPES.map((t) => CHALLAN_KINDS[t].prefix);
export const isChallanLedgerKey = (key) =>
  CHALLAN_PREFIXES.some((prefix) => text(key).startsWith(prefix));

/* ───────────────────────────── quantities ────────────────────────────── */

export const QTY_EPSILON = 0.0001;
export const roundQty = (value) => Math.round(num(value) * 1000) / 1000;

const trim = (value) => {
  const n = roundQty(value);
  return Number.isInteger(n) ? String(n) : String(n);
};

export const challanQty = (line) => roundQty(line?.quantity);
export const billedQty = (line) => roundQty(line?.billedQty);
/** Still to bill. Never negative; never stored -- always this subtraction. */
export const pendingQty = (line) => Math.max(0, roundQty(challanQty(line) - billedQty(line)));
export const isLineBilled = (line) => pendingQty(line) <= QTY_EPSILON;

export const CHALLAN_STATUSES = ["pending", "partial", "billed"];
export const STATUS_LABELS = { pending: "Pending", partial: "Part billed", billed: "Billed" };

/**
 * pending: nothing billed. partial: some billed, some left. billed: every
 * line posted (SIGFA's CHPOST on all of them).
 */
export const challanStatus = (challan) => {
  const lines = (challan?.items || []).filter(Boolean);
  if (!lines.length) return "pending";
  if (lines.every(isLineBilled)) return "billed";
  if (lines.some((l) => billedQty(l) > QTY_EPSILON)) return "partial";
  return "pending";
};

/** Has any invoice drawn on this challan? */
export const anyBilled = (challan) =>
  (challan?.items || []).some((l) => billedQty(l) > QTY_EPSILON);

/* ───────────────────────────── money ─────────────────────────────────── */

/**
 * One line's figures, by the SAME function every billing screen uses
 * (lib/billingMath.mjs recalcItem), so a challan line and the invoice line
 * made from it agree to the paisa.
 */
export const priceLine = (line) => {
  const priced = recalcItem({
    cost: num(line?.cost),
    quantity: num(line?.quantity),
    discount: num(line?.discount),
    gstRate: num(line?.gstRate),
  });
  const r2 = (n) => Math.round(num(n) * 100) / 100;
  return {
    cost: r2(priced.cost),
    taxableAmount: r2(priced.taxableAmount),
    gstAmount: r2(priced.gstAmount),
    total: r2(priced.total),
  };
};

export const challanTotals = (items = []) => {
  let taxable = 0;
  let gst = 0;
  let total = 0;
  for (const line of items || []) {
    const p = priceLine(line);
    taxable += p.taxableAmount;
    gst += p.gstAmount;
    total += p.total;
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return { taxable: r2(taxable), gst: r2(gst), total: r2(total) };
};

/* ───────────────────────────── stock ─────────────────────────────────── */

/**
 * The stock rows a challan writes: one per goods line, in the challan's
 * direction -- and NONE when it has no stock effect. A service line moves
 * nothing either way.
 */
export const challanStockRows = (challan) => {
  if (!challan?.stockEffect) return [];
  const kind = challanKind(challan.type);
  const rows = [];
  for (const line of challan.items || []) {
    if (!text(line?.name) || line?.isService) continue;
    const quantity = challanQty(line);
    if (quantity <= 0) continue;
    rows.push({
      itemName: text(line.name),
      receiptQuantity: kind.inward ? quantity : 0,
      issueQuantity: kind.inward ? 0 : quantity,
    });
  }
  return rows;
};

/**
 * The invoice lines that move stock themselves: every line EXCEPT one billing
 * a challan that already moved it (SIGFA's Dsale on the invoice line).
 * `challanStock` is set by the server from the challan, never trusted from
 * the screen.
 */
export const invoiceStockLines = (items = []) =>
  // A purchase M.R.I. line whose whole lot was rejected accepts nothing,
  // and moves nothing (lib/mri.mjs).
  (items || []).filter(
    (line) => !line?.challanStock && !(Number(line?.receivedQty) > 0 && Number(line?.quantity) === 0)
  );

/* ───────────────────────── invoice lines → challans ──────────────────── */

/** The challan line an invoice line bills, or null. All three parts or none. */
export const challanRef = (invoiceLine) => {
  const challanNo = Number(invoiceLine?.challanNo);
  const challanType = text(invoiceLine?.challanType);
  const lineId = text(invoiceLine?.challanLineId);
  if (!Number.isInteger(challanNo) || challanNo <= 0 || !isChallanType(challanType) || !lineId) {
    return null;
  }
  return { challanNo, challanType, lineId };
};

export const challanKey = (challanType, challanNo) => `${text(challanType)}#${Number(challanNo)}`;

/** The challans a bill draws on, as { challanNo, type } -- what the route reads. */
export const challanRefsOf = (items = []) => {
  const seen = new Map();
  for (const line of items || []) {
    const ref = challanRef(line);
    if (ref) seen.set(challanKey(ref.challanType, ref.challanNo), { challanNo: ref.challanNo, type: ref.challanType });
  }
  return [...seen.values()];
};

/** Quantities an invoice takes, grouped per challan and per challan line. */
export const claimsFromItems = (items) => {
  const groups = new Map();
  for (const item of items || []) {
    const ref = challanRef(item);
    if (!ref) continue;
    const want = roundQty(item?.quantity);
    if (want <= 0) continue;
    const key = challanKey(ref.challanType, ref.challanNo);
    if (!groups.has(key)) {
      groups.set(key, { challanNo: ref.challanNo, challanType: ref.challanType, byLine: new Map() });
    }
    const byLine = groups.get(key).byLine;
    byLine.set(ref.lineId, roundQty((byLine.get(ref.lineId) || 0) + want));
  }
  return [...groups.values()];
};

/** What an edit changes: signed differences per challan line, zeros dropped. */
export const netClaims = (beforeItems, afterItems) => {
  const signed = new Map();
  const walk = (items, sign) => {
    for (const group of claimsFromItems(items)) {
      const key = challanKey(group.challanType, group.challanNo);
      if (!signed.has(key)) {
        signed.set(key, { challanNo: group.challanNo, challanType: group.challanType, byLine: new Map() });
      }
      const byLine = signed.get(key).byLine;
      for (const [lineId, want] of group.byLine) {
        byLine.set(lineId, roundQty((byLine.get(lineId) || 0) + sign * want));
      }
    }
  };
  walk(beforeItems, -1);
  walk(afterItems, +1);
  const out = [];
  for (const group of signed.values()) {
    const byLine = new Map();
    for (const [lineId, delta] of group.byLine) {
      if (Math.abs(delta) > QTY_EPSILON) byLine.set(lineId, delta);
    }
    if (byLine.size) out.push({ ...group, byLine });
  }
  return out;
};

const lineId = (line) => text(line?._id ?? line?.id);
const label = (line) => `"${text(line?.name) || "a line"}"`;

/**
 * Apply signed billed-quantity changes to one challan's lines, or say why not.
 *
 * Billing more than the challan carried is refused -- the same guard orders
 * have. (SIGFA can be set to accept it with a warning; a bill for goods that
 * never went out on the challan is better split into its own line.)
 */
export const applyBilled = (challan, byLine) => {
  const problems = [];
  const deltas = byLine instanceof Map ? byLine : new Map(Object.entries(byLine || {}));
  const seen = new Set();
  const items = (challan?.items || []).filter(Boolean).map((line) => {
    const id = lineId(line);
    if (!deltas.has(id)) return line;
    seen.add(id);
    const delta = roundQty(deltas.get(id));
    const already = billedQty(line);
    const next = roundQty(already + delta);
    if (next < -QTY_EPSILON) {
      problems.push(`${label(line)}: cannot un-bill ${trim(-delta)} when only ${trim(already)} was billed.`);
      return line;
    }
    if (next > challanQty(line) + QTY_EPSILON) {
      problems.push(
        `${label(line)}: only ${trim(pendingQty(line))} left to bill of ${trim(challanQty(line))} on the challan.`
      );
      return line;
    }
    return { ...line, billedQty: Math.max(0, next) };
  });
  for (const id of deltas.keys()) {
    if (!seen.has(id)) {
      problems.push("A billed line no longer exists on this challan.");
      break;
    }
  }
  return { items, problems };
};

/* ───────────────────────── checks against this firm ──────────────────── */

const sameItem = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();

/**
 * What is wrong with the challan lines a bill claims to draw on. `challans`
 * is what the route's tenant-scoped find returned for `challanRefsOf`, so
 * another firm's challan is simply absent.
 */
export const challanLineProblems = (items = [], challans = [], { invoiceType, partyName } = {}) => {
  const byKey = new Map((challans || []).map((c) => [challanKey(c?.type, c?.challanNo), c]));
  const problems = [];
  const stockEffects = new Set();
  (items || []).forEach((line, index) => {
    const ref = challanRef(line);
    if (!ref) return;
    const where = `Line ${index + 1}${line?.name ? ` (${line.name})` : ""}`;
    const challan = byKey.get(challanKey(ref.challanType, ref.challanNo));
    if (!challan) {
      problems.push(`${where}: ${CHALLAN_KINDS[ref.challanType].label} ${ref.challanNo} does not exist.`);
      return;
    }
    if (invoiceType && challan.type !== invoiceType) {
      problems.push(`${where}: a ${invoiceType} bill cannot draw on a ${CHALLAN_KINDS[challan.type].label.toLowerCase()}.`);
    }
    if (partyName && !sameItem(challan.customer?.name, partyName)) {
      problems.push(`${where}: ${CHALLAN_KINDS[challan.type].label} ${challan.challanNo} is for "${text(challan.customer?.name)}", not this party.`);
    }
    const challanLine = (challan.items || []).find((l) => lineId(l) === ref.lineId);
    if (!challanLine) {
      problems.push(`${where}: that line is not on ${CHALLAN_KINDS[challan.type].label} ${challan.challanNo}.`);
    } else if (!sameItem(challanLine.name, line.name)) {
      problems.push(`${where}: ${CHALLAN_KINDS[challan.type].label} ${challan.challanNo} carried "${challanLine.name}" on that line, not "${line.name}".`);
    }
    stockEffects.add(Boolean(challan.stockEffect));
  });
  if (stockEffects.size > 1) {
    // SIGFA: "Please Select Challans With Same Effect Value !"
    problems.push(
      "One bill cannot mix challans that moved stock with challans that did not. Bill them separately."
    );
  }
  return problems;
};

/**
 * Stamp each challan-billing line with whether its challan already moved the
 * stock, FROM THE CHALLAN. Whatever the screen sent for it is replaced.
 */
export const stampChallanStock = (items = [], challans = []) => {
  const byKey = new Map((challans || []).map((c) => [challanKey(c?.type, c?.challanNo), c]));
  return (items || []).map((line) => {
    const ref = challanRef(line);
    const { challanStock: _ignored, ...rest } = line || {};
    if (!ref) return rest;
    const challan = byKey.get(challanKey(ref.challanType, ref.challanNo));
    return { ...rest, challanStock: Boolean(challan?.stockEffect) };
  });
};

/* ───────────────────────── editing and deleting ──────────────────────── */

/**
 * Why a challan cannot be deleted, or null. SIGFA: "Can't Delete, Used In ..."
 */
export const deleteBlockedReason = (challan) => {
  if (!anyBilled(challan)) return null;
  const kind = CHALLAN_KINDS[challan.type] || CHALLAN_KINDS.Sale;
  return `${kind.label} ${challan.challanNo} has already been billed. Delete or alter those invoices first.`;
};

/**
 * Why this edit is refused, or null. A line an invoice has drawn on must
 * stay, keep its item, and not fall below what was billed (SIGFA: "Quantity
 * Is Less Than Quantity Entered Against This Challan."). The party and the
 * stock effect are fixed once anything is billed: the invoices already rest
 * on both.
 */
export const editBlockedReason = (previous, next) => {
  if (!anyBilled(previous)) return null;
  if (!sameItem(previous.customer?.name, next.customer?.name)) {
    return "The party cannot change once part of this challan has been billed.";
  }
  if (Boolean(previous.stockEffect) !== Boolean(next.stockEffect)) {
    return "The stock effect cannot change once part of this challan has been billed.";
  }
  const nextById = new Map((next.items || []).map((l) => [lineId(l), l]));
  for (const line of previous.items || []) {
    const billed = billedQty(line);
    if (billed <= QTY_EPSILON) continue;
    const after = nextById.get(lineId(line));
    if (!after) return `${label(line)} has been billed (${trim(billed)}) and cannot be removed.`;
    if (!sameItem(after.name, line.name)) return `${label(line)} has been billed and cannot be changed to another item.`;
    if (challanQty(after) + QTY_EPSILON < billed) {
      return `${label(line)}: the quantity cannot go below the ${trim(billed)} already billed against this challan.`;
    }
  }
  return null;
};

/**
 * The lines of an edited challan, keeping each surviving line's id and the
 * quantity already billed on it -- never the screen's figure for that.
 */
export const carryBilled = (previousItems = [], nextItems = []) => {
  const before = new Map((previousItems || []).map((l) => [lineId(l), l]));
  const used = new Set();
  return (nextItems || []).map((line) => {
    const id = lineId(line);
    const old = id && !used.has(id) ? before.get(id) : null;
    if (old) {
      used.add(id);
      return { ...line, billedQty: billedQty(old) };
    }
    // An id this challan never had (or one already used above) is not kept:
    // the line is new, and gets a fresh id and nothing billed.
    const { _id: _dropped, id: _alsoDropped, ...fresh } = line;
    return { ...fresh, billedQty: 0 };
  });
};

/* ───────────────────────────── to an invoice ─────────────────────────── */

/**
 * A challan's pending lines, as invoice lines carrying their challan
 * reference -- what "Pending Challan [Alt+H]" puts on the bill.
 */
export const toInvoiceLines = (challan) =>
  (challan?.items || [])
    .filter((line) => pendingQty(line) > QTY_EPSILON)
    .map((line) => {
      const quantity = pendingQty(line);
      const priced = priceLine({ ...line, quantity });
      return {
        name: text(line.name),
        description: text(line.description),
        hsn: text(line.hsn),
        quantity,
        cost: num(line.cost),
        discount: num(line.discount),
        gstRate: num(line.gstRate),
        taxableAmount: priced.taxableAmount,
        gstAmount: priced.gstAmount,
        total: priced.total,
        uqc: line.uqc,
        challanNo: Number(challan.challanNo),
        challanType: challan.type,
        challanLineId: lineId(line),
        challanDate: challan.date,
        // For the screen only; the server sets the real one from the challan.
        challanStock: Boolean(challan.stockEffect),
      };
    });

/** The challans a printed invoice draws on, for "Challan No." on the bill. */
export const printableChallanRefs = (invoice) => {
  const seen = new Map();
  for (const line of invoice?.items || []) {
    const ref = challanRef(line);
    if (!ref) continue;
    const key = challanKey(ref.challanType, ref.challanNo);
    if (!seen.has(key)) seen.set(key, { challanNo: ref.challanNo, date: line.challanDate || null });
  }
  return [...seen.values()].sort((a, b) => a.challanNo - b.challanNo);
};

/* ───────────────────────── the billing screen's picker ───────────────── */

/**
 * The lines to put on a bill from what the person ticked in "Pending
 * Challan": `challans` as /api/challan-pending returns them (each with
 * invoice-ready `lines`), `picks` as { "<type>#<no>:<lineId>": quantity }.
 *
 * A quantity above what is pending is refused, not clamped -- silently
 * billing less than was typed is how a clerk believes they billed 500 when
 * the bill says 300. Challans that did and did not move stock cannot be
 * mixed (SIGFA: "Please Select Challans With Same Effect Value !").
 * `items` is the item master, for the unit and service flag; `recalc` is the
 * screen's recalcItem.
 */
export const pickKey = (challan, line) =>
  `${challanKey(challan?.type, challan?.challanNo)}:${text(line?.challanLineId)}`;

export const pickFromChallans = ({ challans = [], picks = {}, items = [], recalc } = {}) => {
  const masters = new Map((items || []).filter(Boolean).map((i) => [text(i.name).toLowerCase(), i]));
  const lines = [];
  const problems = [];
  const effects = new Set();
  const parties = new Set();
  const used = [];

  for (const challan of challans || []) {
    let took = false;
    for (const line of challan?.lines || []) {
      const raw = picks[pickKey(challan, line)];
      if (raw === undefined || raw === null || raw === "") continue;
      const want = roundQty(raw);
      if (!(want > 0)) continue;
      if (want > roundQty(line.quantity) + QTY_EPSILON) {
        problems.push(
          `${CHALLAN_KINDS[challan.type]?.label || "Challan"} ${challan.challanNo}, "${line.name}": only ${trim(line.quantity)} is pending, so ${trim(want)} cannot be billed.`
        );
        continue;
      }
      const master = masters.get(text(line.name).toLowerCase());
      // The master's fields, less its own id -- that is the ITEM's id, not
      // this bill line's.
      // And less its prices: the challan's own rate is the rate, and
      // recalcItem would otherwise read a zero rate as "use the sale price".
      const { _id: _masterId, salePrice: _sp, purchasePrice: _pp, mrp: _mrp, ...masterFields } = master || {};
      const merged = {
        ...masterFields,
        ...line,
        quantity: want,
        // What the CHALLAN said, kept beside what is being billed.
        //
        // `line.quantity` here is what is still pending on that challan line,
        // which is the supplier's figure for this receipt. The override above
        // replaces it with the quantity being drawn, so without this the
        // challan's own number is gone the moment the line is merged -- and a
        // purchase M.R.I. could then tell you what failed inspection but
        // never what never turned up (lib/mri.mjs, shortQty).
        challanQty: roundQty(line.quantity),
        uqc: master?.uqc || line.uqc,
        isService: master ? Boolean(master.isService) : false,
      };
      const priced = typeof recalc === "function" ? recalc(merged) : merged;
      lines.push({ ...priced, cost: Number(line.cost) || 0 });
      took = true;
    }
    if (took) {
      effects.add(Boolean(challan.stockEffect));
      parties.add(text(challan.customer?.name).toLowerCase());
      used.push({
        challanNo: challan.challanNo,
        type: challan.type,
        stockEffect: Boolean(challan.stockEffect),
        party: text(challan.customer?.name),
      });
    }
  }

  if (parties.size > 1) {
    problems.push("Those challans are for different parties. One bill is for one party.");
  }

  if (effects.size > 1) {
    problems.push("Challans that moved stock and challans that did not cannot go on one bill. Pick one kind.");
  }
  return { lines: problems.length ? [] : lines, problems: problems.slice(0, 3), used };
};
