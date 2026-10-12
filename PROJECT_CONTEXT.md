# Vyapaar — Project Context for AI Assistants

**Read this file before changing anything.** It is written for an AI assistant
(ChatGPT, Gemini, Claude, Copilot — any of them) that has no prior knowledge of
this codebase. It contains the architecture, the data model, the accounting
rules that must not be broken, the UI vocabulary, and the known landmines.

Paste the whole file, or paste §1–§6 plus the section relevant to your task.

**Last verified: 12 October 2026.** When you change the shape of the data, the
posting rules, the auth or tenancy rules, or the page conventions, update this
file in the same commit. A stale context file is worse than none — it will
confidently mislead.

> **If you read nothing else, read §6.14 and §6.15.** This app now serves more
> than one firm from one deployment. Every query is scoped to the signed-in
> firm, and the mechanism that does it is not obvious from reading a route.
>
> **Then read §6.16 and §6.17.** They are the two traps that have each cost a
> working day: dates are compared as IST calendar days by one of two different
> day numbers, and `Invoice.totalAmount` is **tax-inclusive** despite its name.

---

## 1. What Vyapaar is

A **GST billing and accounting app for small Indian trading businesses.** It
replaces desktop accounting software of the SIGFA/Tally generation, so its
screens deliberately echo those: dense keyboard-driven grids, Dr/Cr columns,
HSN summaries.

It is **multi-tenant**: one deployment serves many firms, each signing in to
see only its own books. Sign-in, roles and per-firm data scoping all exist —
see §6.14 and §6.15. §9 is the honest list of what is not finished.

**SIGFA is the specification, not an inspiration.** The client runs SIGFA
(a VB6 + Jet4 package) and this app is replacing it. Where a question comes up
about a feature's behaviour, its field names, its report headings or its
keyboard shortcuts, the answer is **whatever SIGFA does** — read out of
`SIGFA105.exe` and its `.mdb` files rather than chosen. §6.19 says how, and
several modules quote SIGFA's own SQL in their header to show why they net or
group the way they do. Do not redesign a screen that already matches it.

What it does:

