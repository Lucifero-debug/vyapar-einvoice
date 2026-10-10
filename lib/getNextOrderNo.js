// lib/getNextOrderNo.js
import Counter from '../models/counterModel';
import Order from '../models/orderModel';
import { isOrderType } from './orderStatus.mjs';

/**
 * Order numbering, one sequence per document.
 *
 * Sales orders and purchase orders number independently -- Sigfa keys theirs
 * on MKEY + DocNo for the same reason -- so the counter is named per type.
 * `counters` is unique on (companyId, name), so "orderNo:Sale" and
 * "orderNo:Purchase" are two rows and each firm has its own pair.
 *
 * Mirrors lib/getNextInvoiceNo.js, including the part that matters: the
 * counter is first nudged past the highest order that actually exists, or a
 * fresh counter starts at 1 and collides with everything already in the book.
 */

export const counterName = (type) => `orderNo:${String(type || '').trim()}`;

/** Atomically reserve the next order number for one document type. */
export const getNextOrderNo = async (type, session = null) => {
  if (!isOrderType(type)) throw new Error(`Not an order type: ${type}`);
  const opts = session ? { session } : {};
  const name = counterName(type);

  const highest = await Order.findOne({ type }, { orderNo: 1 }, opts)
    .sort({ orderNo: -1 })
    .lean();

  if (highest?.orderNo) {
    await Counter.updateOne(
      { name },
      { $max: { value: Number(highest.orderNo) } },
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

/** Keep the counter at or above a number that was chosen by hand. */
export const raiseOrderCounter = async (type, orderNo, session = null) => {
  if (!isOrderType(type)) return;
  const opts = session ? { session } : {};
  await Counter.updateOne(
    { name: counterName(type) },
    { $max: { value: Number(orderNo) } },
    { upsert: true, ...opts }
  );
};

/**
 * What the next number will probably be, without reserving it.
 *
 * Deliberately a peek, like the invoice one: opening the form and walking
 * away should not burn a number and leave a gap in the order book.
 */
export const peekNextOrderNo = async (type) => {
  if (!isOrderType(type)) return 1;
  const [last, counter] = await Promise.all([
    Order.findOne({ type }, { orderNo: 1 }).sort({ orderNo: -1 }).lean(),
    Counter.findOne({ name: counterName(type) }).lean(),
  ]);
  return Math.max(Number(last?.orderNo) || 0, Number(counter?.value) || 0) + 1;
};
