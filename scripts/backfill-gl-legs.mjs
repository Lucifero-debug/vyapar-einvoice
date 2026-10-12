/**
 * Add the missing contra rows to invoices already in the books.
 *
 * WHY
 * ---
 * An invoice posted the party's side and, when something was settled at the
 * counter, both sides of the receipt. It named "Sales Account" in the contra
 * column of the party's row as TEXT and wrote no row owned by that account,
 * and nothing at all for GST. The ledger was therefore a party-and-cash
 * subledger: every per-account report it served was right, and a trial balance
 * drawn from it was short by exactly sales plus tax.
 *
 * `lib/invoiceGl.mjs` now supplies that side and the billing routes post it,
 * so invoices raised from here on are complete. What is left is history. An
 * un-backfilled book balances only from the changeover date, and a period
 * spanning it fails to balance with nothing on the sheet to say why -- which
 * is the one outcome worse than no trial balance at all.
 *
 * WHAT IT WRITES
 * --------------
 *   ledgers    the contra rows -- Sales or Purchase, the GST heads, the
 *              round-off -- each carrying the invoice's `voucherId` and
 *              `companyId`, so `delete-invoice` and `sale-alter` find and
 *              reverse them exactly as they do for a freshly posted invoice,
 *              plus `backfillRun`, so one run's rows can be found again
 *   customers  the ledger heads themselves, created in a firm that lacks
 *              them, and their `lastBal` / `lastMode` moved by the new rows
 *
 * EVERY WRITE IS PER FIRM. Heads are found by (companyId, name), never by
 * name alone: every firm has its own "Sales Account". (The first version of
 * this script found heads by name across the database, created them with no
 * companyId, and applied the whole database's movement to whichever firm's
 * head came back first.)
 *
 * ONE INVOICE, ONE TRANSACTION. Its rows and its heads' balance movements
 * commit together, and the transaction first re-checks that the invoice has
 * no contra rows -- so a crash part-way, or a second copy running at the
 * same time, can never leave rows without their balance movement or post an
 * invoice twice. A rerun skips everything already posted. Needs a replica set
 * (Atlas is one); the script refuses --apply on a standalone server.
 *
 * Afterwards it rewrites the running `balance` on every row of the heads it
 * touched (in each firm), and checks each head's `lastBal` against its rows.
 *
 * WHAT IT LEAVES ALONE
 * --------------------
 * The invoice documents, the party rows, the receipt rows, party balances,
 * stock. Nothing about the party's position changes: the contra side is the
 * other half of an entry whose first half was already right.
 *
 *   node scripts/backfill-gl-legs.mjs                 # report only -- reads, changes nothing
 *   node scripts/backfill-gl-legs.mjs --apply         # back up, then write
 *   node scripts/backfill-gl-legs.mjs --apply --yes   # without the typed confirmation
 *
 * Run it with billing paused: an invoice altered while it runs is re-checked
 * inside its transaction, but the report you approved was taken before.
 *
 * ROLLBACK: see MIGRATIONS.md -- delete `ledgers` rows with this run's
 * `backfillRun`, then restore each head's `lastBal`/`lastMode` from the
 * backup (or re-derive them from their rows).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import {
  connectMaintenance,
  confirmYes,
  flags,
  loadEnv,
  money,
  pad,
  padL,
  quietMongoose,
  transactionSupport,
  writeBackup,
} from "./_shared.mjs";
import { GL_ACCOUNTS, GL_ACCOUNT_GROUPS } from "../lib/invoiceGl.mjs";
import { balancePipeline } from "../lib/balance.mjs";
// The planning is pure and lives in lib/, so it can be exercised against
// fixtures under bare node. See the note atop that file.
import {
  headDrift,
  matchHeads,
  netMoves,
  netMovesByFirm,
  planBackfill,
  isPosted,
  postedHeads,
  runningBalances,
} from "../lib/glBackfill.mjs";

quietMongoose(mongoose);

const { apply: APPLY, yes: ASSUME_YES } = flags();
const COLLATION = { locale: "en", strength: 2 };
// Groups that hold customers and suppliers, not ledger heads.
const PARTY_GROUP = /sundry|debtor|creditor|customer|supplier/i;

/* ------------------------------------------------------------------ run --- */

