# Pending migrations — operator checklist

Three one-off migrations are waiting to run against the live database:

| # | Command | What it changes |
|---|---------|-----------------|
| 1 | `node scripts/backfill-stock-kind.mjs` | Sets `kind: "FR"` on old `productions` rows |
| 2 | `npm run sync:indexes` | Builds the per-firm unique indexes the schemas declare, then drops the stale ones |
| 3 | `npm run backfill:gl-legs` | Adds the missing Sales/Purchase/GST/Round-off ledger rows to old invoices |

Every script **only reports unless you pass `--apply`**. On a report run each one reads, prints, and exits. It writes no documents and builds or drops no indexes. Each script switches Mongoose's `autoIndex` and `autoCreate` off before it touches a model (`quietMongoose` in `scripts/_shared.mjs`). The old scripts left them on, so even a report run could build indexes as soon as a model was imported.

A clean exit from a script does **not** mean the migration is safe. Each section below lists what a person has to check first.

---

## 0. Before anything

- [ ] **Take a full database backup.** Use an Atlas snapshot, or `mongodump --uri "$MONGO_URI" --out ./dump-<date>`. The JSON files the scripts write to `backups/` only cover their own changes. They do not replace a real backup.
- [ ] **Pause billing**, so nobody saves invoices, vouchers or stock vouchers while the migrations run. Migration 3 needs this most.
- [ ] **Check the server type.** Run `mongosh "$MONGO_URI" --eval 'db.hello()'`. It must show a `setName` (a replica set; Atlas always has one) or `msg: "isdbgrid"` (a sharded cluster). The app's own transactions need a replica set (`lib/withTransaction.mjs`), and migration 3 refuses `--apply` without one.
- [ ] **Look for rows with no firm.** Migration 2's report prints `ROWS WITH NO FIRM`. If it lists any, run `node scripts/adopt-tenant.mjs` first (report, then `--apply --company <id>`). Rows with no `companyId` are hidden from the app, and every per-firm index lumps them together as firm `null`.
- [ ] Run the scripts from a machine where `MONGO_URI` points at the database you intend to change. Each script prints the database name first: **read it**.

**Run order: 1 → 2 → 3.**

Migration 1 must come before 2. If the `(companyId, kind, docNo)` index exists while old rows are unstamped, stamping a row whose number is already taken by a new `FR` row fails part-way. The app's own autoIndex may have built that index already. Migration 1's clash check finds those rows before anything is written.

---

## 1. Stock-voucher kind — `scripts/backfill-stock-kind.mjs`

**What it does (checked in the code):**
- **Eligible rows:** only `productions` rows whose `kind` is missing, `null` or `""` (`MISSING_KIND` in `lib/stockKindBackfill.mjs`). A row that already has `FR`, `IS` or `RS` is never matched. A rerun changes nothing.
- **Clash check, which also runs in report mode:** it checks that no firm would end up with the same `docNo` on two `FR` rows. That would happen if an old unstamped row and a new `FR` row share a number, or two unstamped rows do. If it finds one, it stops and lists the rows by `_id`. It deletes nothing and renumbers nothing.
- **The write:** a single `updateMany` against the raw collection, filtered on the listed `_id`s **and** still-unstamped. A row edited in the meantime is not overwritten. `updatedAt` is left alone.
- **Backup:** `backups/stock-kind-<timestamp>.json`. It holds every `_id`, its `companyId` and its `docNo`, and is written before the change.
- **Before this review:** the script had no backup and no clash check, and importing the Production model let autoIndex build the new unique index during a report run.

**Expected change:** `kind: "FR"` set on N documents. N is printed per firm. No other field changes.

**Duplicate risk:** an old unstamped production entry and a newer `FR` entry with the same number in the same firm. Resolve each pair by renumbering one through the app, then re-run the report.

**Commands:**
```
node scripts/backfill-stock-kind.mjs            # report
node scripts/backfill-stock-kind.mjs --apply    # backup, confirm, stamp
```

