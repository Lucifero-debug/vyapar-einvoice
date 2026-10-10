# Vyapaar — Project Context for AI Assistants

**Read this file before changing anything.** It is written for an AI assistant
(ChatGPT, Gemini, Claude, Copilot — any of them) that has no prior knowledge of
this codebase. It contains the architecture, the data model, the accounting
rules that must not be broken, the UI vocabulary, and the known landmines.

Paste the whole file, or paste §1–§6 plus the section relevant to your task.

**Last verified: 8 October 2026.** When you change the shape of the data, the
posting rules, the auth or tenancy rules, or the page conventions, update this
file in the same commit. A stale context file is worse than none — it will
confidently mislead.

> **If you read nothing else, read §6.14 and §6.15.** This app now serves more
> than one firm from one deployment. Every query is scoped to the signed-in
> firm, and the mechanism that does it is not obvious from reading a route.

---

## 1. What Vyapaar is

A **GST billing and accounting app for small Indian trading businesses.** It
replaces desktop accounting software of the SIGFA/Tally generation, so its
screens deliberately echo those: dense keyboard-driven grids, Dr/Cr columns,
HSN summaries.

It is **multi-tenant**: one deployment serves many firms, each signing in to
see only its own books. Sign-in, roles and per-firm data scoping all exist —
see §6.14 and §6.15. It is still young; §9 is the honest list of what is not
finished.

What it does:

| Area | Screens |
|---|---|
| Masters | Customers/parties, Items, HSN codes, Party price lists |
| Transactions | Sale, Sale Return, Purchase, Purchase Return invoices |
| Money | Receipt/payment vouchers |
| Reports | Party ledger, Stock (item) ledger, Voucher register, Invoice print, Date-range invoice print |
| Extras | AI invoice-image import (separate Python service), email invoice |
| Account | Sign in, sign up a new firm, roles (owner / accountant / biller) |

**Vocabulary.** "Party" = customer or supplier; both live in the same
`customers` collection. "Voucher" = a receipt or payment entry, not an invoice.
"Item ledger" = stock ledger. Dr = debit, Cr = credit. **"Firm" / "tenant" /
"company"** all mean one subscribing business — the `companies` collection,
and the `companyId` that every other row carries.

---

## 2. Running it

```bash
npm install
npm run dev        # http://localhost:3000  (Next.js, turbopack)
npm run build      # production build
npm test           # the full test suite — run this before you call anything done
```

**Environment** — `.env.local` at the repo root:

```
MONGO_URI=mongodb+srv://...      # REQUIRED. Must be a replica set (Atlas is one) — see §6.7
AUTH_SECRET=<48+ random bytes>   # REQUIRED. Signs the session cookie (§6.15).
                                 # Without it EVERY page returns 500 — the gate
                                 # fails closed rather than letting requests past
                                 # unverified. Generate one with:
                                 #   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
SIGNUP_DISABLED=true             # optional; closes self-serve sign-up so you
                                 # onboard firms yourself
RESEND_API_KEY=...               # optional, only for emailing an invoice
INVOICE_FROM_EMAIL=...           # optional; an address on a Resend-verified domain.
                                 # Without it, mail only reaches the Resend account owner.
NEXT_PUBLIC_AI_IMPORT_URL=...    # optional; the backend/ invoice-image service
```

**First run.** There is no seeded account, by design — a shipped
`admin/admin123` is the first thing anyone tries on a deployed app. Go to
`/signup`: it creates the firm and its first owner together and signs you in.
Everything else redirects to `/login`.

**Upgrading a database that predates multi-tenancy.** Existing rows have no
`companyId`, and every query now filters on it, so until you run this the old
books are *invisible — not lost*:

```bash
npm run adopt:tenant          # dry run: shows what it would adopt
npm run adopt:tenant:apply    # backs up first, then stamps every row
```

The Python AI-import service in `backend/` is separate and optional:

```bash
cd backend && pip install -r requirements.txt && uvicorn app:app --reload
# needs GOOGLE_API_KEY in backend/.env
```

> `backend/requirements.txt` is UTF-16 encoded and `pip install -r` fails on
> Linux/CI. Re-save it as UTF-8 if you touch it.

---

## 3. Stack and hard constraints

- **Next.js 16 (App Router), JavaScript — not TypeScript.** Do not introduce
  `.ts`/`.tsx` files; keep the codebase in plain JS/JSX.
- **React 18.2.0.** Not 19. Do not use React 19-only APIs.
- **MongoDB + Mongoose 8.** No SQL, no Prisma.
- **Tailwind CSS 3** plus a hand-written component layer in `app/globals.css`
  (see §8.1). A few **shadcn/ui** primitives live in `components/ui/`.
  **MUI is installed and used only for icons** (`@mui/icons-material`) — do not
  build new UI with MUI components.
- **Path alias:** `@/*` → repo root. `import X from '@/lib/balance.mjs'`.
- `.mjs` files in `lib/` are **pure, dependency-free modules** that must run
  under bare `node` (the tests import them directly). **Never import Mongoose
  or a model into a `.mjs` file in `lib/`** unless it is already there —
  `lib/cashAccount.mjs`, `lib/itemLedger.mjs`, `lib/runningBalances.mjs`,
  `lib/tenantPlugin.mjs`, `lib/tenantRoute.mjs` and `lib/authServer.mjs` are
  the ones that do, and they are therefore not unit-testable. Each of them has
  its decisions split into a pure neighbour that *is* tested
  (`tenantPlugin` → `tenantScope.mjs`, auth → `roles/session/password`).
  Do the same if you add another.
- **Three modules have a runtime constraint beyond purity:**
  `lib/session.mjs` and `lib/roles.mjs` are imported by `middleware.js`, which
  runs on the **edge**, where `node:crypto` does not exist — that is why
  sessions are signed with Web Crypto (`crypto.subtle`) and why those two files
  import nothing at all. `lib/passwordRules.mjs` exists because the sign-up
  page is a client component and `lib/password.mjs` imports `node:crypto`,
  which cannot be bundled for a browser.
- `lib/tenantContext.mjs` uses `node:async_hooks`. It is **server-only** —
  never import it from a client component or from the middleware.
- Also shipped as an **Electron desktop app** (`main.js`) that simply loads the
  deployed Vercel URL in a window. A **Capacitor** config exists but is unused.