async function main() {
  loadEnv();
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
    process.exit(1);
  }

  await connectMaintenance(mongoose, process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const invoices = db.collection("invoices");
  const ledgers = db.collection("ledgers");
  const customers = db.collection("customers");

  const tx = await transactionSupport(db);
  console.log(`\nConnected to ${mongoose.connection.name} (${tx.kind})`);
  console.log(`Mode: ${APPLY ? "APPLY -- rows will be written" : "report only -- nothing is changed"}\n`);

  // EVERY FIRM, through the raw driver: a migration runs outside the tenant
  // context. Each write below is keyed on the firm the invoice belongs to.
  const allInvoices = await invoices.find({}).toArray();
  const ids = allInvoices.map((i) => i._id);

  const existingRows = await ledgers
    .find({ voucherId: { $in: ids } }, { projection: { voucherId: 1, customerName: 1, debit: 1, credit: 1 } })
    .toArray();

  const rowsByInvoice = new Map();
  for (const row of existingRows) {
    const key = String(row.voucherId);
    if (!rowsByInvoice.has(key)) rowsByInvoice.set(key, []);
    rowsByInvoice.get(key).push(row);
  }

  const { plan, skipped, material, counts } = planBackfill({ allInvoices, rowsByInvoice });

  console.log(`invoices                : ${counts.invoices}`);
  console.log(`already posted          : ${counts.alreadyComplete}`);
  console.log(`nothing to post         : ${counts.noContraNeeded}`);
  console.log(`no firm (not posted)    : ${counts.noFirm}`);
  console.log(`to back-fill            : ${counts.toPost}`);
  console.log(`rows to write           : ${counts.rowsToWrite}\n`);

  const partial = skipped.filter((s) => s.partial);
  if (partial.length) {
    console.log(`PARTLY POSTED -- ${partial.length} invoice(s), skipped and worth a look:`);
    for (const s of partial.slice(0, 20)) console.log(`  #${s.invoiceNo}  ${s.reason}`);
    if (partial.length > 20) console.log(`  ... and ${partial.length - 20} more`);
    console.log();
  }

  if (material.length) {
    console.log(`ROUNDING OVER A RUPEE -- ${material.length} invoice(s). These post to Round Off,`);
    console.log(`which balances them, but the gap is freight or a bad figure, not rounding:\n`);
    console.log(`  ${pad("Invoice", 10)}${pad("Party", 24)}${padL("Final", 12)}${padL("Taxable", 12)}${padL("Tax", 10)}${padL("Gap", 10)}`);
    for (const m of material.slice(0, 25)) {
      console.log(
        `  ${pad("#" + m.invoiceNo, 10)}${pad(m.party, 24)}${padL(money(m.finalAmount), 12)}${padL(money(m.taxable), 12)}${padL(money(m.tax), 10)}${padL(money(m.difference), 10)}`
      );
    }
    if (material.length > 25) console.log(`  ... and ${material.length - 25} more`);
    console.log();
  }

  // ---- the heads, firm by firm --------------------------------------------
  const firmMoves = netMovesByFirm(plan);
  const firms = [...new Set([...firmMoves.values()].map((m) => String(m.companyId)))];
  const firmIdOf = new Map(plan.map((p) => [String(p.companyId), p.companyId]));

  const headsByFirm = new Map(); // firm -> { names, missing }
  const clashes = [];
  const misfiled = [];
  const drifting = [];
  for (const firm of firms) {
    const companyId = firmIdOf.get(firm);
    const heads = await customers
      .find(
        { companyId, name: { $in: GL_ACCOUNTS } },
        { projection: { name: 1, group: 1, openingBal: 1, lastBal: 1, lastMode: 1 }, collation: COLLATION }
      )
      .toArray();
    const match = matchHeads(heads, GL_ACCOUNTS);
    headsByFirm.set(firm, { ...match, heads });
    for (const c of match.clashes) clashes.push({ firm, names: c });

    // A "head" found by name that is really a party: a customer called
    // "Output CGST" would receive the tax. The app resolves heads the same
    // way (lib/glAccounts.mjs), so this is reported, and a party group stops
    // the run.
    for (const [account, storedName] of match.names) {
      const head = heads.find((h) => h.name === storedName);
      const expected = GL_ACCOUNT_GROUPS[account];
      if (head && expected && String(head.group || "") !== expected) {
        misfiled.push({ firm, name: storedName, group: head.group || "(none)", expected, party: PARTY_GROUP.test(String(head.group || "")) });
      }
    }

    // A head that already disagrees with its own rows is reported, not fixed:
    // the backfill moves it by exactly its new rows, so the drift carries over.
    for (const head of heads) {
      const rows = await ledgers
        .find({ companyId, customerName: head.name }, { projection: { debit: 1, credit: 1 } })
        .toArray();
      const drift = headDrift(head, rows);
      if (drift !== 0) drifting.push({ firm, name: head.name, drift });
    }
  }

  if (firmMoves.size) {
    console.log("head movements, per firm:\n");
    for (const m of [...firmMoves.values()].sort((a, b) =>
      `${a.companyId}${a.account}`.localeCompare(`${b.companyId}${b.account}`)
    )) {
      const stored = headsByFirm.get(String(m.companyId))?.names.get(m.account);
      const label = stored ? stored : `${m.account} (new head)`;
      console.log(
        `  firm ${String(m.companyId).slice(-6)}  ${pad(label, 26)}${padL(money(m.delta), 14)}  (${GL_ACCOUNT_GROUPS[m.account] || "?"})`
      );
    }
    console.log();
  }

  if (drifting.length) {
    console.log("HEADS WHOSE BALANCE ALREADY DISAGREES WITH THEIR ROWS (not changed here):\n");
    for (const d of drifting) console.log(`  firm ${d.firm.slice(-6)}  ${pad(d.name, 24)} off by ${money(d.drift)}`);
    console.log();
  }

  if (misfiled.length) {
    console.log("HEADS FILED UNDER ANOTHER GROUP:\n");
    for (const m of misfiled) {
      console.log(`  firm ${m.firm.slice(-6)}  ${pad(m.name, 24)} group "${m.group}" (expected "${m.expected}")${m.party ? "  <-- a PARTY group" : ""}`);
    }
    console.log();
  }

  const partyHeads = misfiled.filter((m) => m.party);
  if (partyHeads.length) {
    console.log("BLOCKED -- a ledger head name is held by a party account in the firm(s) above.");
    console.log("Posting tax or sales to a customer or supplier is not something to guess");
    console.log("at. Rename the party (or move the head to its proper group) first.");
    console.log("Nothing was written.\n");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (clashes.length) {
    console.log("BLOCKED -- two heads in one firm whose names differ only in case:\n");
    for (const c of clashes) console.log(`  firm ${c.firm}: ${c.names.join(" / ")}`);
    console.log("\nWhich one an invoice should post to cannot be decided here. Merge or");
    console.log("rename them first. Nothing was written.\n");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!APPLY) {
    console.log("Report only. Re-run with --apply to write (after a database backup).\n");
    // For the record: the database-wide totals, as the report used to show.
    if (netMoves(plan).size && firms.length > 1) console.log(`(${firms.length} firms in this database.)\n`);
    await mongoose.disconnect();
    return;
  }

  if (!plan.length) {
    // Nothing left to post -- but a run that stopped part-way may have left
    // its heads' running figures unwritten. Finish them.
    console.log("Nothing left to post.\n");
    const finished = await settleHeads({ customers, ledgers, firms: await firmsWithBackfill(ledgers), drifting });
    await mongoose.disconnect();
    if (finished) process.exitCode = 1;
    return;
  }

  if (!tx.ok) {
    console.error(`Refusing to write: this ${tx.kind} cannot run transactions, and without`);
    console.error("them a failure part-way would leave rows without their balance movement.");
    console.error("The app itself needs a replica set too (lib/withTransaction.mjs).\n");
    await mongoose.disconnect();
    process.exit(1);
  }

  const runId = `gl-legs-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const backup = writeBackup("gl-legs", {
    runId,
    database: mongoose.connection.name,
    counts,
    material,
    invoices: plan.map((p) => ({
      _id: String(p._id),
      companyId: String(p.companyId),
      invoiceNo: p.invoiceNo,
      rows: p.rows.length,
    })),
    headsBefore: [...headsByFirm].flatMap(([firm, h]) =>
      h.heads.map((head) => ({
        companyId: firm,
        _id: String(head._id),
        name: head.name,
        lastBal: head.lastBal ?? null,
        lastMode: head.lastMode ?? null,
      }))
    ),
    headsToCreate: [...headsByFirm].flatMap(([firm, h]) =>
      h.missing
        .filter((account) => firmMoves.has(`${firm}|${account}`))
        .map((name) => ({ companyId: firm, name }))
    ),
  });
  console.log(`Backup written to ${backup}  (run ${runId})`);

  if (!(await confirmYes(`\nWrite ${counts.rowsToWrite} rows across ${firms.length} firm(s)? Type "yes": `, ASSUME_YES))) {
    console.log("Nothing was changed.\n");
    await mongoose.disconnect();
    return;
  }

  // 1. Heads a firm does not have yet, created IN that firm. Found again by
  //    (companyId, name) first, so a rerun creates nothing twice.
  for (const firm of firms) {
    const companyId = firmIdOf.get(firm);
    const h = headsByFirm.get(firm);
    for (const account of h.missing) {
      if (!firmMoves.has(`${firm}|${account}`)) continue;
      const found = await customers.findOne({ companyId, name: account }, { collation: COLLATION });
      if (found) {
        h.names.set(account, found.name);
        continue;
      }
      await customers.insertOne({
        companyId,
        name: account,
        group: GL_ACCOUNT_GROUPS[account] || "Suspense A/c",
        openingBal: 0,
        openingMode: "Dr",
        lastBal: 0,
        lastMode: "Dr",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      h.names.set(account, account);
      console.log(`  head created   firm ${firm.slice(-6)}  ${account}`);
    }
  }

  // 2. One invoice, one transaction: its rows and its heads' movement.
  let written = 0;
  let posted = 0;
  let raced = 0;
  const touched = new Map(); // firm -> Set(stored head name)
  for (const entry of plan) {
    const firm = String(entry.companyId);
    const names = headsByFirm.get(firm).names;
    const stored = (account) => names.get(account) || account;

    // The callback can be retried by the driver on a transient error, so it
    // only records what it did; the tallies are taken once it has committed.
    let outcome = null;
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        outcome = null;
        // Re-checked inside the transaction: posted since the read, or by a
        // second copy of this script, means skip -- never post twice.
        const now = await ledgers
          .find({ voucherId: entry._id }, { projection: { customerName: 1 }, session })
          .toArray();
        const already = postedHeads(now);
        if (entry.moves.some((m) => isPosted(already, stored(m.account)) || isPosted(already, m.account))) {
          outcome = "raced";
          return;
        }

        await ledgers.insertMany(
          entry.rows.map((row) => ({
            ...row,
            customerName: stored(row.customerName),
            companyId: entry.companyId,
            backfillRun: runId,
          })),
          { ordered: true, session }
        );
        for (const move of entry.moves) {
          const result = await customers.updateOne(
            { companyId: entry.companyId, name: stored(move.account) },
            balancePipeline(move.delta),
            { session }
          );
          if (result.matchedCount !== 1) {
            throw new Error(`head "${stored(move.account)}" not found in firm ${firm}`);
          }
        }
        outcome = "posted";
      });
    } finally {
      await session.endSession();
    }
    if (outcome === "raced") raced += 1;
    if (outcome === "posted") {
      written += entry.rows.length;
      posted += 1;
      if (!touched.has(firm)) touched.set(firm, new Set());
      for (const m of entry.moves) touched.get(firm).add(stored(m.account));
    }
  }
  console.log(`\n${posted} invoice(s) posted, ${written} rows written${raced ? `, ${raced} already posted by the time they were reached (skipped)` : ""}.`);

  // 3. The running figure on every row of every GL head in each firm this
  //    run -- or an earlier, interrupted one -- posted to, and a check that
  //    each head's lastBal agrees with its rows (or drifts by no more than it
  //    did before). Every head, not only the ones posted to just now: an
  //    interrupted run's invoices are "already posted" to the rerun.
  const settleFirms = await firmsWithBackfill(ledgers);
  for (const [firm, id] of firmIdOf) if (touched.has(firm)) settleFirms.set(firm, id);
  const newDrift = await settleHeads({ customers, ledgers, firms: settleFirms, drifting });
  await mongoose.disconnect();
  if (newDrift) process.exitCode = 1;
}

/** Firms with rows written by any run of this script: companyId string -> id. */
async function firmsWithBackfill(ledgers) {
  const ids = await ledgers.distinct("companyId", { backfillRun: { $exists: true } });
  return new Map(ids.filter((id) => id !== null && id !== undefined).map((id) => [String(id), id]));
}

/**
 * Rewrite the running `balance` on every row of every GL head in these
 * firms, and compare each head's lastBal with its rows. Idempotent: it only
 * ever derives figures from the rows. Returns how many heads drift by a
 * different amount than they did before this run.
 */
async function settleHeads({ customers, ledgers, firms, drifting = [] }) {
  if (!firms.size) return 0;
  console.log("running balances and head check:\n");
  let changed = 0;
  for (const [firm, companyId] of firms) {
    const heads = await customers
      .find({ companyId, name: { $in: GL_ACCOUNTS } }, { collation: COLLATION })
      .toArray();
    for (const head of heads) {
      const rows = await ledgers
        .find({ companyId, customerName: head.name }, { projection: { date: 1, debit: 1, credit: 1 } })
        .toArray();
      const balances = runningBalances(head, rows);
      if (balances.length) {
        await ledgers.bulkWrite(
          balances.map((b) => ({ updateOne: { filter: { _id: b._id }, update: { $set: { balance: b.balance } } } }))
        );
      }
      const drift = headDrift(head, rows);
      const before = drifting.find((d) => d.firm === firm && d.name === head.name)?.drift || 0;
      const flag = drift !== before ? "  <-- CHANGED, investigate" : drift !== 0 ? "  (drift carried over)" : "";
      if (drift !== before) changed += 1;
      console.log(`  firm ${firm.slice(-6)}  ${pad(head.name, 24)}${padL(money(head?.lastBal ?? 0), 14)}${flag}`);
    }
  }
  console.log(changed ? `\n${changed} head(s) out of step with their rows. See above.\n` : "\nEvery head agrees with its rows.\n");
  return changed;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
}
