/**
 * The four billing screens, as data.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/billing.test.mjs directly.
 *
 *
 * WHAT THE AUDIT FOUND
 * --------------------
 * The four screens were not four screens. Measured on the files as they stood
 * before this refactor:
 *
 *     saleadd      vs  purchaseadd       8 differing lines out of 1,547
 *     salereturn   vs  purchasereturn    6 differing lines out of 1,220
 *
 * The sale and purchase pairs were byte-identical apart from four values: an
 * ORDER_DOC constant, the payload's `type`, the page title and the subtitle.
 * No different party handling, no different pricing, no different validation.
 *
 * The only real axis was the return flag, and a return screen was the add
 * screen with the whole order-billing feature deleted -- two imports, a
 * 164-line effect, 141 lines of picker modal and the button that opened it.
 *
 * So the difference between the four is this table, and nothing else. 5,534
 * lines became one component and these four entries.
 *
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 * --------------------------------
 * A `partyNoun` of "customer" or "supplier", which is the first thing anybody
 * reaches for. The old screens used the SAME party label on all four, and the
 * brief for this work was to preserve existing labels: making the purchase
 * screen say "supplier" would be an improvement smuggled in under a refactor.
 * It is a one-line change here when somebody asks for it.
 *
 * Likewise `priceField`. `resolveItemPricing` in lib/priceList.mjs used to
 * read `salePrice` unconditionally, so a purchase line started from the SALE
 * price. It now takes the screen's `type` as its side and reads
 * `purchasePrice` for a purchase (falling back to `salePrice` when the master
 * has none) -- see `masterRateFor` there. Only the rate a NEW line starts at
 * changed; saved invoices are not touched.
 */

/** Which way the document faces. The payload's `type` field. */
export const DIRECTIONS = ["Sale", "Purchase"];

/**
 * The four screens.
 *
 * `key` is what a page passes; everything else is read, never recomputed.
 * Titles and subtitles are the originals, character for character -- they are
 * the one thing a user would notice changing.
 */
export const BILLING_TYPES = {
  sale: {
    key: "sale",
    route: "/saleadd",
    type: "Sale",
    isReturn: false,
    title: "Sale Invoice",
    subtitle: "Bill a customer and record the sale.",
    // ORDER_DOC in the old file: which side's orders this screen can bill.
    orderDoc: "Sale",
  },
  purchase: {
    key: "purchase",
    route: "/purchaseadd",
    type: "Purchase",
    isReturn: false,
    title: "Purchase Invoice",
    subtitle: "Record a bill received from a supplier.",
    orderDoc: "Purchase",
  },
  salereturn: {
    key: "salereturn",
    route: "/salereturn",
    type: "Sale",
    isReturn: true,
    title: "Sale Return",
    subtitle: "Take goods back from a customer.",
    // Returns never billed from an order, and still do not. The absence of a
    // doc here is what switches the whole feature off.
    orderDoc: null,
  },
  purchasereturn: {
    key: "purchasereturn",
    route: "/purchasereturn",
    type: "Purchase",
    isReturn: true,
    title: "Purchase Return",
    subtitle: "Send goods back to a supplier.",
    orderDoc: null,
  },
};

export const BILLING_KEYS = Object.keys(BILLING_TYPES);

/**
 * One screen's configuration.
 *
 * Throws on an unknown key rather than returning a default. A typo'd key that
 * quietly fell back to "sale" would post a purchase return as a sale invoice,
 * which is two wrong signs at once -- the party balance and the stock.
 */
export const billingType = (key) => {
  const config = BILLING_TYPES[String(key ?? "").trim()];
  if (!config) {
    throw new Error(
      `Unknown billing type "${key}". Expected one of: ${BILLING_KEYS.join(", ")}.`
    );
  }
  return config;
};

/** Can this screen pull lines off a pending order? */
export const canBillFromOrder = (config) => Boolean(config?.orderDoc);

/**
 * The two fields that decide the accounting, and nothing else.
 *
 * Kept as its own function so the regression test can assert the four
 * combinations directly against the table in the brief:
 *
 *     Sale             party +   stock issue
 *     Sale return      party -   stock receipt
 *     Purchase         party -   stock receipt
 *     Purchase return  party +   stock issue
 *
 * The SIGNS ARE NOT COMPUTED HERE and must never be. The server derives them
 * from `type` and `return` through lib/invoicePosting.mjs and
 * lib/invoiceGl.mjs. This returns only the two flags the payload carries, so a
 * test can prove the screen still sends what it always sent.
 */
export const postingFlags = (config) => ({
  type: config.type,
  return: config.isReturn,
});
