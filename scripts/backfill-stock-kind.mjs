/**
 * Stamp `kind: "FR"` onto the stock vouchers written before kinds existed.
 *
 *     node scripts/backfill-stock-kind.mjs            # say what would change
 *     node scripts/backfill-stock-kind.mjs --apply    # change it
 *
 *
 * WHY IT HAS TO RUN
 * -----------------
 * Every entry in `productions` written before Goods Issued and Goods Received
 * were added is a production entry, and carries no `kind` at all.
 * lib/stockVoucher.mjs reads an absent kind as 'FR', so the application is
 * correct without this -- the register lists them, the ledger finds their
 * rows, alter and delete work.
 *
 * The UNIQUE INDEX is what needs them stamped. It is now
 * (companyId, kind, docNo), and to Mongo a missing field is a distinct value
 * from "FR". So an old entry numbered 5 with no kind and a NEW production
 * entry numbered 5 with kind "FR" are different keys, and the index would
 * allow both -- two production entries sharing a number, each writing stock
 * rows under "PRD-5", the second silently deleting the first's.
 *
 * The counter guards against reaching that number again (getNextProductionNo
 * nudges itself past the highest existing entry, counting the unstamped rows
 * as Production), so this is a belt rather than a brace. It still has to run
 * before anybody edits an old entry by hand-typing its number.
 *
 * Run it alongside `npm run sync:indexes`.
 */

import mongoose from "mongoose";
import { connect } from "../lib/mongodb.js";
import Production from "../models/productionModel.js";
import { runAcrossAllTenants } from "../lib/tenantContext.mjs";
import { DEFAULT_KIND } from "../lib/stockVoucher.mjs";

const apply = process.argv.includes("--apply");

const main = async () => {
  await connect();

  // Across every firm: this is a schema migration, not a request, so it is
  // one of the few places the tenant scope is deliberately stood down.
  await runAcrossAllTenants(async () => {
    const missing = { $or: [{ kind: { $exists: false } }, { kind: null }, { kind: "" }] };
    const count = await Production.countDocuments(missing);

    if (!count) {
      console.log("Nothing to do: every stock voucher already carries a kind.");
      return;
    }

    console.log(`${count} stock voucher(s) carry no kind. All of them predate`);
    console.log(`Goods Issued and Goods Received, so all of them are '${DEFAULT_KIND}'.`);

    if (!apply) {
      console.log("\nDry run. Re-run with --apply to stamp them.");
      return;
    }

    const result = await Production.updateMany(missing, { $set: { kind: DEFAULT_KIND } });
    console.log(`\nStamped ${result.modifiedCount} of ${count}.`);

    const left = await Production.countDocuments(missing);
    console.log(left ? `${left} still unstamped -- investigate.` : "None left.");
  });
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