- `next.config.mjs` sets `eslint.ignoreDuringBuilds: true` — lint errors will
  not fail a build. Do not rely on lint to catch your mistakes.

---

## 4. Directory map

```
app/
  layout.js              Root layout: header, nav, SaleOptionProvider
  globals.css            Design tokens + the component class vocabulary (§8.1)
  page.js                Dashboard / home — nav tiles, master pickers, counts
  saleadd/               Sale invoice entry          ─┐
  salereturn/            Sale return entry            │ four near-identical
  purchaseadd/           Purchase invoice entry       │ ~1,100-line pages
  purchasereturn/        Purchase return entry       ─┘ (see §9.8 — change all four)
  invoice/               Printable invoice (loads by ?invoiceNo=N)
  invoice-range/         Batch print invoices over a date range
  ledger/                Party ledger report
  item-ledger/           Stock ledger report
  voucher/               Voucher register
  voucheradd/            Voucher entry
  customeradd/           Party master form
  itemadd/               Item master form
  setup/                 Feature toggles + the danger zone (§7)
  upload/                AI invoice-image import
  login/                 Sign-in
  signup/                Create a firm and its first owner
  api/<name>/route.js    All API routes (§7)
  api/auth/*             login, logout, register, me — the only unscoped routes

middleware.js            The gate. Runs at the EDGE on every request: verifies
                         the session cookie's signature and expiry, and whether
                         the role may reach the path. No database — see §6.15.

components/
  InvoiceDocument.jsx    The printable invoice body. `forwardRef`, props
                         `{ invoice, isRollStationary }` — takes a whole saved
                         invoice document and renders it. Shared by /invoice and
                         /invoice-range so a bill looks identical either way.
                         Derives its HSN summary and CGST/SGST split from
                         lib/hsnTotals.mjs and lib/gst.mjs rather than trusting
                         stored totals.
  PriceListMaster.jsx    Party price list entry grid (modal)
  HsnMaster.jsx          HSN master (modal)
  CustomerGroupMaster.jsx Customer group master (modal); Cash and Bank reserved
  PartyBalance.jsx       City + running balance, under a customer picker
  ItemStock.jsx          Current stock, under a selected invoice line
  UserMenu.jsx           Who is signed in, and sign out
  ui/                    shadcn primitives: button, input, dialog, popover, tabs…
  Backbutton / NextButton / ReloadButton / suspense wrappers

lib/                     ← THE DOMAIN LAYER. Read §6 before touching any of it.
  balance.mjs            Signed-balance arithmetic. The single source of truth.
  invoicePosting.mjs     What one invoice posts (deltas + ledger rows)
  voucherLedger.mjs      What one voucher posts
  itemLedger.mjs         Stock rows for an invoice      (imports Mongoose)
  runningBalances.mjs    Recompute stored running figures (imports Mongoose)
  cashAccount.mjs        Resolve the cash/bank account   (imports Mongoose)
  paymentType.mjs        Cash vs bank decision (pure)
  withTransaction.mjs    MongoDB transaction wrapper
  getNextInvoiceNo.js    Atomic invoice-number reservation
  gst.mjs                CGST/SGST split, GST state-code normalisation
  hsnTotals.mjs          HSN code-wise summary, derived from line items
  priceList.mjs          Party price list resolution
  company.mjs            ⚠ LEGACY. A hard-coded single firm's letterhead. With
                         more than one firm this is wrong — the letterhead
                         should come from the firm's `companies` row (§9.1)
  tenantContext.mjs      Which firm this request is for (AsyncLocalStorage)
  tenantScope.mjs        The scoping decisions, pure and tested
  tenantPlugin.mjs       Mongoose plugin: adds companyId and scopes every query
  tenantRoute.mjs        The one-line wrapper every API route uses
  roles.mjs              Roles, permissions, path → permission (pure, edge-safe)
  session.mjs            Signed session cookie (Web Crypto — edge-safe)
  password.mjs           scrypt hashing          (node:crypto, server only)
  passwordRules.mjs      The length rule alone   (browser-safe)
  authServer.mjs         requireAuth(): the database-backed guard
  mongodb.js             Cached connection
  localStorageHelper.js  Invoice draft persistence
  utils.js               `cn()` — clsx + tailwind-merge

models/                  Mongoose schemas (§5)
context/SaleOptionContext.js   Feature toggles, persisted to localStorage
scripts/                 Tests (*.test.mjs) and maintenance scripts (§10)
backend/                 FastAPI + Gemini invoice-image extraction (separate service)
```

---

## 5. Data model

Thirteen collections. **There are no foreign keys — parties and items are
joined by NAME**, which is why renames cascade (§6.10) and why name uniqueness
matters.

**Every collection below except `companies` and `users` carries a required,
indexed `companyId`.** You will not find it in the schema files: it is added
by `tenantPlugin` (§6.14), which also scopes every query to it. Do not add it
by hand, and do not filter on it by hand either.

### `customers` (`models/custModel.js`) — parties AND cash/bank accounts

Both customers and suppliers live here, and so do the business's own cash and
bank accounts (distinguished by `group` being `cash` or `bank`).

| Field | Notes |
|---|---|
| `name` | **The join key used across every other collection.** No unique index — see §9 |
| `short`, `email`, `phone`, `address`, `city`, `state`, `pincode` | contact |
| `group` | free text; `'cash'` / `'bank'` give the account special meaning |
| `gstIn`, `pan`, `aadhar`, `stateCode` | `stateCode` is a **String** ("07", not 7) |
| `dealerType`, `discount`, `interest`, `bank` | trade terms |
| `openingBal` / `openingMode` | **Signed.** User-owned. Editing it adjusts `lastBal` by the difference |
| `lastBal` / `lastMode` | **Signed. SYSTEM-OWNED — forms must never write this.** The live running balance |
| `lastYearBal` / `lastYearMode` | User-owned reference data. No effect on anything |

### `items` (`models/itemModel.js`)

`name` (**join key**, no unique index), `hsn`, `short`, `group`, `unit`,
`mrp`, `cost`, `salePrice`, `purchasePrice`, `discount`, `gst`, `weight`,
`itemType`, `openingQuantity`, `lastQuantity`.

