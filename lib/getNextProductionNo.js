// lib/getNextProductionNo.js
import Counter from "../models/counterModel";
import Production from "../models/productionModel";

/**
 * Production entry numbering.
 *
 * Its own sequence, independent of invoices and of orders -- Sigfa numbers its
 * MFG DocNo separately from SALPUR for the same reason. `counters` is unique on
 * (companyId, name), so every firm gets its own row.
 *
 * Mirrors lib/getNextOrderNo.js, including the part that matters: the counter
 * is first nudged past the highest entry that actually exists. A fresh counter
 * otherwise starts at 1 and collides with everything already in the book --
 * which is what happens on any database restored from a backup, since the
 * documents come back and a counter that was never written does not.
 */

export const PRODUCTION_COUNTER = "productionNo";

/** Atomically reserve the next entry number. */
export const getNextProductionNo = async (session = null) => {
  const opts = session ? { session } : {};

  const highest = await Production.findOne({}, { docNo: 1 }, opts)
    .sort({ docNo: -1 })
    .lean();

  if (highest?.docNo) {
    await Counter.updateOne(
      { name: PRODUCTION_COUNTER },
      { $max: { value: Number(highest.docNo) } },
      { upsert: true, ...opts }
    );
  }

  const counter = await Counter.findOneAndUpdate(
    { name: PRODUCTION_COUNTER },
    { $inc: { value: 1 } },
    { new: true, upsert: true, ...opts }
  );

  return counter.value;
};

/** Keep the counter at or above a number that was chosen by hand. */
export const raiseProductionCounter = async (docNo, session = null) => {
  const opts = session ? { session } : {};
  await Counter.updateOne(
    { name: PRODUCTION_COUNTER },
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
export const peekNextProductionNo = async () => {
  const [last, counter] = await Promise.all([
    Production.findOne({}, { docNo: 1 }).sort({ docNo: -1 }).lean(),
    Counter.findOne({ name: PRODUCTION_COUNTER }).lean(),
  ]);
  return Math.max(Number(last?.docNo) || 0, Number(counter?.value) || 0) + 1;
};
