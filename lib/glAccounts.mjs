/**
 * The standard ledger heads an invoice posts to, found or created.
 *
 * NOT pure, and one of the documented exceptions in lib/ -- the same
 * exception as itemLedger.mjs, runningBalances.mjs, cashAccount.mjs,
 * orderClaims.mjs and bomSave.mjs. The rules live in lib/invoiceGl.mjs, which
 * stays runnable under bare node.
 *
 * Modelled on cashAccount.mjs, and for the same reason: every account in this
 * app is a Customer doc distinguished by `group` -- exactly as Sigfa's CUSMAST
 * holds parties and ledger heads side by side -- so Sales Account and Output
 * CGST are ordinary records, not a parallel notion of an account.
 *
 * CREATED ON DEMAND rather than seeded. A firm that has never raised a bill
 * needs no Output IGST head, and making the whole posting path depend on a
 * migration having been run is how you get an install that cannot bill. The
 * group comes from GL_ACCOUNT_GROUPS, so a head created here lands in the
 * right place on the trial balance the first time without anybody choosing.
 */

import Customer from "../models/custModel";
import { GL_ACCOUNT_GROUPS } from "./invoiceGl.mjs";

/**
 * Make sure every named head exists, and answer with its stored name.
 *
 * Returns a Map of requested name -> stored name. They differ only in case or
 * padding, which matters because the ledger joins on the name: a head stored
 * as "Round off" must not be posted to as "Round Off" and split in two.
 *
 * Looked up case-insensitively through a collation, the same way
 * lib/uniqueName.mjs compares every other master name in this app.
 */
export async function resolveGlAccounts(names = [], session = null) {
  const opts = session ? { session } : {};
  const wanted = [...new Set(names.map((n) => String(n ?? "").trim()).filter(Boolean))];
  const out = new Map();
  if (!wanted.length) return out;

  const existing = await Customer.find(
    { name: { $in: wanted } },
    { name: 1 },
    opts
  )
    .collation({ locale: "en", strength: 2 })
    .lean();

  const found = new Map(existing.map((a) => [String(a.name).trim().toLowerCase(), a.name]));

  const missing = [];
  for (const name of wanted) {
    const hit = found.get(name.toLowerCase());
    if (hit) out.set(name, hit);
    else missing.push(name);
  }

  if (missing.length) {
    const created = await Customer.create(
      missing.map((name) => ({
        name,
        // The chart-of-accounts group, so the head appears under the right
        // heading on the trial balance and the statements with no further
        // step. An unlisted name would be filed nowhere, which the reports
        // show as Suspense -- correct, but not what anyone wants.
        group: GL_ACCOUNT_GROUPS[name] || "Suspense A/c",
        // A ledger head starts at nil. Its position is the sum of its rows.
        openingBal: 0,
        openingMode: "Dr",
        lastBal: 0,
        lastMode: "Dr",
      })),
      { session, ordered: true }
    );
    for (const account of created) out.set(account.name, account.name);
  }

  return out;
}

/**
 * Whether a name is one of the heads this module owns.
 *
 * For the guards: an account created by the posting path is not a party, so
 * `delete-cust` refusing to remove it for having ledger rows is right, but
 * offering it in a customer dropdown is not.
 */
export const isGlAccountName = (name) =>
  Object.prototype.hasOwnProperty.call(
    GL_ACCOUNT_GROUPS,
    String(name ?? "").trim()
  );