> **`lastQuantity` is dead data.** Nothing updates it from stock movement; only
> the item form writes it. Real stock comes from the item ledger. Never display
> it as "current stock".

### `Invoice` (`models/invoiceModel.js`)

One document per sale / purchase / return.

- `invoiceNo` — **Number, unique index.** Globally unique across all four types.
- `type` — `"Sale"` or `"Purchase"`; `return` — Boolean. **Together these four
  combinations define every document type.**
- `date`, `customer: { name, phone, email, custId }`
- `items[]` — `{ name, quantity, cost, discount, total, taxableAmount, gstAmount, hsn, gstRate, description }`
- `hsnTotals[]` — `{ hsn, gstRate, amount, total }`. ⚠ **`amount` is the GST
  charged, not the taxable value.** Taxable = `total - amount`. Prefer deriving
  this with `lib/hsnTotals.mjs` rather than trusting the stored array.
- Money: `totalAmount`, `finalAmount`, `received`, `balanceDue`
- `paymentType` (`Cash`/`Cheque`), `stateOfSupply`, `taxType` (`local`/`central`), `gst`
- Dispatch: `shippedTo`, `dispatchFrom`, `transport`, `grNo`, `grDate`,
  `pvtMark`, `caseDetails`, `freight`, `weight`, `orderNo`, `orderDate`,
  `ewayBillNo`, `ewayBillDate`
- `partyTaxes[]` — extra overheads `{ name, rate, Amount, total }`

### `Ledger` (`models/ledgerModel.js`) — the party ledger

| Field | Meaning |
|---|---|
| `customerName` | **whose ledger this row belongs to** — the grouping key |
| `account` | the **contra** side of the same row (e.g. "Sales Account", or the cash account) |
| `debit` / `credit` | this party's side |
| `balance` | running figure, recomputed by `lib/runningBalances.mjs` |
| `narration`, `paymentType`, `date` | |
| `voucherId` | the Invoice or Voucher `_id` that wrote the row. **This is how rows are found and deleted.** |

### `ItemLedger` (`models/itemLedgerModel.js`) — stock ledger

`itemName` (join key), `invoiceNo` (**String** here, Number on Invoice),
`date`, `typeOfVoucher`, `partyName`, `receiptQuantity`, `issueQuantity`,
`balanceQuantity`.

### `Voucher` (`models/voucherModel.js`) — receipts and payments

`acName` (the account money moved through), `date`, `paymentType`, `narration`,
`againstBill`, `acType`, and `customers[]` of `{ name, debit, credit, custId, narration }`.

### `pricelists` (`models/priceListModel.js`) — per-party item rates

`party` (ObjectId → customers), `partyName`, `date`, `remark`, and `items[]`:

`{ itemId, name, unit, salePrice, mrp, discount }`

- `salePrice` / `mrp` are **nullable** — `null` means "use the item master",
  which is **not** the same as `0` (zero means free).
- `discount` is **one** percentage.
- `dis1`/`dis2`/`dis3` and `price` are **legacy fields**, still declared so old
  documents load. Nothing writes them. `lib/priceList.mjs` collapses an old
  three-discount chain into the one equivalent percentage.

### `hsn`, `Counter`, `TotalSale`

- `hsn`: `hsncode`, `hsnname`, `gst`, `gstunit`. Unique per firm
- `Counter`: `{ name, value }` — only `name: 'invoiceNo'` is used. Unique per
  firm, so each firm's numbering runs independently
- `TotalSale`: legacy, effectively unused. The only model with no tenant plugin

### `companies` (`models/companyModel.js`) — the tenant

One row per subscribing firm: `name`, `gstin`, `phone`, `email`, `address`,
`city`, `state`, `stateCode`, `pincode`, bank details, `active`.

This is what `lib/company.mjs` used to be as a constant. Deliberately **not**
unique on `name` — two unrelated shops may genuinely share one.

### `users` (`models/userModel.js`) — who can sign in

`email` (lowercased), `name`, `passwordHash` (`select: false`, so it is never
returned unless asked for), `role`, `companyId`, `tokenVersion`, `active`,
`lastLoginAt`.

A user belongs to exactly **one** firm; staff at two firms get two accounts.
`{ companyId, email }` is unique, case-insensitively — scoped to the firm, not
global, so one address can be used at two firms. `tokenVersion` is the
revocation handle: bumping it invalidates every session that user holds (§6.15).

---

## 6. The rules — DO NOT BREAK THESE

**This is the most important section of the file.** Everything below was
written to fix a real bug that corrupted real books. If you are changing
anything that touches money or stock, read it all.

**The governing principle: one rule, one place.** Creating, editing and
deleting a document must derive their figures from the *same function*. Every
serious bug this project has had was two code paths computing the same thing
differently and drifting apart.

### 6.1 Balances are signed

`lib/balance.mjs` is the single source of truth.

```
lastBal > 0  →  Dr  (the party owes us / receivable)
lastBal < 0  →  Cr  (we owe the party / payable)
```

`lastMode` is a **denormalised cache of the sign**, never an independent input.
Always change a balance through `applyDelta()`, `setBalance()` or
`balancePipeline()` so the two cannot drift. The UI shows magnitude + a Dr/Cr
dropdown; convert at the boundary with `toSigned()` in and `toDisplay()` out.

Use `round2()` on every money figure. Floats drift otherwise.

### 6.2 An invoice posts TWO legs

This is the rule most likely to be broken by someone "simplifying" things.

| Leg | Effect |
|---|---|
| **Document** | The party moves by the **full** invoice value, against Sales/Purchase Account |
| **Receipt** | Anything paid at the counter moves the party **back** and lands on cash/bank |

They net to `balanceDue`. Posting only the net is what once made fully-paid
sales vanish from the books entirely — no party movement, no cash, no trace.

Direction, from `invoiceDelta({ type, isReturn, amount })`:

| Document | Party balance | Stock |
|---|---|---|
| Sale | **+** amount | out |
| Sale return | **−** amount | in |
| Purchase | **−** amount | in |
| Purchase return | **+** amount | out |

### 6.3 Stock direction comes from the same table

`isInwardStock({ type, isReturn })` in `balance.mjs` sits **deliberately beside**
`invoiceDelta` and reads the same two inputs. These two rules drifted apart
once — the stock side keyed off a `returnType` field no caller ever sent, so
both return types moved stock backwards while the money was right. Keep them
together.