| Area | Screens |
|---|---|
| Masters | Customers/parties, Items, HSN codes, Party price lists, Customer groups, GST states, Bill of Material |
| Transactions | Sale, Sale Return, Purchase, Purchase Return invoices |
| Orders | Sale/Purchase orders, order cancellation, order→invoice linkage, pending-order reports |
| Production | Production (from a BOM), Goods Issued, Goods Received, Production planning |
| Money | Receipt/payment vouchers, bill-wise adjustment ("Against Bill") |
| Books | Cash Book, Bank Book, A/C Ledger |
| Statements | Trial Balance, Trading A/c, Profit & Loss, Balance Sheet |
| Reports | Party ledger, Stock (item) ledger, Voucher register, Invoice print, Date-range print, Sales/Purchase Book, Party-wise, Item-wise |
| GST | GSTR-1 (e-return JSON + readable tables), GSTR-3, GSTR-3B |
| Analytics | Business dashboard — sales trends, receivables, payables, low stock, month-on-month |
| E-invoicing | IRN payload build, credential vault, per-invoice lock |
| Extras | AI invoice-image import (separate Python service), email invoice, today's-orders reminder |
| Account | Sign in, sign up a firm, company profile, staff management, change password, roles (owner / accountant / biller) |

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
SECRET_BOX_KEY=<32 random bytes> # optional; required ONLY to store e-invoicing
                                 # credentials. lib/secretBox.mjs seals the IRP
                                 # password with it; without the key the
                                 # company profile accepts everything else and
                                 # reports the credential as not set, rather
                                 # than storing a password in the clear.
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
  or a model into a `.mjs` file in `lib/`** unless it is already there. The
  documented exceptions — the only files allowed to touch a model — are:

  `cashAccount.mjs`, `itemLedger.mjs`, `runningBalances.mjs`,
  `tenantPlugin.mjs`, `tenantRoute.mjs`, `authServer.mjs`, `orderClaims.mjs`,
  `bomSave.mjs`, `glAccounts.mjs`, `openBillsFor.mjs`, `staffStore.mjs`,
  `productionSave.mjs`, `clearData.mjs`, `uniqueName.mjs`.

  They are therefore not unit-testable, and each has its decisions split into
  a pure neighbour that *is* tested (`tenantPlugin` → `tenantScope.mjs`, auth
  → `roles`/`session`/`password`, `bomSave` → `bom.mjs`, `staffStore` →
  `staffRules.mjs`, `productionSave` → `stockVoucher.mjs`). **Do the same if
  you add another**, and say so here — `tenant-scope.test.mjs` sweeps this list.
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
  page.js                Home — nav tiles, master pickers, counts
  saleadd/               Sale invoice entry          ─┐ all four are ~25-line
  salereturn/            Sale return entry            │ stubs around
  purchaseadd/           Purchase invoice entry       │ components/billing/
  purchasereturn/        Purchase return entry       ─┘ BillingScreen (§8.4)
  invoice/               Printable invoice (loads by ?invoiceNo=N)
  invoice-range/         Batch print invoices over a date range
  ledger/                Party ledger report       (?customerId=)
  item-ledger/           Stock ledger report       (?itemId=)
  voucher/               Voucher register
  voucheradd/            Voucher entry — incl. bill-wise adjustment (§6.18)
  account-book/          Cash Book / Bank Book / A/C Ledger
  financials/            Trial Balance, Trading A/c, P&L, Balance Sheet
  order/                 Order register and alter
  orderadd/              Sale/Purchase order entry
  order-report/          Pending orders — party-wise and item-wise
  bom/                   Bill of Material register
  bomadd/                BOM entry (nested formulas)
  production/            Production / Goods Issued / Goods Received slips
  production-plan/       What to make, and what it needs
  sales-report/          Sales & Purchase Book, Party-wise, Item-wise (§6.18)
  gst-return/            GSTR-1 e-return + GSTR-1/3/3B tables
  dashboard/             Business dashboard — trends, dues, stock, comparison
  customeradd/           Party master form
  itemadd/               Item master form
  company/               The firm's own profile + e-invoicing credentials
  staff/                 Owner-only: add and manage accountant/biller accounts
  change-password/       Forced on first sign-in for a staff account
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
  billing/BillingScreen.jsx
                         THE billing screen. One component, parameterised by
                         `typeKey` ('sale' | 'purchase' | 'saleReturn' |
                         'purchaseReturn'). `app/saleadd` is 22 lines around
                         it; the other three pages are not migrated yet (§9.8).
                         It was produced by TRANSFORMING saleadd/page.js
                         programmatically, not by retyping it, so the posting
                         behaviour is byte-for-byte what it always was.
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
  invoiceGl.mjs          Its general-ledger legs (sales, GST, party)
  glAccounts.mjs         Resolve/create a GL head     (imports Mongoose)
  glBackfill.mjs         Add GL legs to invoices raised before they existed
  voucherLedger.mjs      What one voucher posts
  billAdjust.mjs         "Against Bill": FIFO allocation of a receipt to open
                         bills, and every refusal, in words (§6.18)
  openBillsFor.mjs       A party's unsettled bills      (imports Mongoose)
  itemLedger.mjs         Stock rows for an invoice      (imports Mongoose)
  itemStock.mjs          Current stock = opening + receipts − issues (§9.9)
  runningBalances.mjs    Recompute stored running figures (imports Mongoose)
  cashAccount.mjs        Resolve the cash/bank account   (imports Mongoose)
  paymentType.mjs        Cash vs bank decision (pure)
  withTransaction.mjs    MongoDB transaction wrapper
  getNextInvoiceNo.js    Atomic invoice-number reservation
  getNextOrderNo.js      …and for orders
  getNextProductionNo.js …and for each stock-voucher kind (§6.20)
  istDate.mjs            IST calendar days. TWO day numbers — read §6.16
  gst.mjs                CGST/SGST split, GST state-code normalisation
  hsnTotals.mjs          HSN code-wise summary, derived from line items
  uqc.mjs                The GST unit code, stamped onto each saved line
  placeOfSupply.mjs      Place of supply from the party master
  buyerSnapshot.mjs      The buyer block frozen onto an invoice at save
  priceList.mjs          Party price list resolution
  uniqueName.mjs         Case-insensitive name clash check (imports Mongoose)

  billingTypes.mjs       The 2×2 of type × return, and every route/title for it
  billingMath.mjs        recalcItem + buildHsnTotals, copied VERBATIM from the
                         pages, quirks preserved and documented (§9.17)
  billingKeys.mjs        SIGFA's keyboard shortcuts, and quick master creation

  orderStatus.mjs        Order lifecycle, cancellation, restore
  orderClaims.mjs        Which order line an invoice line fulfils (Mongoose)
  orderPrefill.mjs       Building a bill from an order
  orderReports.mjs       Pending orders, party-wise and item-wise (SIGFA's
                         exact column headings)
  todaysOrders.mjs       The once-a-day reminder of orders dated today

  bom.mjs                Bill of Material: nested explosion, wastage, by-product
  bomSave.mjs            BOM persistence                (imports Mongoose)
  stockVoucher.mjs       SIGFA's three stock MKEYs — FR Production, IS Goods
                         Issued, RS Goods Received — and their slip fields
  productionSave.mjs     Production/issue/receipt posting (imports Mongoose)
  productionPlan.mjs     What to make for pending orders, net of stock

  accountGroups.mjs      SIGFA's 35 account groups; which statement each is on
  accountBooks.mjs       Cash Book, Bank Book, A/C Ledger
  financials.mjs         Trial Balance, Trading A/c, P&L, Balance Sheet
  salesReports.mjs       Sales/Purchase Book (month, date or bill), Party-wise,
                         Item-wise. Quotes SIGFA's netting SQL (§6.18)
  gstReturns.mjs         GSTR-1 tables + the portal's JSON, GSTR-3, GSTR-3B
  dashboard.mjs          The business dashboard's arithmetic. Defers to
                         salesReports / lastBal / itemStock — never a second
                         opinion about the firm's money

  einvoicePayload.mjs    The IRP payload for one invoice
  einvoiceCredentials.mjs Which IRP credentials a firm has set
  einvoiceLock.mjs       An invoice reported to the IRP is read-only
  secretBox.mjs          AEAD seal for the stored IRP password

  staffRules.mjs         Who an owner may add, and what they may do to them
  staffStore.mjs         The ONLY door to `User`      (imports Mongoose)
  clearData.mjs          What the danger zone deletes  (imports Mongoose)
  indexAudit.mjs         Schema indexes against the ones the database has
  company.mjs            The firm's letterhead, read from its `companies` row
  partyBalance.mjs       The balance shown under a party picker
  customerGroups.mjs     Group master rules; Cash and Bank reserved
  states.mjs             GST state master
  phone.mjs, currency.mjs, blankZeros.mjs
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

Seventeen collections. **There are no foreign keys — parties and items are
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
`uqc`, `isService`, `mrp`, `cost`, `salePrice`, `purchasePrice`, `discount`,
`gst`, `weight`, `itemType`, `openingQuantity`, `lastQuantity`, `minQuantity`.

> **`lastQuantity` is dead data.** Nothing updates it from stock movement; only
> the item form writes it. Real stock comes from the item ledger. Never display
> it as "current stock".

- `uqc` is the **GST unit code** the IRP accepts (`KGS`, `NOS`, `MTR`…),
  deliberately not guessed from the free-text `unit`. `lib/uqc.mjs` stamps it
  onto every saved invoice line, so a bill keeps the code it was reported with.
- `minQuantity` is the **reorder level, and is optional with no default.** An
  item that has never had one set is left out of the dashboard's "below
  minimum" alert rather than compared against an invented number — a
  wholesaler's minimum for steel plate is not a shop's for washers. Such an
  item is still reported when its stock runs out or goes negative, which needs
  no threshold.

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
- Money — **read §6.17 before using any of these:**

  | Field | What it actually is |
  |---|---|
  | `gst` | the tax: Σ of the lines' `gstAmount` |
  | `totalAmount` | **TAX-INCLUSIVE.** Σ of the lines' `total`, and a line's total is `taxableAmount + gstAmount`. The taxable value is `totalAmount − gst` |
  | `finalAmount` | `totalAmount` + the party taxes + freight — what the party was charged, and what hits their ledger |
  | `received`, `balanceDue` | derived on the server, never trusted from the client (§6.5) |

  There is **no round-off field**: `finalAmount` is exactly
  `totalAmount` + `partyTaxes` + `freight`, so anything describing itself as
  "rounding" would be zero on every row.