**Verify:**
```js
db.productions.countDocuments({ $or: [{ kind: { $exists: false } }, { kind: null }, { kind: "" }] })  // 0
db.productions.aggregate([{ $group: { _id: "$kind", n: { $sum: 1 } } }])                             // only FR / IS / RS
```

**Rollback:** take the `_id`s from the backup, then run
`db.productions.updateMany({ _id: { $in: ids.map(ObjectId) }, kind: "FR" }, { $unset: { kind: "" } })`.
The `kind: "FR"` filter matters: the backup lists every row that was eligible, and a row that gained a different kind afterwards must not lose it.

---

## 2. Unique indexes — `npm run sync:indexes`

**What it does (checked in the code):**
- **Which indexes it covers:** the tenant collections listed in `lib/clearData.mjs`, plus `users`. A user's email is unique **per firm** and case-insensitive (`{companyId, email}` with a strength-2 collation), so a surviving global `email_1` would stop one person working for two firms. `companies` is left out: it is the list of firms itself, and is deliberately not unique on name.
- **Two kinds of stale index (`staleUniques` in `lib/indexAudit.mjs`):**
  - a unique index **not led by `companyId`**, such as `invoiceNo_1`
  - a unique index that **is** led by `companyId` but is no longer declared, such as `companyId_1_docNo_1` on `productions`

  The old audit missed the second kind. While that index exists, Goods Issue 5 and Production 5 cannot both exist in one firm.
- **An index is matched on its options as well as its key.** An existing index with the declared key but different options counts neither as present nor as a replacement. Examples: not unique, or `sparse` where the schema says partial. It is reported as a **CONFLICT** and blocks the run, because `createIndex` cannot build over it. Before this review a non-unique `companyId_1_invoiceNo_1` was accepted as the replacement, so the global `invoiceNo_1` could have been dropped with no uniqueness left at all.
- **Duplicate check before building:** for every declared per-firm unique index that is missing, it looks for rows that would break it. The check uses the index's own scope: its partial filter (such as the IRN index), missing-equals-null (as the index treats them), and case-folding for a case-insensitive index (users' email). If any are found, the run stops: nothing is built and nothing is dropped. There is **no `--force`** any more. The report lists duplicates by key and `_id`, and the fix is a human decision.
- **Order on `--apply`:**
  1. Back up every index definition.
  2. Build the missing declared indexes, by name. If any build fails, it stops before dropping anything.
  3. Re-read the index list.
  4. Drop each stale index **only if** a declared per-firm unique index covering every field it protected is now present (`replacementFor`).
- **Stale indexes with no declared replacement** are reported and left alone. Dropping one is a decision for a person.
- **Before this review:** the script dropped global indexes first and relied on the app's autoIndex to rebuild per-firm ones later. It did not check that a replacement existed. It never saw stale per-firm indexes. It checked duplicates only for the fields of dropped indexes. And `--force` overrode the duplicate check.

**The unique keys the schemas declare:**

| Collection | Unique key |
|---|---|
| invoices | `{companyId, invoiceNo}`; `{companyId, irn}` (partial: only where `irn` is a string) |
| orders | `{companyId, type, orderNo}` (so sales order 1 and purchase order 1 can coexist) |
| productions | `{companyId, kind, docNo}` |
| boms | `{companyId, name}` |
| hsns | `{companyId, hsncode}` |
| states | `{companyId, name}` and `{companyId, code}` |
| customergroups | `{companyId, name}` |
| counters | `{companyId, name}` |
| stockalerts | `{companyId, itemName}` (partial: `status: "open"`, index name `one_open_alert_per_item`) |

Notes on the brief's assumptions:
- Orders are **not** `{companyId, kind, docNo}`; they are `{companyId, type, orderNo}`.
- BOMs are `{companyId, name}`.
- The voucher-allocation index `{customers.allocations.invoiceNo, customers.allocations.invoiceType}` is **not unique**, and not led by `companyId`. The tenant filter is applied as well, so it is a speed index only, and this script leaves it alone.
- **Customers and items have no unique index on name.** The app enforces that case-insensitively (`lib/uniqueName.mjs`), so the database will accept two `"Acme"` rows written outside the app. This is deliberate (see `custModel.js`).