### 6.4 Vouchers balance; invoices do not

A voucher writes one row per party line **plus one aggregate row** for the
account the money moved through, on the opposite side. It nets to zero.

An invoice does **not**: "Sales Account" and "Purchase Account" are only labels
in the `account` column — there is no Customer document holding them, and no
counter-row. **This app is a subsidiary ledger (parties, cash/bank, stock), not
a general ledger. There is no trial balance, P&L or balance sheet.** Do not
promise one without building the nominal-account side first.

### 6.5 Derive figures; never trust the client

`balanceDue` is recomputed server-side as `round2(finalAmount - received)` in
both `save-invoice` and `sale-alter`, and `delete-invoice` reverses using
`invoicePostingDeltas()` — the same function that posts.

Reversing by a stored figure while posting from a computed one leaves
permanent drift whenever a client's arithmetic disagrees. The AI import path
(`app/upload/`) passes an extractor's numbers straight through, so this is not
hypothetical.

### 6.6 Running balances are recomputed, not patched

`Ledger.balance` and `ItemLedger.balanceQuantity` are rewritten **end to end for
the affected account or item**, in `(date, _id)` order, from the opening
position — `lib/runningBalances.mjs`.

Patching one row is wrong twice over: same-day rows have no defined order, and
a back-dated entry never rewrites what follows it. Call
`recomputeLedgerBalances()` / `recomputeItemBalances()` after **any** write that
touches ledger or stock rows.

### 6.7 Every money write is in a transaction

Wrap it in `withTransaction()` from `lib/withTransaction.mjs`.

- **Every query inside the callback must be passed `{ session }`.** One that
  isn't runs outside the transaction — it won't roll back and can't see the
  uncommitted writes around it. This is the single easy mistake here.
- Throw `AbortTransaction(payload, status)` to reject the work deliberately and
  still control the HTTP response.
- **Requires a replica set.** Transactions do not exist on a standalone
  `mongod`. Atlas is always a replica set. There is deliberately **no silent
  non-transactional fallback** — adding one would reintroduce exactly the
  partial-write corruption this exists to prevent.
- `withTransaction` retries on transient errors, so the callback must be safe
  to run more than once.

### 6.8 Ledger rows are found by `voucherId`, never by narration

`delete-invoice` once also matched rows whose narration ended with
"Invoice No: 12". A user typing "Against Invoice No: 12" on a *receipt voucher*
then lost that voucher's row when the invoice was deleted — and the party's
balance disagreed with its own ledger permanently. Match on `voucherId` only.

### 6.9 GST

- Per line: `taxable = cost × qty − discount%`, `gst = taxable × rate/100`,
  `total = taxable + gst`.
- `taxType: 'local'` → CGST + SGST; `'central'` → IGST.
- **Split with `splitGst()` from `lib/gst.mjs`, never `(total/2).toFixed(2)`
  twice** — that disagrees with the tax charged on half of all amounts, by a
  paisa, on a document that must foot.
- `taxType` is a **manual** radio button, not derived from `stateOfSupply`.
  Choosing it wrong produces a legally wrong invoice.
- GST state codes are two-digit **strings** — Delhi is `"07"`. Normalise with
  `normalizeStateCode()`.
- The HSN summary is **derived from the line items** by `lib/hsnTotals.mjs`.
  Use it rather than the stored `hsnTotals` array, which was being silently
  truncated by strict mode on older documents.
- Use `??` not `||` when falling back on `taxableAmount` or `total` — `0` is a
  real value (a free line), and `||` would re-charge it at full price.

### 6.10 Renames cascade

Because joins are by name, renaming a party or item must update every
collection that names it, inside one transaction:
`Ledger.customerName`, `Ledger.account`, `ItemLedger.partyName`/`itemName`,
`Invoice.customer.name`, `Voucher.acName`, `Voucher.customers[].name`.
See `api/customer-alter` and `api/item-alter` for the pattern. A rename onto an
existing name is refused (409) — merging two parties' history is never intended.

### 6.11 Payment type decides which account receives the money

`resolvePaymentAccount(paymentType, session)` in `lib/cashAccount.mjs`:
exact name match → group (`cash`/`bank`) → default name → create. Cash and
cheque must not land in the same account.

### 6.12 Invoice numbers: peek vs reserve

`GET /api/next-invoice-no` is a **peek** for display — opening a form and
walking away must not burn a number. The number is only claimed on save, where
`save-invoice` re-checks it and reserves atomically via `getNextInvoiceNo()`.

### 6.13 Price lists

`lib/priceList.mjs`. `resolveItemPricing(item, priceList)` returns
`{ rate, discount, mrp, unit, source }`, falling back to the item master
**field by field** — a row with only a discount still bills at the master rate.

### 6.14 Every query is scoped to one firm — automatically

**The single most important thing to understand before touching a route.**

When this became multi-tenant there were **135 model call sites across 49
files**. Adding `companyId` to each by hand would have been 135 chances to miss
one, and a missed filter is invisible until a customer sees another customer's
ledger. So scoping is not written at the call sites at all:

| File | Does |
|---|---|
| `lib/tenantContext.mjs` | Holds the current firm in an `AsyncLocalStorage` |
| `lib/tenantPlugin.mjs` | Applied to all 11 tenant schemas. Adds `companyId`; injects it into the filter of every read, update and delete; stamps it onto every create |
| `lib/tenantRoute.mjs` | The wrapper that establishes the firm for one request |
| `lib/tenantScope.mjs` | The decisions, pure and tested |

So a route does not remember to scope its queries — **it cannot forget**:

```js
// get-item/route.js. This reads only the signed-in firm's items.
const item = await Item.find({});
```

**The safety property: a query with no firm in context throws.** It does not
fall back to "all firms". A route that is not wrapped fails on its first
request with a 500 naming the collection, which gets noticed — as opposed to a
silent cross-tenant read, which does not.

**Rules:**

1. **Every route under `app/api/` must export through `tenantRoute`.** The
   pattern is a plain handler plus one export:
   ```js
   import { tenantRoute } from "@/lib/tenantRoute.mjs";

   async function handleGET(req, auth) { /* auth.companyId, auth.role, auth.userId */ }

   export const GET = tenantRoute(handleGET);
   ```
   The only exemptions are `app/api/auth/*`, because signing in happens before
   anyone belongs to a firm.
