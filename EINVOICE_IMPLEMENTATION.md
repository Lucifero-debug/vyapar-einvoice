# Vyapaar e-Invoicing — Implementation Record

What was actually built, why each decision went the way it did, and exactly
where to pick it up.

`EINVOICE_PLAN.md` is the plan — the compliance facts, the API shapes, the
build order. **This file is the record of steps 1 to 6 of that build order**,
written so that somebody who has never seen this work (a person or another AI)
can continue step 7 without guessing.

Read `PROJECT_CONTEXT.md` first. This assumes its section 6 rules.

- Project: `vyapaar-einvoice`
- Built: 8 October 2026
- Status: steps 1–6 done, tested, mutation-tested. Steps 7–10 need WhiteBooks
  sandbox credentials and are not started, so **no invoice has yet been
  reported to a real IRP** and the freeze in step 1 has never fired in anger.

> **Note added 12 October 2026.** `vyapaar-einvoice` began as a copy of
> `vyapaar`, but the two have diverged a long way since: orders, bill of
> material, production and stock vouchers, the account books, the financial
> statements, production planning, bill-wise adjustment, staff management, the
> billing-screen consolidation, the Sales/Purchase module reports, the GST
> returns, the business dashboard, the master keyboard actions, the reporting
> and export layer, customer and supplier statements, per-firm branding and the
> invoice importer all exist **only here**. Treat `vyapaar-einvoice` as the live
> repo. `PROJECT_CONTEXT.md` is current; nothing below has changed except where
> this file says so, but it is no longer the whole of what is built.

---

## 0. Before it runs

Three things, and only the first two are not automatic.

1. **Copy `.env.local` by hand** from `vyapaar` into `vyapaar-einvoice`.
   Remote tooling is not permitted to write `.env` files, so it is the one
   thing missing from the copy. (`backend/.env` used to be the second;
   `backend/` is no longer used — `PROJECT_CONTEXT.md` §6.26.)

2. **Add a new key** to `.env.local`:

   ```
   EINVOICE_KEY=<64 hex characters>
   ```

   Generate one with:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   This is **not** `AUTH_SECRET` and must never be. `AUTH_SECRET` signs
   sessions; `EINVOICE_KEY` decrypts every firm's e-invoice portal password. If
   one secret did both, a single leak would let somebody file tax documents in
   your customers' names. `lib/secretBox.mjs` refuses to fall back to
   `AUTH_SECRET`, and a test asserts the string `AUTH_SECRET` appears nowhere in
   that file's code.

   Without the key, everything else still works. Only *storing a portal
   password* is refused, with a 503 that says why.

3. ```
   npm install
   npm test        # 25 suites
   ```

---

## 1. The six steps

### Step 1 — an invoice freezes once it carries an IRN

**The problem.** `sale-alter` let a saved invoice be edited freely, *including
its `invoiceNo`*, and `delete-invoice` removed it outright. Once the IRP holds
a signed copy of an invoice, changing ours does not change theirs: it makes the
two disagree silently, and the copy that matters in a dispute is the
government's.

**What was built.**

| File | What it does |
|---|---|
| `lib/einvoiceLock.mjs` | Pure. `editBlockedReason(invoice, now)` and `deleteBlockedReason(...)` return a sentence or `null`. `cancelWindowOpen()`, `cancelDeadline()`, `hasIrn()`, `isCancelled()`, `CANCEL_WINDOW_MS`, `LOCKED_STATUS` (409) |
| `models/invoiceModel.js` | `irn`, `ackNo`, `ackDt`, `signedQrCode`, `signedInvoice`, `einvoiceStatus` (`none`/`generated`/`cancelled`/`failed`), `einvoiceCancelledAt`, `einvoiceError`, plus a unique partial index on `{ companyId, irn }` |
| `app/api/sale-alter/route.js` | Checks the lock inside the transaction, right after the invoice is read, and aborts with 409 |
| `app/api/delete-invoice/route.js` | Reads the row first, checks, *then* deletes — so a frozen invoice is never momentarily gone and put back by a rollback |
| `components/EinvoiceLockNotice.jsx` | The same sentence as a banner, in front of the Save button |
| the four billing pages | `saleadd`, `purchaseadd`, `salereturn`, `purchasereturn`: capture the IRN fields on load, disable Save, refuse to submit |

