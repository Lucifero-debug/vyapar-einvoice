/**
 * Single source of truth for customer balance arithmetic.
 *
 * CONVENTION
 * ----------
 * `Customer.lastBal` is a SIGNED number:
 *    > 0  →  Dr  (party owes us / receivable)
 *    < 0  →  Cr  (we owe the party / payable)
 *
 * `Customer.lastMode` ('Dr' | 'Cr') is a denormalised cache of the sign.
 * It is never an independent input — always write it via `setBalance()` or
 * `balancePipeline()` so it cannot drift out of step with `lastBal`.
 *
 * The UI presents balances as magnitude + Dr/Cr dropdown. Translate at the
 * boundary with `toSigned()` on the way in and `toDisplay()` on the way out.
 */

/** Round to 2 dp, killing float drift (0.1 + 0.2 -> 0.3). */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Sign of a signed balance, as an accounting mode. Zero reads as 'Dr'. */
export const modeOf = (signed) => ((Number(signed) || 0) >= 0 ? "Dr" : "Cr");

/** UI magnitude + mode  ->  stored signed balance. */
export const toSigned = (magnitude, mode) => {
  const n = Math.abs(Number(magnitude) || 0);
  return round2(mode === "Cr" ? -n : n);
};

/** Stored signed balance  ->  UI magnitude + mode. */
export const toDisplay = (signed) => ({
  amount: round2(Math.abs(Number(signed) || 0)),
  mode: modeOf(signed),
});

/**
 * How one invoice moves a party's signed balance.
 *
 *   Sale            we sold to them, they owe us more   -> +amount
 *   Sale return     goods came back, they owe us less   -> -amount
 *   Purchase        we bought, we owe them more         -> -amount
 *   Purchase return we sent back, we owe them less      -> +amount
 */
export const invoiceDelta = ({ type, isReturn = false, amount = 0 }) => {
  const amt = round2(amount);
  const sign = type === "Purchase" ? -1 : 1;
  return round2(sign * (isReturn ? -amt : amt));
};

/**
 * Which way one invoice moves stock. The same four cases as `invoiceDelta`,
 * kept directly beside it on purpose: these two rules drifted apart once
 * already -- the stock side keyed off a `returnType` field no caller ever
 * sent, so BOTH return types moved stock backwards while the money side was
 * right. Sharing one table is the actual fix; reading the same
 * `{ type, isReturn }` the balance rule reads is what keeps them honest.
 *
 *   Purchase          goods arrive        -> inward
 *   Purchase return   goods go back       -> outward
 *   Sale              goods go out        -> outward
 *   Sale return       goods come back     -> inward
 */
export const isInwardStock = ({ type, isReturn = false }) =>
  (type === "Purchase") !== Boolean(isReturn);

/**
 * The second leg of an invoice: whatever was actually paid at the counter.
 *
 * The invoice itself moves the party by its FULL value; money handed over then
 * moves the party back and lands on cash. Posting only the net (`balanceDue`)
 * is what made fully-paid sales vanish from the books entirely -- no party
 * movement, no cash, no trace outside the invoice document.
 *
 *   Sale, 500 received       party -500, cash +500
 *   Purchase, 500 paid       party +500, cash -500
 *   Sale return, 500 refunded    party +500, cash -500
 *   Purchase return, 500 back    party -500, cash +500
 *
 * Note the party leg is exactly the opposite of the document leg, so
 * `invoiceDelta(full) + receiptDelta().party` still nets to
 * `invoiceDelta(balanceDue)` -- existing party balances do not shift when this
 * is switched on, only what the ledger and cash account show.
 */
export const receiptDelta = ({ type, isReturn = false, received = 0 }) => {
  const cash = invoiceDelta({ type, isReturn, amount: received });
  return { cash, party: round2(-cash) };
};

/** How one voucher line moves a party's signed balance. */
export const voucherDelta = ({ debit = 0, credit = 0 }) =>
  round2((Number(debit) || 0) - (Number(credit) || 0));

/**
 * Apply a delta to a mongoose Customer doc, keeping `lastMode` in step.
 * Caller still has to `save()`.
 */
export const applyDelta = (customer, delta) =>
  setBalance(customer, (Number(customer.lastBal) || 0) + delta);

/** Set an absolute signed balance on a doc, keeping `lastMode` in step. */
export const setBalance = (customer, signed) => {
  customer.lastBal = round2(signed);
  customer.lastMode = modeOf(customer.lastBal);
  return customer;
};

/**
 * Atomic equivalent of `applyDelta` for `findOneAndUpdate`, as an aggregation
 * pipeline so the increment and the mode refresh land in one round trip and
 * cannot interleave with a concurrent write.
 *
 * Requires MongoDB 4.2+ (pipeline updates).
 *
 *   await Customer.findOneAndUpdate({ name }, balancePipeline(delta));
 */
export const balancePipeline = (delta) => [
  {
    $set: {
      lastBal: {
        $round: [{ $add: [{ $ifNull: ["$lastBal", 0] }, round2(delta)] }, 2],
      },
    },
  },
  {
    $set: {
      lastMode: { $cond: [{ $gte: ["$lastBal", 0] }, "Dr", "Cr"] },
    },
  },
];