2. **Every tenant model must call `schema.plugin(tenantPlugin)` before it is
   compiled.** Only `companyModel`, `userModel` and the dead `totalSales` do not.
3. **Never write `companyId` into a filter yourself.** The plugin applies it
   last, so a hand-written one is at best redundant and at worst misleading.
4. **Never use `estimatedDocumentCount()` on a tenant collection.** It reads
   collection metadata, so it cannot be scoped at all.
5. `runAcrossAllTenants()` exists for the migration script and nothing else.
   It is deliberately awkward to type and easy to grep for.

`scripts/tenant-scope.test.mjs` statically sweeps every route file and every
model and **fails the build if one is unwrapped or unplugged.** Run `npm test`
after adding either.

Unique indexes are **per firm**, not global: `invoiceNo`, `hsncode`, group
names, state names and codes, and the invoice counter are all
`{ companyId, <field> }`. A global unique meant the second firm to open could
not write invoice 1.

### 6.15 Authentication and roles

Two separate questions, deliberately answered in two places:

| Question | Answered by |
|---|---|
| Are you signed in, and to which firm? | `lib/session.mjs` |
| May your role do this? | `lib/roles.mjs` |

**Sessions are stateless.** A signed cookie (`vyapaar_session`, httpOnly,
sameSite lax, secure in production) carrying `{ uid, cid, role, v, exp }`,
HMAC-signed with `AUTH_SECRET`. No sessions collection, so checking a request
costs no database round trip.

**Two layers, and the difference matters:**

- **`middleware.js` is the gate.** Edge runtime. Checks signature, expiry and
  role-for-path. It *cannot* check whether the user still exists, is still
  active, or has been revoked — that needs a database.
- **`requireAuth()` in `lib/authServer.mjs` is the lock.** Called by
  `tenantRoute` on every request. Re-reads the user, confirms the firm matches,
  confirms `tokenVersion` still matches, and checks the permission against the
  **role on the user record**, never the one in the token — so a role changed
  mid-session takes effect on the next request, not in a week.

**Roles:**

| Role | Holds |
|---|---|
| `owner` | Everything, including Setup and the danger zone |
| `accountant` | Invoices, vouchers, ledger, masters, reports |
| `biller` | Invoices, and reading the masters a bill needs. No ledger, no master edits, no Setup |

`permissionForPath()` maps a path to the permission it demands. **An
unlisted `/api/` path defaults to `setup:write` — owner-only.** A route added
later and never listed fails closed rather than being wide open. Add your route
to `PATH_RULES` when you add it.

**Revocation.** Signing out only clears the cookie; the token stays valid until
it expires. To actually lock someone out, bump their `tokenVersion`.

**Passwords** are scrypt (`node:crypto`, no native build to break on Windows),
with the cost parameters stored inside the hash so raising them later does not
lock anyone out. Sign-in verifies against a dummy hash even when no account
exists, so a wrong address and a wrong password take the same time.

---

## 7. API routes

All under `app/api/<name>/route.js`. **All are wrapped in `tenantRoute`
(§6.14) except `app/api/auth/*`** — they require a session, check the path's
permission, and see only the signed-in firm's rows.
Most mutations are `POST`, including deletes (id in the query string).

### Auth
| Route | Method | Notes |
|---|---|---|
| `auth/register` | POST | Creates a firm and its first owner together, in one transaction, and signs them in. Honours `SIGNUP_DISABLED` |
| `auth/login` | POST | Same message for every failure. Upgrades an old password hash while the plain password is in hand |
| `auth/logout` | POST | Clears the cookie. Does **not** revoke the token — see §6.15 |
| `auth/me` | GET | Who am I, which firm, and the permission list the nav uses to hide what you cannot reach |

### Invoices
| Route | Method | Notes |
|---|---|---|
| `save-invoice` | POST | Create. Transactional. Derives `balanceDue`, posts both legs, writes ledger + stock, recomputes |
| `sale-alter` | POST | Edit. Reverses the old posting and applies the new one. Looks the row up by `originalInvoiceNo` because `invoiceNo` is itself editable |
| `delete-invoice` | POST `?id=<invoiceNo>` | Reverses via `invoicePostingDeltas`, deletes rows by `voucherId` |
| `invoice` | POST `{value:<no>}` | Fetch one by number |
| `get-invoice` | GET | **All** invoices |
| `invoices-by-date` | GET `?from&to&type` | Date range, capped at 500 |
| `next-invoice-no` | GET | Peek, not a reservation |

### Vouchers
`voucher-add` (POST), `voucher-alter` (POST), `delete-voucher` (POST `?id`),
`voucher` (POST, lookup), `get-voucher` (GET, all). All transactional; all
derive their balance deltas from `buildVoucherBalanceDeltas()`.

### Masters
`customer-add`, `customer-alter`, `delete-cust`, `customer` (lookup),
`get-customer`; `item-add`, `item-alter`, `delete-item`, `item`, `get-item`;
`hsn-add`, `hsn-update`, `delete-hsn`, `get-hsn`;
`price-list-add`, `price-list-update`, `delete-price-list`, `get-price-list`.

Delete routes refuse with **409** when history references the record:
`delete-cust` checks invoices, vouchers and ledger rows; `delete-hsn` checks
items using that code; `delete-item` checks invoices by name and refuses
when stock movements exist (§9.7).
`delete-price-list` is the exception and always succeeds, because invoices keep
the rate they were billed at and nothing else references a list.

### Reports and other
`ledger` (GET `?customerId=<id|0>`), `item-ledger` (GET `?itemId=<id|0>`),
`send-email` (POST, Resend),
`clear-all-data` (DELETE — body `{"confirm": "DELETE ALL DATA"}`),
`clear-transactions` (DELETE — body `{"confirm": "CLEAR TRANSACTIONS"}`),
`item-stock` (GET — current stock per item, summed from the stock ledger).

**The danger zone** lives in `/setup` and is owner-only. Two buttons, two
different confirmation phrases on purpose, so habit from typing one cannot fire
the other:

- **Clear Transactions** deletes invoices, vouchers, ledger rows, stock rows and
  the counter, keeps every master, and **resets each party's `lastBal` to its
  opening balance**. That last step is not optional: `lastBal` accumulates from
  the documents being deleted, so skipping it leaves parties owing money for
  invoices that no longer exist.