- `paymentType` (`Cash`/`Cheque`), `stateOfSupply`, `stateCode`,
  `taxType` (`local`/`central`)
- E-invoicing: `irn`, `ackNo`, `einvoiceStatus`, `einvoiceCancelledAt`,
  `einvoiceError`. An invoice with an IRN is **read-only** — `lib/einvoiceLock.mjs`
  and the alter/delete routes refuse it with 409
- `customer` also carries a **frozen buyer snapshot** — `gstin`, `address`,
  `city`, `state`, `pincode`, `stateCode` — written by `lib/buyerSnapshot.mjs`.
  A party who moves next year must not retroactively change the address on a
  bill already filed
- Per line: `orderNo`, `orderType`, `orderLineId`, `orderDate` — which order
  line this fulfils, if any. All four or none; only `lib/orderClaims.mjs`
  acts on them
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
`againstBill`, `acType`, and `customers[]` of
`{ name, debit, credit, custId, narration, allocations[] }`.

`allocations[]` is SIGFA's **Against Bill**: `{ invoiceNo, invoiceType,
invoiceDate, amount }`, saying which open bills this line settles and by how
much. `lib/billAdjust.mjs` owns the rules — FIFO by age, never more than a
bill owes, never more than the line is for, no bill twice — and every refusal
is a sentence it returns rather than a code. A line may be partly allocated and
partly on account; what is left over is deliberately not forced onto a bill.

### `pricelists` (`models/priceListModel.js`) — per-party item rates

`party` (ObjectId → customers), `partyName`, `date`, `remark`, and `items[]`:

`{ itemId, name, unit, salePrice, mrp, discount }`

- `salePrice` / `mrp` are **nullable** — `null` means "use the item master",
  which is **not** the same as `0` (zero means free).
- `discount` is **one** percentage.
- `dis1`/`dis2`/`dis3` and `price` are **legacy fields**, still declared so old
  documents load. Nothing writes them. `lib/priceList.mjs` collapses an old
  three-discount chain into the one equivalent percentage.

### `orders` (`models/orderModel.js`) — sale and purchase orders

`orderNo`, `type` (`Sale`/`Purchase`), `date`, `customer`, `items[]` of
`{ name, quantity, rate, despatchedQuantity, cancelledQuantity, … }`,
and the cancellation block (`cancelled`, `cancelReason`, `cancelledBy`,
`cancelledAt`).

An order line is **claimed** by an invoice line, not consumed: `despQty` and
`canQty` accumulate and `balance = quantity − despQty − canQty`, which is what
the pending-order reports show. `lib/orderClaims.mjs` is the only thing that
writes the claim, and it keys on the order subdocument's own `_id` so an order
edit does not detach an invoice that already billed against it.

### `boms` (`models/bomModel.js`) — bill of material

The formula for making one item: the output, and `components[]` of
`{ name, quantity, kind }` where kind is material, wastage or by-product.
**Nested** — a component may itself have a BOM, and `lib/bom.mjs` explodes the
tree. Rates are read live from the item master rather than frozen.

### `productions` (`models/productionModel.js`) — the three stock vouchers

One model, three kinds, which are SIGFA's own MKEYs:

| `kind` | SIGFA | Slip | Prefix | Counter |
|---|---|---|---|---|
| `FR` | Production | Production | `PRD-` | `productionNo` |
| `IS` | Goods Issued | Issue Slip | `GI-` | `goodsIssueNo` |
| `RS` | Goods Received | Receipt Slip | `GR-` | `goodsReceiptNo` |

`kind` is an enum defaulting to `FR`; `outputItem`/`outputQuantity` are
conditionally required (only `FR` has an output). `series` and `store` are
SIGFA's header fields. The unique index is `{ companyId, kind, docNo }`, so the
three kinds number independently. `lib/stockVoucher.mjs` owns every decision
about them — direction of movement, slip columns, what a reversal undoes.

> Rows written before `kind` existed need
> `node scripts/backfill-stock-kind.mjs` (dry run) then `--apply`.

### `customergroups`, `states`

`customergroups`: the party group master. **`Cash` and `Bank` are reserved** —
`lib/customerGroups.mjs` refuses to let either be renamed or deleted, because
`lib/cashAccount.mjs` resolves the money account by group.

`states`: the GST state master — `name` and the two-digit `code`. The place of
supply and its code on every invoice come from here via the party, never typed
(`lib/placeOfSupply.mjs`).

### `hsn`, `Counter`, `TotalSale`

- `hsn`: `hsncode`, `hsnname`, `gst`, `gstunit`. Unique per firm
- `Counter`: `{ name, value }` — only `name: 'invoiceNo'` is used. Unique per
  firm, so each firm's numbering runs independently
- `TotalSale`: legacy, effectively unused. The only model with no tenant plugin

### `companies` (`models/companyModel.js`) — the tenant

One row per subscribing firm: `name`, `gstin`, `phone`, `email`, `address`,
`city`, `state`, `stateCode`, `pincode`, bank details, `active`.

Also the e-invoicing block: `einvoiceEnabled`, `einvoiceUsername`,
`einvoicePasswordEnc` (`select: false`, sealed by `lib/secretBox.mjs`),
`einvoiceEnv`.

Deliberately **not** unique on `name` — two unrelated shops may genuinely
share one. `companies` **is** the tenant list, so it is the one collection the
tenant plugin must not apply to; the two routes that read it
(`api/company`, `api/company-update`) scope by `auth.companyId` explicitly and
say so in a comment.

### `users` (`models/userModel.js`) — who can sign in

`email` (lowercased), `name`, `passwordHash` (`select: false`, so it is never
returned unless asked for), `role`, `companyId`, `tokenVersion`, `active`,
`lastLoginAt`, `mustChangePassword`.

`mustChangePassword` is set when an owner creates a staff account with a
password they chose. Until the staff member sets their own,
`lib/authServer.mjs` refuses every path except the handful in
`PASSWORD_CHANGE_PATHS` — so they can change it and nothing else.

**`lib/staffStore.mjs` is the only module allowed to query `User`.** Every
function on it takes `companyId` first and throws `StaffScopeError` without
one: `users` carries no tenant plugin (login has to find a user *before* a
tenant exists), so the scoping that the plugin does everywhere else has to be
done by hand here, in one place, fail-closed.

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

### 6.16 Dates are IST calendar days — and there are TWO day numbers

**Nothing compares dates with the server's clock.** The dev container runs
`Asia/Calcutta` and Vercel runs UTC, so a local-clock comparison puts a bill
saved at 19:00 UTC on 30 June into June on one machine and July on the other.
On a report that is embarrassing; on a GST return it is a late filing.

Everything goes through `lib/istDate.mjs`:

| Export | What it gives | Use it to |
|---|---|---|
| `istParts(v)` | `{year, month, day, hour, minute}` in IST | build a label or a key |
| `istDayNumber(v)` | `yyyymmdd` as a Number | **compare** and **sort** |
| `istDayIndex(v)` | days since 1 Jan 1970 | **count**, **step through**, take a modulus |
| `dayKeyToUtcMs(n)` | a `yyyymmdd` key back to that midnight | convert |
| `dayIndexToIso(i)` | a day count back to `yyyy-mm-dd` | convert |
| `istDayWindow(v)` | the UTC instants bounding that IST day | narrow a Mongo query |

> **`istDayNumber` is NOT a count of days.** 1 January to 31 December differs
> by **1130** under it, not 364. Subtracting it produces a plausible wrong
> number, which is the worst kind: it made a one-year chart decide the period
> was three years long. If you are subtracting, stepping or taking a modulus,
> you want `istDayIndex`.

**Narrowing in Mongo is a coarse filter, not the rule.** Stored dates are UTC
midnights and the comparison is of IST days, so a database filter must be
**widened by a day at each edge** and the real cut made in the pure module:

```js
const end = new Date(`${to}T00:00:00.000Z`);
end.setUTCDate(end.getUTCDate() + 2);   // then compare IST days in lib/
```

Narrowing exactly drops a late-evening invoice before the real comparison ever
sees it.

### 6.17 `Invoice.totalAmount` is tax-INCLUSIVE

This has been got wrong twice. The name reads like a pre-tax subtotal. It is
not:

```
line.total      = taxableAmount + gstAmount        (lib/billingMath.mjs)
totalAmount     = Σ line.total                      ← tax-INCLUSIVE
finalAmount     = totalAmount + partyTaxes + freight
taxable value   = totalAmount − gst                 ← what you probably wanted
```

So a report that prints `totalAmount` under a "Taxable" heading prints the
gross. `lib/salesReports.mjs` shipped with exactly that bug and
`taxableOf()` is now the one place the subtraction happens — use it, or
`netOf()` / `othersOf()` beside it, rather than reading the field raw.

Note also that **`recalcItem` does not round** (§9.17), so a stored `gstAmount`
can differ by paise from `taxableAmount × rate / 100`. **Read what was stored.**
The bill the client printed and sent is the truth; a report that recomputes it
will disagree with the document in the customer's hand.

### 6.18 A return subtracts — it is not a register of its own

Not a judgement call. SIGFA settles it, and its own SQL is quoted in
`lib/salesReports.mjs`:

```sql
And S.Mkey in ('SI','SR')

