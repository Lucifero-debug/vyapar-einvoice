// lib/getNextInvoiceNo.js
import Counter from '../models/counterModel';
import Invoice from '../models/invoiceModel';

/**
 * Atomically reserve the next invoice number.
 *
 * Pass the active session when called inside a transaction, so a rollback also
 * releases the number instead of burning it.
 *
 * The counter is first nudged past the highest invoice that actually exists.
 * Without that, a fresh counter starts at 1 and collides with every invoice
 * already in the book — and numbers set by hand on the form (or by a
 * renumbering edit) would otherwise leave the counter behind reality.
 */
export const getNextInvoiceNo = async (session = null) => {
  const opts = session ? { session } : {};

  const highest = await Invoice.findOne({}, { invoiceNo: 1 }, opts)
    .sort({ invoiceNo: -1 })
    .lean();

  if (highest?.invoiceNo) {
    await Counter.updateOne(
      { name: 'invoiceNo' },
      { $max: { value: Number(highest.invoiceNo) } },
      { upsert: true, ...opts }
    );
  }

  const counter = await Counter.findOneAndUpdate(
    { name: 'invoiceNo' },
    { $inc: { value: 1 } },
    { new: true, upsert: true, ...opts }
  );

  return counter.value;
};

/** Keep the counter at or above a number that was chosen by hand. */
export const raiseInvoiceCounter = async (invoiceNo, session = null) => {
  const opts = session ? { session } : {};
  await Counter.updateOne(
    { name: 'invoiceNo' },
    { $max: { value: Number(invoiceNo) } },
    { upsert: true, ...opts }
  );
};
