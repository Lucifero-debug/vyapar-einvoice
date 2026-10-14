// lib/getNextChallanNo.js
import Counter from '../models/counterModel';
import Challan from '../models/challanModel';
import { isChallanType } from './challanStatus.mjs';

/**
 * Challan numbering: one series per kind, as SIGFA keys SC and PC separately.
 * Mirrors lib/getNextOrderNo.js, including nudging the counter past the
 * highest challan that already exists.
 */

export const counterName = (type) => `challanNo:${String(type || '').trim()}`;

/** Atomically reserve the next challan number for one kind. */
export const getNextChallanNo = async (type, session = null) => {
  if (!isChallanType(type)) throw new Error(`Not a challan type: ${type}`);
  const opts = session ? { session } : {};
  const name = counterName(type);

  const highest = await Challan.findOne({ type }, { challanNo: 1 }, opts)
    .sort({ challanNo: -1 })
    .lean();
  if (highest?.challanNo) {
    await Counter.updateOne(
      { name },
      { $max: { value: Number(highest.challanNo) } },
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
export const raiseChallanCounter = async (type, challanNo, session = null) => {
  if (!isChallanType(type)) return;
  const opts = session ? { session } : {};
  await Counter.updateOne(
    { name: counterName(type) },
    { $max: { value: Number(challanNo) } },
    { upsert: true, ...opts }
  );
};

/** The next number, without reserving it -- opening the form burns nothing. */
export const peekNextChallanNo = async (type) => {
  if (!isChallanType(type)) return 1;
  const last = await Challan.findOne({ type }, { challanNo: 1 }).sort({ challanNo: -1 }).lean();
  const counter = await Counter.findOne({ name: counterName(type) }).lean();
  return Math.max(Number(last?.challanNo) || 0, Number(counter?.value) || 0) + 1;
};