**Duplicate risk:** two invoices or orders in one firm with the same number, two HSN rows with the same code, a state name or code entered twice, and so on. The report lists each group as `companyId`, the key values and up to 5 `_id`s. Note that the database only enforces exact matches, so `"Retail"` and `"retail"` are not duplicates as far as an index is concerned.

**Commands:**
```
npm run sync:indexes                 # report
npm run sync:indexes -- --apply      # backup, confirm, build, then drop
npm run sync:indexes                 # again: every collection must say "ok"
```

Building an index on a large collection takes a short exclusive lock at the start and end. Run it in the maintenance window.

**Verify:**
```js
db.productions.getIndexes()   // has companyId_1_kind_1_docNo_1 (unique); no companyId_1_docNo_1, no docNo_1
db.invoices.getIndexes()      // companyId_1_invoiceNo_1 (unique); no invoiceNo_1
```
Then, in **two different firms**, save sale invoice 1, sales order 1 + purchase order 1, Production 1 + Goods Issue 1, and the same HSN code. Every save must succeed.

**Rollback:** `backups/index-definitions-<timestamp>.json` holds every index as it was, plus the plan.
- To undo a drop: `db.<coll>.createIndex(<key>, { name, unique, partialFilterExpression, collation })` using the backup.
- To undo a build: `db.<coll>.dropIndex("<name>")`.

Do not restore a global unique index once a second firm has started writing. It will fail to build, which is the bug this migration fixes.

---

## 3. General-ledger legs — `npm run backfill:gl-legs`

**What it does (checked in the code):**
- **Which invoices:** an invoice is planned only if **none** of its contra ledger heads already has a row carrying its `voucherId`. An invoice with **some** of them is reported as `PARTLY POSTED` and skipped, never topped up. An invoice with no `companyId` is reported and never posted.
- **Per firm:** heads are found by `(companyId, name)`, case-insensitively, and rows are written under each firm's **stored** head name, the same way the app does (`lib/glAccounts.mjs`). A missing head is created **in that firm**. The run stops in two cases:
  - two heads in one firm whose names differ only in case
  - a head name held by an account in a **party** group (Sundry Debtors/Creditors). That account would otherwise receive the tax or the sales.

  A head in another unexpected group is listed as a warning.
- **Whether an invoice is already posted** is judged case-insensitively. The app posts under the stored name, so an exact comparison would see an invoice posted to "Sales account" as unposted.
- **One invoice, one transaction:** the invoice's rows and its heads' `lastBal`/`lastMode` change commit together. The balance change is atomic, using `balancePipeline` from `lib/balance.mjs`: signed, positive means Dr. Inside the transaction it re-checks that the invoice still has no contra rows. A crash part-way, or a second copy of the script, therefore cannot leave rows without their balance change, and cannot post an invoice twice. **A rerun posts only what is left.**
- **Afterwards:** it rewrites the running `balance` on every row of **every** GL head in each affected firm. Affected firms are those posted to in this run, or by an earlier run that stopped part-way, found by `backfillRun`. An `--apply` with nothing left to post still does this step. It then checks each head's `lastBal` against `openingBal + Σ(debit − credit)` of its rows. Any head whose difference **changed** is flagged, and the run exits non-zero. This step only derives figures from the rows, so it is safe to repeat.
- **Requires a replica set** for `--apply`; it refuses on a standalone server.
- **Backup:** `backups/gl-legs-<timestamp>.json` holds the run id, every invoice to be posted (with its firm), every head's `lastBal`/`lastMode` before, and the heads to be created. Every new row carries `backfillRun: "<run id>"`.
- **Before this review, the script was unsafe on any database with more than one firm.**
  - It found heads by name across the whole database.
  - It created missing heads with **no `companyId`**.
  - It added up the movement across **all firms** and applied the total to whichever firm's head came back first.
  - It wrote all rows first and moved the balances at the end with read-then-set. A crash in between left rows without their balance movement, and a rerun then skipped those invoices for good.
  - It wrote rows under the canonical head name even when the firm's head was stored with different case, which splits the account in two.

