/**
 * Stamp `kind: "FR"` onto the stock vouchers written before kinds existed.
 *
 *     node scripts/backfill-stock-kind.mjs                 # report only -- reads, changes nothing
 *     node scripts/backfill-stock-kind.mjs --apply         # back up, then stamp
 *     node scripts/backfill-stock-kind.mjs --apply --yes   # without the typed confirmation
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
 * WHICH ROWS
 * ----------
 * Only rows whose `kind` is absent, null or "". A row that already carries a
 * kind -- 'FR', 'IS' or 'RS' -- is never touched, so a rerun changes nothing
 * and a goods issue can never be relabelled a production entry.
 *
 * BEFORE IT STAMPS
 * ----------------
 * It checks, per firm, that no docNo would then be held by two production
 * entries (an unstamped row and an 'FR' row, or two unstamped rows). If one
 * would, the (companyId, kind, docNo) index could not be built over the
 * result, so it stops and names the rows by _id. Nothing is deleted or
 * renumbered automatically.
 *
 * BACKUP AND ROLLBACK
 * -------------------
 * The _ids it stamps (with their firm and docNo) are written to
 * backups/stock-kind-<timestamp>.json first. Undo:
 *     db.productions.updateMany({ _id: { $in: [<ids>] } }, { $unset: { kind: "" } })
 * `updatedAt` is not touched: the rows' history stays as it was.
 *
 * Run it BEFORE `npm run sync:indexes -- --apply`, which builds the
 * (companyId, kind, docNo) index and retires the old (companyId, docNo) one.
 */

import mongoose from "mongoose";
import {
  connectMaintenance,
  confirmYes,
  flags,
  loadEnv,
  quietMongoose,
  writeBackup,
} from "./_shared.mjs";
import { DEFAULT_KIND } from "../lib/stockVoucher.mjs";
import { kindCollisions, MISSING_KIND } from "../lib/stockKindBackfill.mjs";

// Before any model is compiled: this script uses the raw collection only, so
// no schema can build or change an index while it looks.
quietMongoose(mongoose);

const { apply, yes } = flags();

const main = async () => {
  loadEnv();
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
    process.exitCode = 1;
    return;
  }

  await connectMaintenance(mongoose, process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(`\ndatabase : ${mongoose.connection.name}`);
  console.log(`mode     : ${apply ? "APPLY -- rows will be stamped" : "report only -- nothing is changed"}\n`);

  // Across every firm, through the raw driver: a schema migration, not a
  // request, so no tenant scope -- and no model, so nothing is built.
  const productions = db.collection("productions");
  const exists = (await db.listCollections({ name: "productions" }).toArray()).length > 0;
  if (!exists) {
    console.log("No productions collection. Nothing to do.");
    return;
  }

  const targets = await productions
    .find(MISSING_KIND, { projection: { _id: 1, companyId: 1, docNo: 1, date: 1 } })
    .toArray();

  if (!targets.length) {
    console.log("Nothing to do: every stock voucher already carries a kind.");
    return;
  }

  const byFirm = new Map();
  for (const t of targets) {
    const firm = String(t.companyId ?? "(no firm)");
    byFirm.set(firm, (byFirm.get(firm) || 0) + 1);
  }
  console.log(`${targets.length} stock voucher(s) carry no kind. All of them predate`);
  console.log(`Goods Issued and Goods Received, so all of them are '${DEFAULT_KIND}'.\n`);
  for (const [firm, n] of byFirm) console.log(`  firm ${firm}: ${n}`);
  console.log("");

  // Would (companyId, 'FR', docNo) be unique once they are stamped?
  const existingFr = await productions
    .find({ kind: DEFAULT_KIND }, { projection: { _id: 1, companyId: 1, docNo: 1 } })
    .toArray();
  const collisions = kindCollisions({ unstamped: targets, stamped: existingFr });
  if (collisions.length) {
    console.log(`BLOCKED -- ${collisions.length} production number(s) would be held twice in one firm:\n`);
    for (const c of collisions.slice(0, 50)) {
      console.log(`  firm ${c.companyId}  docNo ${c.docNo}  _id ${c.ids.join(", ")}`);
    }
    if (collisions.length > 50) console.log(`  ... and ${collisions.length - 50} more`);
    console.log("\nNothing was stamped. Renumber all but one of each pair through the app,");
    console.log("then re-run. Nothing is deleted automatically.\n");
    process.exitCode = 1;
    return;
  }

  const noFirm = targets.filter((t) => t.companyId === undefined || t.companyId === null).length;
  if (noFirm) {
    console.log(`WARNING: ${noFirm} of them carry no companyId -- invisible to the app.`);
    console.log("They are stamped too, but belong to no firm until adopted.\n");
  }

  if (!apply) {
    console.log("Report only. Re-run with --apply to stamp them (after a database backup).\n");
    return;
  }

  const backupPath = writeBackup("stock-kind", {
    database: mongoose.connection.name,
    setTo: DEFAULT_KIND,
    rows: targets.map((t) => ({ _id: String(t._id), companyId: String(t.companyId ?? ""), docNo: t.docNo })),
  });
  console.log(`Backup written to ${backupPath}`);

  if (!(await confirmYes(`\nStamp ${targets.length} row(s) with kind '${DEFAULT_KIND}'? Type yes: `, yes))) {
    console.log("Nothing was changed.\n");
    return;
  }

  // By _id, AND still unstamped: a row that gained a kind since it was read
  // (somebody edited it) is not overwritten.
  const result = await productions.updateMany(
    { _id: { $in: targets.map((t) => t._id) }, ...MISSING_KIND },
    { $set: { kind: DEFAULT_KIND } }
  );
  console.log(`\nStamped ${result.modifiedCount} of ${targets.length}.`);

  const left = await productions.countDocuments(MISSING_KIND);
  console.log(left ? `${left} still unstamped (written since the read?) -- re-run.` : "None left.");
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