**The rules, and why.**

- An IRN freezes the row. `einvoiceStatus` does not matter: `generated`,
  `failed` or missing all freeze it, because the IRN existing means the IRP
  accepted it.
- `einvoiceStatus === "cancelled"` unfreezes it. **`einvoiceCancelledAt` alone
  does not** — a row with a timestamp but no cancelled status is a cancel that
  did not finish, and unfreezing an invoice the IRP still holds is the one
  mistake this module exists to prevent.
- The 24-hour window closes at `ackDt + 24h` **exactly**: open at
  `deadline - 1ms`, shut at `deadline`. "Within 24 hours" is over at the mark.
- No `ackDt` means no deadline is invented. The message says "within 24 hours
  of reporting it" instead of guessing a date.
- Everything is 409, not 400 or 500: the request is well formed, the row's
  state refuses it.

**The message** is one string, built in the lib and rendered verbatim by both
the API and the screen, so the two can never word the rule differently:

> Invoice 42 has been reported to the IRP (IRN ccc…). It cannot be edited.
> Cancel the e-invoice before 9 Oct 2026, 3:42 pm IST, or raise a credit note.

and once the window shuts:

> … The 24-hour cancellation window closed on 9 Oct 2026, 3:42 pm IST. Raise a
> credit note instead.

---

### Step 2 — the letterhead comes from the signed-in firm

**This step fixed a live bug, not just a missing feature.** Every printed
invoice carried a name and a GSTIN written into the source of
`components/InvoiceDocument.jsx`:

```
Prashant Enterprise
GSTIN: 12ABCDE3456F7Z8
+91 76543 21098
```

That GSTIN is not a real number. Meanwhile `lib/company.mjs` held a *different*
firm — `SURYAVANSH TEXTILES` — which the ledger, stock report and voucher
register printed. A customer receiving a bill and a statement got two different
companies, and the bill was not a valid tax invoice. On a shared instance every
firm printed the first firm's details.

**What was built.**

