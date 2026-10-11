// lib/getNextProductionNo.js
import Counter from "../models/counterModel";
import Production from "../models/productionModel";
import { DEFAULT_KIND, kindOf, stockKind } from "./stockVoucher.mjs";

/**
 * Stock-voucher numbering: Production, Goods Issued, Goods Received.
 *
 * ONE SERIES PER KIND, each with its own counter row -- "productionNo",
 * "goodsIssueNo", "goodsReceiptNo". Sigfa numbers its DocNo per MKEY for the
 * same reason: a shop's goods issues are their own book, and interleaving
 * them with production numbers so the register reads 1, 4, 9 is the kind of
 * thing that gets reported as missing documents.
 *
 * `counters` is unique on (companyId, name), so every firm gets its own row
 * of each.
 *
 * Mirrors lib/getNextOrderNo.js, including the part that matters: the counter
 * is first nudged past the highest entry that actually exists. A fresh counter
 * otherwise starts at 1 and collides with everything already in the book --
 * which is what happens on any database restored from a backup, since the
 * documents come back and a counter that was never written does not.
 *
 * The highest existing entry is looked for WITHIN THE KIND, which is the part
 * that would be easy to miss: taking the highest of all three would make a
 * firm's first goods issue number 48 because it has 47 production entries.
 */

/** The counter row this kind draws from. */
export const counterFor = (kind) => stockKind(kind).counter;

/** Kept for the callers that predate the other two kinds. */
export const PRODUCTION_COUNTER = counterFor(DEFAULT_KIND);

/**
 * Entries of one kind, including the rows written before `kind` existed.
 *
 * An absent kind is Production (lib/stockVoucher.mjs), so a query for 'FR'
 * has to match rows where the field is missing as well -- otherwise the first
 * production entry after this upgrade takes a number already in the book.
 */
const kindFilter = (kind) => {
  const code = kindOf(kind);
  return code === DEFAULT_KIND
    ? { $or: [{ kind: DEFAULT_KIND }, { kind: { $exists: false } }, { kind: null }] }
    : { kind: code };
};

/** Atomically reserve the next entry number for this kind. */
export const getNextProductionNo = async (session = null, kind = DEFAULT_KIND) => {
  const opts = session ? { session } : {};
  const name = counterFor(kind);

  const highest = await Production.findOne(kindFilter(kind), { docNo: 1 }, opts)
    .sort({ docNo: -1 })
    .lean();

  if (highest?.docNo) {
    await Counter.updateOne(
      { name },
      { $max: { value: Number(highest.docNo) } },
      { upsert: true, ...opts }
    );
  }

  const counter = await Counter.findOneAndUpdate(
    { name },
    { $inc: { value: 1 } },
    { new: true, upsert: true, ...opts }
  );

  return counter.value;
};

/** Keep a kind's counter at or above a number that was chosen by hand. */
export const raiseProductionCounter = async (docNo, session = null, kind = DEFAULT_KIND) => {
  const opts = session ? { session } : {};
  await Counter.updateOne(
    { name: counterFor(kind) },
    { $max: { value: Number(docNo) } },
    { upsert: true, ...opts }
  );
};

/**
 * What the next number will probably be, without reserving it.
 *
 * A peek, like the invoice and order ones: opening the form and walking away
 * should not burn a number and leave a gap in the register.
 */
export const peekNextProductionNo = async (kind = DEFAULT_KIND) => {
  const [last, counter] = await Promise.all([
    Production.findOne(kindFilter(kind), { docNo: 1 }).sort({ docNo: -1 }).lean(),
    Counter.findOne({ name: counterFor(kind) }).lean(),
  ]);
  return Math.max(Number(last?.docNo) || 0, Number(counter?.value) || 0) + 1;
};