Sum(IIF(S.Mkey='SI' or S.Mkey='SC' or S.Mkey='PI' or S.Mkey='PC', Amount, 0))
  - Sum(IIF(S.Mkey='SR' Or S.Mkey='PR', Amount, 0))
```

An invoice adds and a return subtracts, **inside one report**, and every money
column nets the same way. So:

- A return is **listed at the value printed on it** — a credit note for 500 is
  a credit note for 500, not for −500 — and **totalled with a minus**. That is
  why a book row carries both `taxable/gst/total` (as printed) and
  `signedTaxable/signedGst/signedTotal` (as totalled). Total the signed ones.
- `documentSign()` is the whole rule in one function, so no report can write
  the subtraction out again and get it backwards.
- **One thing of SIGFA's is deliberately NOT copied:** it wraps the
  subtraction in `Abs()`, which turns a net of −500 into +500. A party who
  returned more than they bought would be reported as having bought. The
  netting is kept; the `Abs` is not, and a negative net prints as negative.
- SIGFA's Sales Book screen has a four-way selector — *Sales Book : Sales
  Return : Sales And Sales Return : Sales Challan* — so the netting is what its
  **third** option does. Three of the four are offered here (this app has no
  challan), and the netted one is the default.

### 6.19 When SIGFA's behaviour is the question, read SIGFA

The client's own software is the specification (§1). Its `.exe` and `.mdb`
files are the authority, and the tooling to read them is in
`/home/claude/mdb/` on the machine this was developed on: a hand-written Jet4
MDB parser plus helpers for the menu strings, the shortcut table and the MKEY
seeds.

What has actually been recovered this way, and is quoted in the module that
uses it:

- the **menu tree** and every caption, verbatim — VB6 marks accelerators with
  `&`, so `'&Item Wise Sales'` is a menu item;
- the **MkeyMaster seeds** (`SI`, `SR`, `PI`, `PR`, `SO`, `PO`, `FR`, `IS`,
  `RS`, `CA`, `BA`…), which is where `lib/stockVoucher.mjs`'s three kinds and
  their labels come from;
- **report SQL**, including the netting above and the bracket aliases that are
  a grid's column headings (`select Voucher as [INVOICE NO], … as [P A R T Y]`);
- the **column-caption builders** — a report's headings are concatenated from
  comma-prefixed literals (`'Month,Bill Amount'`, then `',Taxable Amount'`,
  `',Discount'` …), each behind a flag in its `SetupSB` table;
- the **shortcut help window**, which is where `lib/billingKeys.mjs` comes from.

**What cannot be recovered:** the `RPTWRT`/`RPTWRT1` tables are empty in every
copy of the client's data — those hold *user-defined* reports, not the built-in
ones, so a built-in report's drawing code is compiled and its exact printed
layout is not reconstructable. For those, ask the client for a screenshot. Do
not guess a heading and do not quietly invent one.

### 6.20 A stock voucher is not an invoice

`productions` holds three kinds (§5) and they move stock without a party
balance: no money, no ledger row, no `lastBal` delta. `lib/stockVoucher.mjs`
decides everything about them and **`lib/productionSave.mjs` is the only thing
that writes one.**

- Direction comes from `lineDirection(kind)`, never from a hand-written
  comparison. `reversalOf()` is what an alter or delete undoes, and it agrees
  with `stockDirection` for every kind by construction — a by-product going
  *back into* stock on a reversal was a real bug here once.
- Each kind has **its own counter**, so the three number independently.
- A `FR` row freezes its component rates at the time it was made; `IS` and
  `RS` carry no formula and no output.

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

### Orders
| Route | Method | Notes |
|---|---|---|
| `order-add` / `order-alter` | POST | Create and edit. One screen serves sale and purchase orders |
| `order-cancel` | POST | Cancels a whole order or one line, recording reason, who and when. Restorable |
| `delete-order` | POST `?id` | |
| `order` / `get-order` | POST / GET | Lookup, and all |
| `order-pending` | GET | A party's open order lines, for prefilling a bill |
| `order-report` | GET `?view=party\|item&side=` | Pending orders. SIGFA's exact headings, plus current stock on the item view |
| `order-reconcile` | POST | Recompute `despQty`/`canQty` from the invoices that claim each line |
| `next-order-no` | GET | Peek, like `next-invoice-no` (§6.12) |
| `todays-orders` | GET | Orders dated today — the once-a-day reminder |

### Production, BOM and stock vouchers
`bom-add`, `bom-alter`, `delete-bom`, `bom`, `get-bom`, `bom-explode`
(the nested tree for one output);
`production-add`, `production-alter`, `delete-production`, `production`,
`get-production`, `next-production-no` (per kind — §6.20);
`production-plan` (GET — what to make for pending orders, net of stock).

`production*` serve all three kinds (`FR`/`IS`/`RS`) through `?kind=`.

### Books, statements and reports
| Route | Method | Notes |
|---|---|---|
| `account-book` | GET `?kind=cash\|bank\|ledger&account=&from=&to=` | Cash Book, Bank Book, A/C Ledger |
| `financials` | GET `?kind=trial\|trading\|pl\|balance&from=&to=` | All four statements from one route, so they agree with each other |
| `sales-report` | GET `?view=book\|party\|item&side=&grain=&scope=&month=` | Sales/Purchase Book (month/date/bill), Party-wise, Item-wise (§6.18) |
| `gst-return` | GET `?view=gstr1-ereturn\|gstr1\|gstr3\|gstr3b&from=&to=` | The e-return returns the portal's JSON and the filename; the rest return numbered tables |
| `analytics` | GET `?preset=&from=&to=&grain=&side=&search=&page=` | The whole dashboard in one response, so the cards and the tables cannot disagree |
| `open-bills` | GET `?party=&type=` | A party's unsettled bills, for Against Bill (§6.18) |

**The four report routes compute nothing themselves.** Every figure comes from
the matching `lib/*.mjs`, and `scripts/*.test.mjs` asserts the route contains
no `reduce(` of its own. Keep it that way: a route that totals is a route whose
total can disagree with the module the tests exercise.

### Account and staff
| Route | Method | Notes |
|---|---|---|
| `company` | GET | The firm's own profile. Readable by any role — a biller cannot print a bill without the letterhead. Projects by field name, so a credential column added later is not served to the browser |
| `company-update` | POST | Owner-only. Seals the IRP password with `lib/secretBox.mjs` |
| `staff` | GET | The firm's staff list. Owner-only (`user:manage`) |
| `staff-add` / `staff-alter` | POST | Create, rename, change role. Refuses `owner` — it is a whitelist of assignable roles, not a blacklist |
| `staff-status` | POST | Activate / deactivate. Refuses the firm's **last active owner**, and refuses self |
| `change-password` | POST | The one route reachable while `mustChangePassword` is set |

> Both staff guards exist because a firm that reaches zero active owners can
> never add one back from inside the app — nobody is left who may open the
> page. It is not a recoverable mistake. `lib/staffRules.mjs` refuses it, and
> the **routes** ask the same functions the screen does, so the two cannot drift.

### Masters
`customer-add`, `customer-alter`, `delete-cust`, `customer` (lookup),
`get-customer`; `item-add`, `item-alter`, `delete-item`, `item`, `get-item`;
`hsn-add`, `hsn-update`, `delete-hsn`, `get-hsn`;
`price-list-add`, `price-list-update`, `delete-price-list`, `get-price-list`;
`group-add`, `group-update`, `delete-group`, `get-group`;
`state-add`, `state-update`, `delete-state`, `get-state`.

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
`item-stock` (GET — current stock per item, summed from the stock ledger in
**one** `$group`; never a query per item).

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

### 8.4 The billing screen is one component now (mostly)

`components/billing/BillingScreen.jsx` takes a single prop, `typeKey`, and
`lib/billingTypes.mjs` turns it into everything that differs between the four:
route, `type`, `return`, title, subtitle, which order document it can bill
from. `app/saleadd/page.js` is **22 lines** around it.

Two things about how it was made, which matter if you touch it:

- It was produced by **transforming `saleadd/page.js` programmatically**, not
  by retyping it. The posting behaviour is byte-for-byte what it was, and
  `lib/billingMath.mjs` carries `recalcItem` and `buildHsnTotals` **verbatim**,
  quirks and all, each one documented (§9.17). Do not "clean up" that
  arithmetic: it decides what prints on a GST return.
- `PAYLOAD_KEYS` in `billingMath.mjs` is the **frozen list of 31 fields** the
  save request carries. The server derives what it must (§6.5), but adding a
  key here changes what four screens send — check the route reads it, and
  remember Mongoose strict mode silently drops an undeclared field (§9.18).

**All four pages now delegate**, and `scripts/billing.test.mjs` fails if one
stops: it checks each page imports BillingScreen, passes a key the table
knows, and has grown no `useState`, no `useEffect`, no `fetch`, no arithmetic
and no form of its own. A billing change is made **once**.

The audit before replacing the last three compared each page's state, its
functions and its imports against BillingScreen's and found nothing unique to
any of them — they were strict subsets. That is what made the migration safe
to do in one go rather than one screen at a time. **Do that audit again** if
you ever need to re-derive a page: "they looked similar" is not the same
finding.

### 8.5 Report pages print, and they compute nothing

Every register in the app prints the same way, and a new one should copy it
rather than invent a layout:

- `doc-sheet` on the page, `doc-head` / `doc-org` / `doc-meta` / `doc-kind`
  for the firm's letterhead and the report's title, `no-print` on every
  control. `Ctrl+P` then gives the same kind of sheet everywhere.
- The letterhead comes from `useCompany()` and `companyAddress()`, never from
  a constant.
- **The page does no arithmetic.** Figures, column captions, totals, CSV
  columns and the download filename all come from the matching `lib/*.mjs`.
  The suites assert it (`assert.doesNotMatch(page, /\.reduce\(/)`) — because a
  page that totals is a page whose footer can disagree with the sheet above it.
- Column captions live in **one** list, shared by the screen and the CSV
  (`sheetHeadings()` reads `CSV_COLUMNS`). Two lists is how a column comes to
  be called "Total" on screen and "Bill Amount" in the download.
- Charts are **hand-drawn SVG** (`app/dashboard/page.js`). There is no
  charting dependency and the dashboard suite fails if one is added: a 200 KB
  library for two series of bars would be the largest thing on the page.
  Tooltips are a `<title>` inside the bar, which the browser already knows how
  to show.

---

## 9. Known issues, drift and landmines

Honest list. Some are deliberate prototype trade-offs; none are secret.

**Blocking**

1. ~~The letterhead is still one hard-coded firm.~~ **Fixed.** `/company`
   stores the firm's own profile and `lib/company.mjs` reads the signed-in
   firm's `companies` row. Every register and every printed bill takes its
   letterhead from `useCompany()`.
2. **Tenant isolation has not been exercised against a real database.** The
   scoping rules are unit-tested and the audit proves every route and model is
   wired (§10), but nobody has yet signed up a second firm and confirmed its
   customer list comes back empty. **Do that before onboarding a real second
   customer.** Still the one blocking item.
3. ~~There is no way to add a second user from the UI.~~ **Fixed.** `/staff`
   is owner-only and creates accountant and biller accounts, with a forced
   password change on first sign-in (§7, §5 `users`).
4. ~~There is no authentication anywhere.~~ **Fixed.** Sign-in, roles, a gate
   in `middleware.js` and per-firm scoping on every query — §6.14, §6.15.

**Unresolved, and needs a reproduction**

4a. **`TenantMissingError` fires intermittently in dev** on
   `get-customer`, `get-item`, `next-invoice-no`, `get-state`, `item-stock`
   and `get-price-list` — the ones a billing screen fires on mount. The
   diagnostic in `lib/tenantContext.mjs` distinguishes the two causes and
   prints which: a module instance that has **never** established a context
   (a route not wrapped, or a second copy of `tenantContext.mjs` serving the
   wrapper) versus one that has, where a query escaped its async chain. The
   static sweep proves every route is wrapped, so the second is likelier —
   probably a Turbopack double-instance in dev.

   To resolve it: `rm -r .next`, `npm run dev`, open a failing page, and
   capture from the first `[tenant] module instance` line through
   `[tenant] NO STORE on instance X after N set(s)` **and the stack**. The
   `console.log`s in `lib/tenantContext.mjs` and `lib/tenantRoute.mjs` are
   marked TEMPORARY DIAGNOSTIC and should come out once it is understood.

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

8. ~~Four copies of the billing screen.~~ **Fixed.** All four pages are
   ~25-line stubs around `components/billing/BillingScreen.jsx` (§8.4), and
   the suite fails if one stops delegating.

   **What the drift had actually cost, as a warning:** the two return pages
   sat untouched from 8 October while the sale screen gained order linkage,
   the shared arithmetic and Sigfa's keyboard shortcuts. By the time anyone
   tried a shortcut on a purchase return, three screens out of four had none —
   and the symptom reported was "keyboard navigation not working", not "those
   pages are stale". **A duplicated screen does not announce its own drift.**

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
15. `capacitor.config.ts` still says `com.example.app`. (`README.md` has been
    written; it points here for anything beyond running the app.)
16. The Electron build (`main.js`) loads the deployed URL in a window, so it
    now shows the sign-in page like any browser. Nothing stores a session for
    it beyond the embedded browser's own cookie jar.

**Known defects in the billing arithmetic — reported, not repaired**

These are preserved deliberately. Each one changes what prints on a GST
return, so fixing it is a decision with the client, not a tidy-up.
`lib/billingMath.mjs` documents all four at the line.

17. **The HSN summary takes the first line's GST rate.** `buildHsnTotals`
    assigns `grouped[hsn]` only on first sight, so billing a 5% item and an
    18% item under one HSN code prints both at 5% — while the *amounts* are
    correct. `lib/hsnTotals.mjs` derives it properly for the print, and
    `lib/gstReturns.mjs` reads the **lines** rather than the stored array for
    exactly this reason (its table 12 is per HSN *and* per rate).
18. **`recalcItem` never rounds.** A stored `taxableAmount`, `gstAmount` or
    `total` can carry floating-point tail digits, which is why §6.17 says read
    what was stored rather than recompute from the rate.
19. **`resolveItemPricing` reads `salePrice` unconditionally**, so a purchase
    invoice prices from the *sale* price unless the line is edited. The price
    list is party-wise, not side-wise, and nothing distinguishes the two.
20. **Invoice-draft `localStorage` keys are global across all four billing
    screens**, so a half-finished sale and a half-finished purchase can
    overwrite each other. Keying them by `typeKey` is the fix.
21. **`againstInvoiceNo` on the Invoice schema is declared and never set.**
    Harmless, but it looks like a working link. Bill-wise adjustment lives on
    the **voucher** (§5 `Voucher.allocations`), not here.

**A shipped-and-fixed defect worth remembering**

21a. **A shortcut table listed nineteen keys while ten were wired, and the
    Alt+H overlay advertised all nineteen.** Nine of Sigfa's keys did nothing
    and the help window promised they would — which costs the reader their
    trust in the ten that worked, and gets reported as "no shortcuts work".

    Fixed, and fixed structurally: `useBillingKeys` returns the set of actions
    it can fire, the overlay greys anything unbound as "not on this screen",
    and `billing.test.mjs` sweeps the screen's handler object against
    `ALL_ACTIONS` in both directions. **The lesson generalises:** a table of
    capabilities and the code that implements them are two lists, and a UI
    that reads the table rather than the implementation will lie. Derive the
    advertisement from the binding, never from the catalogue.

**Build warnings, offered and not actioned**

22. `next.config.mjs` still carries an `eslint` key that Next 16 rejects, and
    `middleware.js` should be renamed `proxy.js` for Next 16. Both are
    warnings in the Vercel build today, not failures.

**Migrations that have not been run against the live database**

23. `npm run sync:indexes` — `orders`, `boms`, `productions` (now
    `{companyId, kind, docNo}`) and the voucher-allocation indexes all want
    building; stale global uniques want dropping (§2).
24. `node scripts/backfill-stock-kind.mjs` — stamps `kind: "FR"` on production
    rows written before the field existed (§5).
25. `npm run backfill:gl-legs` — adds GL legs to invoices raised before
    `lib/invoiceGl.mjs` existed.

   All three are dry-run by default. Run the dry run, read it, then `--apply`.

**Not yet in the other repo**

26. **`C:\Vs Code\SAAS Project\vyapaar` has none of this.** Orders, BOM,
    production, books, financials, the planner, bill adjustment, staff, the
    billing consolidation, stock vouchers, the sales/purchase reports, the GST
    returns and the dashboard all exist **only** in `vyapaar-einvoice`. The two
    repos have diverged a long way; treat `vyapaar-einvoice` as the live one.

**E-invoicing is built but not exercised**

27. The payload builder, the credential vault and the per-invoice lock are
    written and tested, but **no invoice has been reported to a real IRP** —
    that needs WhiteBooks sandbox credentials, which the client has not
    supplied. Until then `einvoiceEnabled` stays off and the lock never fires.

---

## 10. Tests and maintenance scripts

```bash
npm test
```

Runs **40 suites** in `scripts/` — about **1,535 assertions**, in roughly a
minute. **Run it after any change to `lib/`, to a posting route, or after
adding any route or model at all** — two of the suites are static sweeps that
fail the build on an unwrapped route.

The suites that matter most:

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
| `index-audit.test.mjs` | Schema indexes against the ones the database has; catches a stale **global** unique that should be `{companyId, …}` |
| `orders.test.mjs`, `order-reports.test.mjs` | Order claims and cancellation; the pending-order reports and SIGFA's exact headings |
| `bom.test.mjs` | Nested explosion, wastage, by-product, and the three stock vouchers' direction and reversal |
| `account-books.test.mjs`, `financials.test.mjs` | The books, and that all four statements agree with each other |
| `production-plan.test.mjs` | What to make, net of stock |
| `bill-adjust.test.mjs` | Against Bill: FIFO, every refusal, and the money tolerance |
| `staff.test.mjs` | Who may be added, and that a firm cannot reach zero active owners |
| `billing.test.mjs` | The 2×2 type table, the verbatim arithmetic, SIGFA's shortcuts |
| `sales-reports.test.mjs` | The Book at three grains, the zoom, the scope selector, and that a return subtracts (§6.18) |
| `gst-returns.test.mjs` | One table per document, a tax that adds back to the paisa, and that an empty table says **why** |
| `dashboard.test.mjs` | Gross/returns/net, the sign of a balance, period vs point-in-time, and that nothing is invented where the data does not exist |
| `einvoice-payload.test.mjs`, `einvoice-credentials.test.mjs`, `einvoice-lock.test.mjs`, `secret-box.test.mjs` | The IRP payload, the credential vault, and that a reported invoice is read-only |
| `company-profile.test.mjs`, `buyer-snapshot.test.mjs` | The letterhead, and the buyer block frozen onto a bill |
| `clear-zero-units.test.mjs`, `migrate-balances.test.mjs`, `rebuild-voucher-ledger.test.mjs` | The migration scripts |

Tests are plain `node:assert` with a tiny `test()` helper — no Jest, no Vitest.
They import `lib/*.mjs` directly, which is why those files must stay free of
Mongoose. `migrate-balances.test.mjs` and `rebuild-voucher-ledger.test.mjs` do
need `mongoose` installed.

**When you fix a bug in posting logic, add a case to
`posting-invariants.test.mjs`, then verify the test fails without your fix.**
A test that cannot fail is worth nothing.

### 10.1 Every new module is mutation-tested

A green suite proves nothing on its own — most of this file's assertions were
written *after* a sweep showed the obvious one did not bite. So each domain
module has a **mutation harness** beside it: a script that breaks one rule at a
time and expects the suite to fail.

```bash
node mutate-sales.mjs      # 150/150 killed
node mutate-gst.mjs        # 122/122 killed
node mutate-dash.mjs       # 126/126 killed
node mutate-bom.mjs        # 136/136
node mutate-bill.mjs       #  58/58
node mutate-staff.mjs      #  53/53
node mutate-billing.mjs    #  57/57
node mutate-fin.mjs        #  90/90
node mutate-books.mjs      #  67/67
node mutate-plan.mjs       #  50/50
node mutate-sigfa.mjs      #  36/36
node mutate.mjs, mutate-reports.mjs
```

> **These harnesses are work-tree only and are NOT committed.** They are a
> development tool, not part of the product. If you clone the repo fresh they
> will not be there — write one for the module you are changing.

The rules that make them worth running:

- A **surviving** mutant is a rule nothing is checking. Fix the *test*, not
  the mutant.
- An **equivalent** mutant — one that genuinely cannot change behaviour — is
  retired with a comment saying why and what was checked, never deleted
  silently. There are several, each explained at the line.
- Drive every harness to a **full kill** before calling a module done, and
  re-run it after editing a shared helper.

What the sweeps have actually caught in this codebase, all of them green-suite
bugs: a fixture of round thousands that could not test money rounding; a
fixture already in sort order that could not tell a sort from no sort; a
comparison that read `resolveGroup()`'s **record** against a string, so every
party landed on neither side and the dashboard showed no receivables at all;
and `istDayNumber` being subtracted as though it were a day count (§6.16).

Two mechanical habits that save time:

- **Strip comments before grepping source in a test.** These files explain
  what they avoid, so a naive `assert.doesNotMatch(src, /lastQuantity/)` matches
  the comment that says never to read it. Every suite has a `code()` helper
  that removes comments first.
- **Check anchor uniqueness.** A mutant whose anchor appears twice (or zero
  times, after a refactor) is reported as `SKIP`, not as a pass. Read the
  skips.

**Maintenance scripts** all follow one pattern: dry-run by default, `--apply` to
commit, and a timestamped JSON backup under `backups/`.

```bash
npm run adopt:tenant                # stamp pre-tenancy rows with a companyId (§2)
npm run sync:indexes                # schema indexes vs the database's (§2)
npm run migrate:balances            # then :apply
npm run rebuild:voucher-ledger      # rebuild ledger rows from vouchers
npm run backfill:hsn-totals         # repair hsnTotals on old invoices
npm run backfill:gl-legs            # add GL legs to pre-invoiceGl invoices
npm run migrate:phone               # phone/pincode Number -> String
npm run blank:zeros                 # clear meaningless zero defaults
npm run seed:groups                 # customer group master, incl. Cash and Bank
npm run seed:states                 # GST state master
node scripts/backfill-stock-kind.mjs  # stamp kind:"FR" on old production rows
node scripts/check-duplicates.mjs   # report duplicate names in every master
                                    # (no npm alias; the only one without one)
npm run clear:zero-units
npm run reset:data                  # add --keep-masters for transactions only
```

Every one of them is **dry-run by default**; `--apply` commits and writes a
timestamped JSON backup under `backups/` first. §9.23–9.25 lists the three
that have not yet been run against the live database.

`adopt-tenant` refuses to guess when more than one firm exists: pass
`--company <id>`. Picking the wrong one hands one firm's ledger to another and
nothing in the app would flag it.

**After any deploy that added a model or an index**, run:

```bash
npm run sync:indexes          # dry run: reports drift
npm run sync:indexes:apply
```

Mongoose creates indexes on first connection but never *drops* one that has
been removed from a schema — including a stale **global** unique index from
before multi-tenancy. Those are the cause of "duplicate invoice number" errors
across two unrelated firms: the index is `{ invoiceNo }`, not
`{ companyId, invoiceNo }`. `sync:indexes` is what finds and replaces them.

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

### Add a report

1. **The arithmetic goes in `lib/<name>.mjs`, pure.** Every figure, every
   column caption, every CSV column, the filename. If you are about to write a
   `reduce` in a route or a page, it belongs here instead.
2. **Reuse what already decides things.** `documentsFor` for what counts as a
   sale and which side it is on; `isReturn`/`documentSign` for the netting
   (§6.18); `taxableOf` for the pre-tax figure (§6.17); `istDayNumber` /
   `istDayIndex` for dates (§6.16); `buildStockIndex` for stock;
   `Customer.lastBal` for a balance. A report with its own opinion about any of
   these is a report that will disagree with the ledger.
3. **One route for a family of views.** `?view=`, `?side=`, `?grain=` — they
   share the expensive fetch and they have to agree with each other. Validate
   every parameter on the server with an `is…()` from the module.
4. Widen the database date filter and cut it in the module (§6.16).
5. **One page, following §8.5** — `doc-sheet`, `no-print`, captions from the
   module, no arithmetic.
6. Add the path pair to `PATH_RULES` in `lib/roles.mjs` (a report is normally
   `report:read`: owner and accountant, not biller).
7. A tile on `app/page.js`.
8. **A suite, then a mutation harness, driven to a full kill (§10.1).**
   Register the suite in `package.json`'s `test` script.

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

> I'm working on **Vyapaar**, a Next.js 16 + MongoDB GST billing and
> accounting app that serves several small Indian trading firms from one
> deployment. It is replacing the client's SIGFA desktop software, so where a
> feature's behaviour, field names or report headings are in question, SIGFA's
> are the answer (§6.19). I'm pasting its context file below. Read it fully
> before answering — especially §6, and above all §6.14 (every query is scoped
> to one firm, automatically), §6.15 (auth and roles), §6.16 (dates are IST
> calendar days, and there are two different day numbers) and §6.17
> (`totalAmount` is tax-inclusive).
>
> Constraints: **JavaScript, not TypeScript. React 18. Mongoose. Tailwind plus
> the component classes in §8.1 — do not hand-roll styling or hard-code
> colours.** Every money write goes through `withTransaction` and passes
> `{ session }` to every query inside it. Create, edit and delete must derive
> their figures from the same function in `lib/`.
>
> **Arithmetic goes in a pure `lib/*.mjs` module, never in a route or a page.**
> Reports and dashboards must defer to whatever already owns each figure —
> `documentsFor` for what counts as a sale, `taxableOf` for a pre-tax value,
> `Customer.lastBal` for a balance, `buildStockIndex` for stock — rather than
> computing a second opinion about the firm's money.
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
> including the three un-migrated sibling billing pages if you touch billing
> behaviour (§9.8), and the entry in `PATH_RULES` if you add a route.
>
> Add tests in the existing style — plain `node:assert`, a `test()` helper, no
> framework — and register the suite in `package.json`. Assume I will then
> break your logic one rule at a time to check the tests actually bite
> (§10.1), so write assertions that would fail if the rule were inverted, not
> just ones that pass today.
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