- **Clear All Data** also deletes the masters.

Both are scoped by the plugin, so they empty only the caller's own books.

**Response shape.** `{ success: true, ... }` or `{ success: false, error }`.
Not perfectly consistent across older routes; follow the one you are editing.

---

## 8. Frontend conventions

### 8.1 Use the CSS vocabulary — do not hand-roll Tailwind for everything

`app/globals.css` defines a component layer. **Use these classes.** A new page
built from raw Tailwind will not match the app.

```
Layout     .page-shell  .page-shell-wide  .page-header  .page-title
           .page-subtitle  .section-title
Surfaces   .panel  .panel-head  .panel-title  .panel-body
Forms      .field  .field-label  .field-input  .field-input-sm
           .field-select  .field-check  .field-hint
Buttons    .btn + .btn-primary | .btn-secondary | .btn-ghost
                 | .btn-success | .btn-danger ;  .btn-sm  .btn-icon
Tables     .table-wrap  .data-table  (thead/tbody/tfoot are styled for you)
           .data-table .row-opening   — highlights an opening-balance row
Numbers    .num (right + tabular)  .money-dr (green)  .money-cr (red)
Reports    .doc-sheet  .doc-head  .doc-org  .doc-meta  .doc-kind
Modals     .modal-overlay  .modal-card  .modal-title   (non-Radix prompts)
Home       .nav-tile  .nav-tile-icon  .stat-card  .stat-label  .stat-value
Misc       .chip  .empty-state  .no-print
Print      .invoice-doc  .invoice-print-page  .inv-table  .inv-scroll
           .pdf-export  .pdf-export-wide
```

Colours come from HSL CSS variables with a full dark set — use
`bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`,
`bg-primary`, `text-destructive`, `bg-accent`, etc. **Never hard-code a hex
colour.** Every figure in the app lines up on the decimal: put `.num` on money
cells.

### 8.2 Page template

```jsx
'use client';
import React, { useEffect, useState } from 'react';

export default function MyPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/get-item')
      .then((r) => r.json())
      .then((d) => setRows(d.item || []))
      .catch(() => alert('Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="page-shell text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <h1 className="page-title">My Page</h1>
          <p className="page-subtitle">What this screen is for.</p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head"><h2 className="panel-title">Rows</h2></div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Name</th><th className="num">Rate</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._id}>
                    <td>{r.name}</td>
                    <td className="num">{Number(r.salePrice || 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <div className="empty-state">Nothing here yet.</div>}
        </div>
      </section>
    </div>
  );
}
```

### 8.3 Patterns in use

- **Every page is `'use client'`** (all 17 of them, including `/login` and
  `/signup`). Data is fetched in `useEffect` from `/api/*`. There is no
  server-component data fetching, no SWR, no React Query.
- A client page **cannot import anything that reaches `node:*` or Mongoose.**
  `/signup` takes its password rule from `lib/passwordRules.mjs` rather than
  `lib/password.mjs` for exactly this reason — the latter imports
  `node:crypto` and the page would not build.
- `components/UserMenu.jsx` in the header asks `/api/auth/me` for who is signed
  in. It renders nothing when signed out, so the sign-in pages keep a bare
  header. Hiding a nav link by permission is tidiness only — **every route
  checks for itself; a hidden link is not a locked door.**
- Anything reading `useSearchParams` must be wrapped in `<Suspense>` — see
  `components/suspense.jsx`, `LedgerSuspense.jsx`, `VoucherSearchparams.jsx`.
- `alert()` is the error-reporting mechanism throughout. Not pretty, but
  consistent; do not introduce a toast library for one page.
- **Feature toggles** live in `context/SaleOptionContext.js`, persisted to
  `localStorage`, edited on `/setup`: `description`, `shipped`, `dispatch`,
  `calculateByPack`, `rollStationary`, `usePriceList`.
- Invoice drafts persist to `localStorage` via `lib/localStorageHelper.js`.
- **Context subtext under a picker** is a shared pattern, not a one-off:
  `components/PartyBalance.jsx` under a customer dropdown shows
  `Ludhiana · Current balance: ₹1,500.00 Dr (owes you)`, and
  `components/ItemStock.jsx` under each selected invoice line shows
  `In stock: 115 PCS`. Both are `.field-hint`, green for Dr / in stock, red
  for Cr / out of stock. Two rules they share and a new one should copy:
  **read from the master, not from the document** (an invoice embeds only
  `{name, phone, email, custId}`, so reading the balance off it would show a
  figure when writing a bill and nothing when editing one), and **show nothing
  rather than a confident zero** when the record cannot be found.
  The wording is account-aware: a cash or bank account reads `in hand` /
  `in account`, never `owes you` — the drawer does not owe you the money, it
  *is* the money.
- **The print page loads by number** — `/invoice?invoiceNo=123` — and fetches
  the saved document. It used to carry the whole invoice in the query string,
  which blew past the request-header limit at ~20 line items. Never put document
  data back in the URL.
- PDF export: `html2canvas` + `jsPDF`, with the `.pdf-export` class pinning the
  node to paper width during capture so a phone produces the same sheet as a
  desktop.

---

## 9. Known issues, drift and landmines

Honest list. Some are deliberate prototype trade-offs; none are secret.

**Blocking**

1. **The letterhead is still one hard-coded firm.** `lib/company.mjs` holds a
   single firm's name, address and GSTIN, and every printed invoice reads it —
   so with more than one firm on the instance, **every firm's bills print the
   wrong name.** The fix is to read the signed-in firm's `companies` row
   instead and pass it into `InvoiceDocument`. Cosmetic rather than a data
   leak, but not shippable. ⚠ Its `gstin` and `phone` are also still blank,
   and a GST invoice without a GSTIN is not a valid tax invoice.
2. **Tenant isolation has not been exercised against a real database.** The
   scoping rules are unit-tested and the audit proves every route and model is
   wired (§10), but nobody has yet signed up a second firm and confirmed its
   customer list comes back empty. **Do that before onboarding a real second
   customer.**
3. **There is no way to add a second user from the UI.** An owner is created at
   sign-up; accountant and biller accounts can currently only be made directly
   in the database. An owner-only Staff page is the missing piece — the
   permission (`user:manage`) and the route rule for `/users` already exist.