**Expected change:**
- Per firm: one contra row per head per back-filled invoice.
- Sales/Purchase head lastBal moves by −/+ taxable value; GST heads by the tax; Round Off by the difference.
- Missing heads are created.
- Party rows, party balances, invoices and stock do **not** change.

**Duplicate-posting risk:**
- Invoices reported as `PARTLY POSTED` are skipped. Look at each one by hand.
- `ROUNDING OVER A RUPEE` invoices *are* posted, to Round Off. Each one is a freight charge or a wrong figure. Review them before applying, because after the run they sit in Round Off.
- Heads listed as **already disagreeing with their rows** keep that difference. The migration does not fix it, so investigate them separately.

**Commands (with billing paused):**
```
npm run backfill:gl-legs              # report: read every section, especially PARTLY POSTED and ROUNDING
npm run backfill:gl-legs -- --apply   # replica-set check, backup, confirm, post
npm run backfill:gl-legs              # again: "to back-fill: 0"
```

**Verify:**
```js
// no invoice posted twice to one head
db.ledgers.aggregate([
  { $match: { voucherId: { $exists: true }, customerName: { $in: ["Sales Account","Purchase Account","Output CGST","Output SGST","Output IGST","Input CGST","Input SGST","Input IGST","Round Off"] } } },
  { $group: { _id: { v: "$voucherId", h: { $toLower: "$customerName" } }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } } ],
  { collation: { locale: "en", strength: 2 } })                       // empty (the collation catches heads stored in other case)

// every row in the same firm as its invoice
db.ledgers.aggregate([
  { $match: { backfillRun: { $exists: true } } },
  { $lookup: { from: "invoices", localField: "voucherId", foreignField: "_id", as: "inv" } },
  { $unwind: "$inv" },
  { $match: { $expr: { $ne: ["$companyId", "$inv.companyId"] } } } ]) // empty

db.customers.countDocuments({ companyId: { $exists: false } })        // 0
```
Then, **per firm**, in the app:
- Financials → Trial Balance for a period that spans the changeover date must balance.
- Delete and re-create one old back-filled test invoice in a **non-production** copy. Its head balances must return exactly.

**Rollback:** using the run id from the backup:
1. `db.ledgers.deleteMany({ backfillRun: "<run id>" })`
2. For each head in the backup, set `lastBal`/`lastMode` back. If any invoice was posted since the run, re-derive instead: `lastBal = openingBal + Σ(debit − credit)` of that head's remaining rows in that firm.
3. Remove the heads listed under `headsToCreate`, provided they have no rows left.
4. **Do not re-run the script with `--apply` after a rollback.** The invoices are unposted again, so it would post them again. The stored running `balance` on the remaining head rows may then be stale. That is harmless, because every report works the running figure out when it reads the rows (`lib/accountBooks.mjs`), and the app rewrites it for a head the next time it posts to it.

---

## After all three

- [ ] Re-run all three in report mode. Each must report nothing to do.
- [ ] Run `npm test`.
- [ ] **Accounting, per firm:**
  - The trial balance balances across the changeover.
  - Each party's balance equals its ledger. The Statement and Party Balance screens agree.
  - Cash and bank heads agree with their rows.
  - GSTR-1 tables 4–7 add up to table 12.
  - Stock per item equals opening + receipts − issues (the stock report).
- [ ] **Tenant isolation:**
  - Sign in to two firms.
  - In each, invoice 1, order 1 and production 1 save successfully.
  - Neither firm's reports show the other's heads or rows.
  - `db.ledgers.countDocuments({ companyId: { $exists: false } })` is 0.
- [ ] Keep the `backups/` folder and the database snapshot until the next period close..