| File | What it does |
|---|---|
| `lib/company.mjs` | **Rewritten.** No hardcoded firm anywhere. `companyFrom()` (a record → the object documents read), `addressLines()`, `companyAddress()`, `profileProblems()`, `irpMissing()`, `canReportToIrp()`, `PROFILE_FIELDS`, `BLANK_COMPANY`. **Since extended:** `legalName` and `website` joined `PROFILE_FIELDS`, and `companyFrom()` now also returns `logo` (through `lib/companyLogo.mjs`'s validator) and `invoicePrefs` (through `lib/invoicePrefs.mjs`'s defaults). `COMPANY_LOGO` is **gone** — it was the last shared-branding constant; see `PROJECT_CONTEXT.md` §6.25 |
| `app/company/page.js` | The Business profile form, built from `PROFILE_FIELDS` |
| `app/api/company/route.js` | `GET` — the firm's details. Readable by **every** role |
| `app/api/company-update/route.js` | `POST` — owner only |
| `context/CompanyContext.js` | `CompanyProvider` + `useCompany()`, mounted in `app/layout.js` |
| `app/setup/page.js` | Links to `/company`, listed first |
| `components/InvoiceDocument.jsx` | Letterhead from `useCompany()`; address lines added (a tax invoice needs the supplier's address, and so does the IRP) |
| `app/invoice`, `app/ledger`, `app/item-ledger`, `app/voucher` | All read `useCompany()` |
| `app/api/send-email/route.js` | The sender name is now the firm's, built per request from `auth.company.name` rather than once at import |
| `lib/roles.mjs` | `["/api/company", null]`, `["/api/company-update", "setup:write"]`, `["/api/company-logo", "setup:write"]`, `["/company", "setup:write"]` |

**Why GET is readable by everyone.** A biller cannot print a bill without the
letterhead. Permissions in this project are per *path*, not per method, which
is why the read and the write are two routes — the same reason
`/api/customer` and `/api/customer-alter` are separate.

**Validation rules** (`profileProblems`):

- the business name is the only required field — a firm part-way through
  filling this in must still be able to save
- a GSTIN, if present, is 15 characters matching
  `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$`. The checksum is deliberately
  *not* verified: getting that wrong would reject a real number, and the IRP
  checks it properly anyway
- **the state code must equal the GSTIN's first two digits.** This is the one
  the IRP rejects with a bare numeric code, so it is worth catching on the form
- PIN code is six digits not starting with zero; IFSC is `^[A-Z]{4}0[A-Z0-9]{6}$`
- blank is allowed nearly everywhere. What is refused is a value that is
  *present and wrong*

`companyFrom()` upper-cases the GSTIN and IFSC and pads the state code, so what
is validated, what is stored and what is printed are the same string whatever
the owner's keyboard did.

A `website`, if present, must carry `http://` or `https://`. It is **refused**
rather than silently prefixed: guessing `https` for a host that may only serve
`http` puts a dead link on a bill, which is worse than a typo caught while
typing.

**Blank prints as nothing.** An empty line on a bill is honest; a placeholder
that looks like a real GSTIN is not.

---

### Step 3 — the buyer is snapshotted onto the invoice

**Why a copy, when the party is one lookup away.** Because an e-invoice is a
filing. The IRN is tied to the details that were reported, so a party who moves
shop next year must not retroactively change the address on a bill already
filed. Reading the master at print time would make the document quietly stop
matching the government's copy of itself.

**What was built.**

| File | What it does |
|---|---|
| `lib/buyerSnapshot.mjs` | `buyerSnapshot(party, typed)`, `BUYER_FIELDS`, `BUYER_PROJECTION`, `partyGstin()`, `isB2B()`, `buyerMissing()` |
| `models/invoiceModel.js` | The embedded `customer` block gains `gstin`, `address`, `city`, `state`, `pincode`, `stateCode` |
| `app/api/save-invoice/route.js` | The party is now read **before** `Invoice.create`, and the block is built by `buyerSnapshot()` |
| `app/api/sale-alter/route.js` | Same, before `findOneAndUpdate` |

**Where each value comes from.**

- `name`, `phone`, `email` — what the biller typed, falling back to the master.
  A contact typed for one bill is meant for that bill.
- `gstin`, `address`, `city`, `state`, `pincode`, `stateCode` — **the master
  only**. These are registration details; the billing form has no field for
  them and must not be able to claim them.

**Two traps worth knowing.**

1. **`custModel` spells it `gstIn`** — capital I — while `companyModel`, this
   snapshot and the IRP's own payload all use `gstin`. `partyGstin()` reads
   both spellings, in one place, rather than renaming a column every customer
   form already writes.

2. **The buyer's `stateCode` is not the place of supply.** The invoice has a
   top-level `stateCode` for the place of supply; this one is the buyer's own
   registration. They differ on exactly the bills where it matters, and
   swapping them is a wrong filing.

**A second bug fixed here.** `sale-alter` was writing
`customer: { name, phone, email }` by hand, which silently dropped `custId`
from every invoice that was ever edited.

---

### Step 4 — UQC and goods/service, per item

**What was built.**

| File | What it does |
|---|---|
| `lib/uqc.mjs` | All 44 codes, `UQC_DEFAULT` (`OTH`), `normalizeUqc()`, `isUqc()`, `uqcLabel()`, `stampItemLines()`, `isServcFlag()` |
| `models/itemModel.js` | `uqc` (default `OTH`, uppercase) and `isService` (default false) |
| `models/invoiceModel.js` | `uqc` and `isService` on each embedded line |
| `app/itemadd/page.js` | A UQC dropdown and a "This is a service" checkbox |
| `app/api/item-add`, `item-alter` | Both whitelist fields explicitly, so both needed the two new ones |
| `app/api/save-invoice`, `sale-alter` | One `Item.find({ name: { $in } })` per save, then `stampItemLines()` |

**Rules.**

- The item master's free-text `unit` ("pcs", "bori") stays as it is — it is
  what the shop calls the unit and what the stock report prints. `uqc` is a
  separate field.
- **The code is never guessed from the free-text unit.** A wrong UQC is a
  rejected filing, and a silent mapping from "bag" to `BAG` while "bori"
  quietly became `OTH` is worse than asking once. Unmatched means `OTH`, which
  is a real code meaning "others".
- The **master wins** over whatever the billing page sent. The page copies the
  whole item row into each line, so a stale copy would otherwise outrank it.
- An item not in the master at all (an AI-imported bill) keeps what it came
  with, then falls back to `OTH`.
- `normalizeUqc()` returns `""` for an unrecognised value, not `OTH`, so a
  caller can tell "nothing chosen" from "deliberately others".

**A correction to the plan.** `EINVOICE_PLAN.md` §4.4 listed `LTR` for litres
from memory. **There is no UQC for litres.** A litre is 1000 `MLT`, or use
`KLR` for kilolitres. The list in `lib/uqc.mjs` was checked against three
published copies and all 44 codes agree. `TGM` is published as "ten gross" by
some sources and "ten grams" by others; only the code is transmitted, so the
label is cosmetic.

---

### Step 5 — `lib/einvoicePayload.mjs`, the INV-01 payload

Pure. No network, no Mongoose, no clock of its own — everything is passed in,
which is the only way this is testable at all.

```js
const { payload, problems } = buildEinvoicePayload({ invoice, company, now });
if (problems.length) return problems;   // never send it
```

`payload` is `null` whenever there are problems. There is no such thing as a
payload that is nearly right.

**Reconciliation, which is what the IRP actually rejects.**

- per line: `TotItemVal === AssAmt + CgstAmt + SgstAmt + IgstAmt`, and
  `AssAmt === TotAmt - Discount`
- overall: `TotInvVal === Σ TotItemVal + OthChrg + RndOffAmt`
- `RndOffAmt` is computed as the remainder, so it reconciles exactly — but a
  remainder over `RECONCILE_TOLERANCE` (₹1) is reported as a **problem**, not
  papered over. A bill whose own arithmetic disagrees by ₹65 is a bug to fix,
  not a rounding adjustment to invent.

**Other decisions.**

- The tax split uses `splitGst()` from `lib/gst.mjs` — the same function the
  printed bill uses — so the paper invoice and the filing agree to the paisa,
  and the odd paisa is carried once rather than twice.
- A line never carries both IGST and CGST/SGST: `taxType === "central"` is
  IGST only, anything else is CGST + SGST.
- `discount` is a **percentage**, as it is everywhere else in this project.
- `Pin` is a number; `Stcd` is a string that keeps its leading zero.
- `freight` is a `String` in the schema and party taxes arrive as strings, so
  every figure goes through one coercion that also strips commas and turns
  junk into 0 rather than `NaN`.
- `DocDtls.Typ` is `CRN` for a sale return, `INV` otherwise.
- `Dt` is `dd/mm/yyyy` in IST, never ISO.

**`payloadProblems()` refuses**: a purchase or purchase return; a buyer with no
GSTIN (a B2C sale is not reported); a B2B buyer missing an address, city, PIN
or state code; an incomplete seller profile; an invoice that already has an
IRN; a future-dated invoice; an invoice number over 16 characters, outside
`A-Z 0-9 / -`, or starting with `0`, `/` or `-`; a line with no HSN code or no
quantity; no lines at all; and totals that do not reconcile.

Every problem is a sentence a shopkeeper can act on, because the IRP's own
answer is a number.

**`lib/istDate.mjs`** was extracted so the 24-hour window and the document date
share one implementation of "read this in India": `IST_OFFSET_MINUTES` (330),
`istParts()`, `formatIst()`, `formatIrpDate()`, `istDayNumber()`. A host in UTC
printing its own wall clock would be five and a half hours behind, which
crosses midnight for anything billed after 6:30pm — an evening invoice would be
filed under yesterday's date. India has never observed DST, so this needs no
timezone database. The future-date check compares **IST calendar days**, not
instants, which is what the IRP does.

---

### Step 6 — encrypted credential storage

**Why encryption and not hashing.** A user's own password is hashed because
nothing needs to read it back. The portal password has to be sent to the IRP on
every token refresh, so it must be recoverable.

| File | What it does |
|---|---|
| `lib/secretBox.mjs` | AES-256-GCM. `seal()`, `open()`, `tryOpen()`, `isSealed()`, `keyFrom()`, `keyFromEnv()`, `generateKeyHex()`, `secretBoxReady()`, `sameSecret()`, `SecretBoxError`. **Server only** — it imports `node:crypto` |
| `lib/einvoiceCredentials.mjs` | Pure and client-safe: `EINVOICE_ENVS`, `normalizeEnv()`, `credentialState()`, `credentialProblems()`, `credentialsReady()` |
| `models/companyModel.js` | `einvoiceEnabled`, `einvoiceUsername`, `einvoicePasswordEnc` (`select: false`), `einvoiceEnv` |
| `app/api/company/route.js` | Returns `einvoice: { enabled, username, env, passwordSet }` and `einvoiceKeyConfigured` |
| `app/api/company-update/route.js` | Seals a supplied password; 503 if no key is configured |
| `app/company/page.js` | The E-invoicing panel |

**The stored form** is `aesgcm$1$<iv b64>$<tag b64>$<ciphertext b64>`, with a
fresh random IV each time — otherwise the column would quietly reveal which
firms share a password.

**The company's id goes in as additional authenticated data**, so a blob copied
from one firm's row into another's does not open. Neither does an edited one:
GCM verifies the tag before returning anything, so a failure never yields
plaintext.

**A key is 32 bytes as 64 hex or 44 base64 characters, and nothing is derived
from a passphrase.** A key that can be guessed is worse than no encryption,
because it reads as protection. A short or unrecognised value is refused with a
message that says how to generate a real one.

**The password never comes back out.** `select: false` keeps it out of every
ordinary query; the route asks for it by name only to decide whether one
exists; `credentialState()` turns it into a boolean. A blank password field
means "leave the stored one alone", not "wipe it".

**Sandbox is the default**, and anything unrecognised falls back to sandbox,
never to production. Filing a test invoice against the live portal is the
mistake that costs real money.

---

## 2. Design constraints that shaped all of it

These are from `PROJECT_CONTEXT.md` §6 and were each load-bearing here.

1. **A `'use client'` page cannot import anything that reaches `node:*`.**
   This is why `lib/einvoiceCredentials.mjs` exists separately from
   `lib/secretBox.mjs`: the profile form needs the shape and the validation,
   and must never touch the crypto. A test asserts `einvoiceCredentials.mjs`
   has no imports at all. (The signup page broke this way once already, via
   `lib/password.mjs` → `node:crypto`.)

2. **Mongoose strict mode silently drops undeclared fields.** Every snapshot
   field is declared on the schema *and* written by a route, and two tests
   sweep the schema files to prove it. A field that is captured, sent and then
   thrown away produces no error anywhere.

3. **Snapshot, never look up at print time.** Applies to the buyer (step 3) and
   to each line's UQC and service flag (step 4), for the same reason.

4. **One definition of a rule, shared by the server and the screen.** The lock
   message, the profile validation and the credential validation are each one
   function, called from both sides.

5. **Fail closed.** An unlisted `/api/` path demands `setup:write`
   (owner-only). Both new routes are listed explicitly, and `auth.test.mjs`
   asserts every role can read the letterhead while only the owner can change
   it.

---

## 3. Every new file

**New pure modules** (`lib/`), all runnable under bare `node`:

| File | Bytes | Server-only? |
|---|---|---|
| `einvoiceLock.mjs` | 4,751 | no |
| `istDate.mjs` | 3,125 | no |
| `buyerSnapshot.mjs` | 4,109 | no |
| `uqc.mjs` | 5,285 | no |
| `einvoicePayload.mjs` | 9,704 | no |
| `einvoiceCredentials.mjs` | 3,059 | no |
| `secretBox.mjs` | 6,727 | **yes** — `node:crypto` |
| `company.mjs` | 8,526 | no (rewritten) |

**New components, contexts, pages and routes:**

- `components/EinvoiceLockNotice.jsx`
- `context/CompanyContext.js`
- `app/company/page.js`
- `app/api/company/route.js` (GET)
- `app/api/company-update/route.js` (POST)

**Changed:** `models/invoiceModel.js`, `models/itemModel.js`,
`models/companyModel.js`, `lib/roles.mjs`, `app/layout.js`, `app/setup/page.js`,
`app/itemadd/page.js`, `components/InvoiceDocument.jsx`, the four billing
pages, `app/invoice/page.js`, `app/ledger/page.js`,
`app/item-ledger/page.js`, `app/voucher/page.js`,
`app/api/save-invoice/route.js`, `app/api/sale-alter/route.js`,
`app/api/delete-invoice/route.js`, `app/api/item-add/route.js`,
`app/api/item-alter/route.js`, `app/api/send-email/route.js`,
`scripts/auth.test.mjs`, `package.json`.

---

## 4. Tests

Seven new suites, 153 checks, in the project's existing style: plain
`node:assert` and a tiny `test()` helper.

| Suite | Checks | Guards |
|---|---|---|
| `einvoice-lock.test.mjs` | 27 | the freeze, and the 24-hour window to the minute across month, leap-day and year boundaries |
| `company-profile.test.mjs` | 22 | nothing false on a document, the GSTIN/state-code agreement, and a source sweep for the two firms that used to be hardcoded |
| `buyer-snapshot.test.mjs` | 16 | the `gstIn`/`gstin` spelling, master-over-form precedence, and schema/route sweeps |
| `uqc.test.mjs` | 20 | the 44 codes, no `LTR`, master-over-page, and schema/route sweeps |
| `einvoice-payload.test.mjs` | 34 | every reconciliation rule, the local/central split, and each refusal |
| `secret-box.test.mjs` | 21 | round-trip, tamper, wrong firm, wrong key, and that `AUTH_SECRET` is not a fallback |
| `einvoice-credentials.test.mjs` | 13 | the password never coming back out, and sandbox-by-default |

All seven are in `npm test`. It ran **25 suites** when this was written and
runs **40** now — the later ones are unrelated to e-invoicing
(`PROJECT_CONTEXT.md` §10).

**Every suite was mutation-tested** — the source was broken roughly twenty ways
per module and each break had to make a test fail. Survivors were closed with
new tests rather than ignored. To repeat it for a module, change one line in it
and run its suite; if the suite still passes, the test is missing.

> This practice has since been formalised, with a scripted harness per module
> and a full-kill requirement before a module is called done:
> `PROJECT_CONTEXT.md` §10.1.

Two things that mutation testing caught, worth repeating because they are easy
to get wrong in a hand-rolled harness:

- **An `async` test body reports "ok" before it has asserted anything** — the
  throw lands in a promise nobody awaits. Every new suite's `test()` helper now
  refuses a function that returns anything.
- **Failures are written to stderr.** A harness that captures only stdout
  reports every mutant as surviving.

---

## 5. What is not built

Steps 7–10 of `EINVOICE_PLAN.md` §9. All four need WhiteBooks sandbox
credentials; §6 of the plan has the request shapes already confirmed with them.

| # | Step | Needs |
|---|---|---|
| 7 | `lib/einvoiceClient.mjs` — a token cache and two fetch calls | `client_id`, `client_secret`, a portal username and password — **§6.6 of the plan now has how to get both, and they come from two different places** |
| 8 | `POST /api/einvoice/generate` and `/api/einvoice/cancel`, both wrapped in `tenantRoute`, both listed in `PATH_RULES` with a new `einvoice:generate` permission for **owner and accountant only, not biller** | step 7 |
| 9 | The signed QR on the printed bill, in `components/InvoiceDocument.jsx` — needs the `qrcode` package | step 8 |
| 10 | The button and status on the invoice page | step 8 |

**Where to start step 7.** The pieces it needs already exist:

- `buildEinvoicePayload({ invoice, company })` gives the body, or the reasons
  not to send one
- `open(company.einvoicePasswordEnc, { aad: String(company._id) })` gives the
  password
- `credentialsReady(company)` says whether to try at all
- `normalizeEnv(company.einvoiceEnv)` picks sandbox or production
- the invoice fields to write back on success are already on the schema:
  `irn`, `ackNo`, `ackDt`, `signedQrCode`, `signedInvoice`,
  `einvoiceStatus: "generated"`

**Two env vars step 7 will need** that nothing reads yet:

```
EINVOICE_CLIENT_ID=
EINVOICE_CLIENT_SECRET=
```

These are the vendor's own WhiteBooks credentials, one pair for every customer,
so they belong in the environment. The per-firm portal username and password are
already on the `companies` record, encrypted. `EINVOICE_KEY` (§0) is a third,
unrelated thing: the key those passwords are sealed with.

**Two things the plan flags that are not yet handled anywhere.**

1. **Idempotency.** A timeout where the IRP actually registered the invoice is
   the dangerous case. Before generating, call "get IRN by document details";
   if one exists, store it rather than trying again. Treat error 2150 the same
   way. The unique partial index on `{ companyId, irn }` is a backstop, not a
   solution.

2. **The token's 3600-second life** has to be cached per firm and per
   environment, not fetched per invoice.

---

## 6. Gotchas found during this build

- `custModel.gstIn` versus `companyModel.gstin` — read both spellings, in one
  place (`partyGstin()`).
- `invoice.freight` is a `String`. So are party-tax amounts off the form.
- `invoice.stateCode` is the place of supply; `invoice.customer.stateCode` is
  the buyer's registration. Both exist, and they differ on the bills where it
  matters.
- `Item.lastQuantity` is **never maintained by postings** — stock is
  `openingQuantity + Σ received − Σ issued`. Unrelated to e-invoicing, but it
  is the kind of thing that looks like a shortcut and is not.
- `withTransaction()` requires a replica set and has no non-transactional
  fallback by design. `delete-invoice` therefore reads-then-deletes rather than
  relying on a rollback to protect a frozen invoice.
- The official UQC list has **no code for litres**.
- **`new URL(..., import.meta.url).pathname` is not a filesystem path.** It
  keeps `%20` for every space and, on Windows, a leading `/` before the drive
  letter -- so `readdirSync` on it fails with
  `ENOENT ... 'C:\\C:\\Vs%20Code\\...'`. Use `fileURLToPath()`. This project's
  path contains two spaces, so it breaks on Linux too; it only ever worked
  because the suite had been run from a directory without any.
  `scripts/tenant-scope.test.mjs` was the only suite doing this.
- **A path built with `path.join` is separated by backslashes on Windows**, so
  looking for `"app/api/"` in one finds nothing. Normalise with
  `f.split(path.sep).join("/")` before matching or slicing. Fixing only the
  `.pathname` crash above exposes this one immediately.