4. ~~There is no authentication anywhere.~~ **Fixed.** Sign-in, roles, a gate
   in `middleware.js` and per-firm scoping on every query — §6.14, §6.15.

**Data integrity**

5. **`customers.name` and `items.name` are indexed but NOT unique.** They are
   the join key for every other collection, so a duplicate makes two parties'
   ledgers ambiguous permanently. Duplicates are refused at the application
   level in `customer-add` / `item-add` / `*-alter` (409, case-insensitive),
   which is reliable. A true unique index is still worth adding — but
   de-duplicate the existing data first, because Mongo builds a unique index
   over dirty data by silently failing, leaving you believing you are
   protected. The schema comments say the same.
6. ~~Almost nothing is indexed.~~ **Fixed.** `Ledger`, `ItemLedger`,
   `Invoice`, `Voucher`, `customers` and `items` now carry indexes on the
   fields the reports and the posting routes actually query. New indexes build
   on first connection after deploy.
7. ~~`delete-item` is weaker than its siblings.~~ **Fixed.** It now guards by
   item **name** (so AI-imported lines count) and refuses when stock movements
   exist.

**Duplication — four copies of the billing screen**

8. `saleadd`, `salereturn`, `purchaseadd` and `purchasereturn` are four
   **~1,200-line copies of the same screen**, currently differing only in the
   two or three lines that set `type`, `return` and the page heading. All four
   use `resolveItemPricing()`, take the party's latest price list automatically,
   honour the `usePriceList` toggle in Setup, and show the party's balance and
   each line's stock (§8.3).

   They are in sync today, but nothing keeps them that way — **every change
   must be made four times, and they have drifted before.** The real fix is to
   collapse them into one component parameterised by
   `{ type, isReturn, title, subtitle }`; ~3,300 duplicated lines go away and
   the drift cannot recur.

   *(`saleadd/page.js` is LF, the other three are CRLF, so a raw `diff` looks
   like every line changed. Compare with `diff <(tr -d '\r' < a) <(tr -d '\r' < b)`.)*

**Smaller things**

9. **`items.lastQuantity` is never maintained and must never be read as stock.**
   It looks like the counterpart of `customers.lastBal`, but nothing in the
   posting path writes it — it is typed into the item master by hand and is
   stale the moment anything is bought or sold. Current stock is
   `openingQuantity + every receipt − every issue`, summed from the stock
   ledger: `lib/itemStock.mjs` and `/api/item-stock`. Summed rather than read
   off the newest row's `balanceQuantity`, because that column is a cache a
   back-dated entry leaves stale.
10. ~~The business's details are hard-coded in two places and disagree.~~
    Partly fixed: they are now in one place, `lib/company.mjs` — but that place
    is still a constant rather than the firm's own record. See item 1.
11. ~22 `console.log` calls and ~55 `alert()`s in production paths. `alert()` is
    the app's only error-reporting mechanism — including on the sign-in pages.
12. `save-invoice` spreads `{...body}` into `Invoice.create` — mass assignment.
    The tenant plugin stamps `companyId` afterwards, so a client cannot inject
    another firm's id, but the rest of the field surface is still open.
13. Master-data routes (`customer-add`, `item-add`, `hsn-*`, `delete-item`,
    `delete-hsn`) are **not** transactional. The money paths all are.
14. Deployment URLs still disagree between `main.js` (Electron →
    `vyapaar-ten.vercel.app`) and the FastAPI CORS list
    (`vyapaar-aspx.vercel.app`). The AI-import URL is now configurable via
    `NEXT_PUBLIC_AI_IMPORT_URL` (defaulting to the Render deploy).
15. `capacitor.config.ts` still says `com.example.app`; `README.md` is the
    untouched `create-next-app` template.
16. The Electron build (`main.js`) loads the deployed URL in a window, so it
    now shows the sign-in page like any browser. Nothing stores a session for
    it beyond the embedded browser's own cookie jar.

---

## 10. Tests and maintenance scripts

```bash
npm test
```

Runs **18 suites** in `scripts/`. **Run it after any change to `lib/`, to a
posting route, or after adding any route or model at all** — two of the suites
are static sweeps that fail the build on an unwrapped route. The suites that
matter most:

| Suite | Guards |
|---|---|
| `auth.test.mjs` | Roles, path permissions, password hashing, session signing. Includes the cases that must fail: a tampered token, an expired one, a biller reaching the ledger, an unlisted route falling open |
| `tenant-scope.test.mjs` | Tenant scoping — including two firms in flight at once not seeing each other. **Statically sweeps every route file and every model and fails if one is unwrapped or unplugged** |
| `clear-transactions.test.mjs` | That no master is ever in the delete list, and that balances go back to opening |
| `item-stock.test.mjs` | Stock is opening + receipts − issues, and `lastQuantity` is never the answer |
| `party-balance.test.mjs` | The balance shown on a bill resolves from the master, not the invoice snapshot |
| `posting-invariants.test.mjs` | Replays the routes against an in-memory store. Asserts that posting-then-deleting leaves balances untouched and no rows behind, that every account's balance equals its own ledger rows, and that edits cancel exactly |
| `posting-consistency.test.mjs` | Create/edit/delete derive the same figures |
| `invoice-posting.test.mjs` | The two-leg posting rule |
| `voucher-ledger.test.mjs` | Voucher rows and deltas |
| `price-list.test.mjs` | Rate/discount resolution, legacy chain collapse |
| `backfill-hsn-totals.test.mjs` | HSN summary derivation |
| `clear-zero-units.test.mjs`, `migrate-balances.test.mjs`, `rebuild-voucher-ledger.test.mjs` | The migration scripts |

Tests are plain `node:assert` with a tiny `test()` helper — no Jest, no Vitest.
They import `lib/*.mjs` directly, which is why those files must stay free of
Mongoose. `migrate-balances.test.mjs` and `rebuild-voucher-ledger.test.mjs` do
need `mongoose` installed.

**When you fix a bug in posting logic, add a case to
`posting-invariants.test.mjs`, then verify the test fails without your fix.**
A test that cannot fail is worth nothing.

**Maintenance scripts** all follow one pattern: dry-run by default, `--apply` to
commit, and a timestamped JSON backup under `backups/`.

```bash
npm run adopt:tenant                # stamp pre-tenancy rows with a companyId (§2)
npm run migrate:balances            # then :apply
npm run rebuild:voucher-ledger      # rebuild ledger rows from vouchers
npm run backfill:hsn-totals         # repair hsnTotals on old invoices
npm run migrate:phone               # phone/pincode Number -> String
npm run blank:zeros                 # clear meaningless zero defaults
npm run seed:groups                 # customer group master, incl. Cash and Bank
npm run seed:states                 # GST state master
node scripts/check-duplicates.mjs   # report duplicate names in every master
                                    # (no npm alias; the only one without one)
npm run clear:zero-units
npm run reset:data                  # add --keep-masters for transactions only
```

`adopt-tenant` refuses to guess when more than one firm exists: pass
`--company <id>`. Picking the wrong one hands one firm's ledger to another and
nothing in the app would flag it.

---

## 11. Recipes

### Add a new page

1. `app/<name>/page.js`, `'use client'`, default export.
2. Build it from the §8.2 template and the §8.1 class vocabulary.
3. Fetch from an existing `/api/*` route if one fits; otherwise add
   `app/api/<name>/route.js` returning `{ success, ... }` — **wrapped in
   `tenantRoute`** (next recipe).
4. **Add the page to `PATH_RULES` in `lib/roles.mjs`** with the permission it
   demands. An unlisted page is reachable by anyone signed in; an unlisted
   `/api/` route is owner-only.
5. Link it from `app/page.js` (a `.nav-tile`) and/or `app/layout.js` if it is
   top-level.
6. If it reads `useSearchParams`, wrap in `<Suspense>`.
7. If it shows money, use `.num` and `toFixed(2)`.
8. **Do not import `lib/password.mjs`, `lib/tenantContext.mjs` or anything that
   imports Mongoose into a `'use client'` page.** It will not bundle. Use
   `lib/passwordRules.mjs` for the password rule.

### Add a new API route

```js
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  // auth.companyId, auth.role, auth.userId, auth.company
  // Every model query here is already scoped. Do NOT add companyId yourself.
}

export const POST = tenantRoute(handlePOST);
```

Then add its path to `PATH_RULES` in `lib/roles.mjs`, and run `npm test` —
`tenant-scope.test.mjs` fails if the route is not wrapped.

### Add a field to an existing document

1. Declare it in the Mongoose schema. **Mongoose strict mode silently drops
   undeclared fields** — this has bitten this project at least three times
   (`hsnTotals.gstRate`, `hsnTotals.total`, `items.gstAmount`,
   `voucher.customers[].narration`, `shippedTo`/`dispatchFrom`).
2. Add it to the create route **and** the alter route. A field added to only
   one means editing a document wipes it.
3. Add it to the form, and to the print/report view if it should appear there.
4. Old documents will not have it — give it a default or handle `undefined`.

### Add a new master (collection)

Follow the HSN or price-list pattern: model in `models/`, four routes
(`-add`, `-update`/`-alter`, `delete-`, `get-`), a modal component in
`components/`, and wiring in `app/page.js`. Delete routes must refuse when
history references the record.

**The model must apply the tenant plugin before it is compiled:**

```js
import { tenantPlugin } from "../lib/tenantPlugin.mjs";
// ...schema definition...
thingSchema.plugin(tenantPlugin);

// Any unique index must be per firm, never global:
thingSchema.index({ companyId: 1, name: 1 }, { unique: true });

const Thing = mongoose.models.things || mongoose.model("things", thingSchema);
```

A global `unique: true` means the first firm to use a value takes it from every
other firm. `npm test` fails if the plugin is missing.

### Change anything about posting

1. Read §6 in full.
2. Change the rule in `lib/`, in **one** place.
3. Make sure create, edit and delete all call it.
4. Add a case to `posting-invariants.test.mjs`.
5. `npm test`.

### Change anything about auth or tenancy

1. Read §6.14 and §6.15 in full.
2. Put the decision in a **pure** module — `lib/roles.mjs`,
   `lib/tenantScope.mjs`, `lib/passwordRules.mjs` — not in the route, the
   plugin or the middleware. Those three are glue.
3. If the middleware will touch it, it must not import `node:*` or Mongoose.
4. Add a case to `auth.test.mjs` or `tenant-scope.test.mjs`, **then break the
   source and watch it fail.** A test that cannot fail is worth nothing, and
   here it is worth less than nothing — it is a false assurance about the thing
   keeping customers' books apart.

---

## 12. Prompt to paste into ChatGPT or Gemini

> I'm working on **Vyapaar**, a Next.js 16 + MongoDB GST billing app that
> serves several small Indian trading firms from one deployment. I'm pasting
> its context file below. Read it fully before answering — especially §6, and
> above all §6.14 (every query is scoped to one firm, automatically) and §6.15
> (auth and roles).
>
> Constraints: **JavaScript, not TypeScript. React 18. Mongoose. Tailwind plus
> the component classes in §8.1 — do not hand-roll styling or hard-code
> colours.** Every money write goes through `withTransaction` and passes
> `{ session }` to every query inside it. Create, edit and delete must derive
> their figures from the same function in `lib/`.
>
> **Multi-tenancy rules you must follow:** every API route exports through
> `tenantRoute`; every tenant model applies `tenantPlugin`; **never add
> `companyId` to a query filter yourself** — the plugin does it, and a
> hand-written one is at best redundant. Any unique index is
> `{ companyId, field }`, never global. New routes go in `PATH_RULES` in
> `lib/roles.mjs`.
>
> When you give me code, give me **complete files or exact
> find-and-replace blocks** — I'll be pasting them in by hand, so partial
> snippets with "..." are not useful. Tell me every file that needs to change,
> including the three sibling billing pages if you touch one of them (§9.8).
>
> My task: _<describe it here>_
>
> ---
>
> _<paste PROJECT_CONTEXT.md here>_

Then paste the specific source files the task touches. For a billing change
that is usually `lib/balance.mjs`, `lib/invoicePosting.mjs` and the route you
are editing; for a UI change, `app/globals.css` plus the nearest existing page
as a style reference; for anything touching routes or models, also
`lib/tenantRoute.mjs` and `lib/tenantPlugin.mjs` so the assistant copies the
right shape.
