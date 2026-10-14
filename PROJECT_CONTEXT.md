# Vyapaar — Project Context for AI Assistants

**Read this file before changing anything.** It is written for an AI assistant
(ChatGPT, Gemini, Claude, Copilot — any of them) that has no prior knowledge of
this codebase. It contains the architecture, the data model, the accounting
rules that must not be broken, the UI vocabulary, and the known landmines.

Paste the whole file, or paste §1–§6 plus the section relevant to your task.

**Last verified: 14 October 2026.** When you change the shape of the data, the
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
>
> **And §6.26 if you are anywhere near the invoice importer.** It is the only
> path into these books whose input is a guess, and the rule that keeps it
> honest — an exact match applies, a likely one is only ever suggested — is one
> line of code away from posting a bill to the wrong party's account.

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
group the way they do. Do not redesign a screen that already matches it. The
four master keys in §6.21 came out of its status bars; the Sales Book's netting
SQL is quoted in `lib/salesReports.mjs`; the ten GSTR-1 captions are its own.

What it does:

| Area | Screens |
|---|---|
| Masters | Customers/parties, Items, HSN codes, Party price lists, Customer groups, GST states, Bill of Material |
| Transactions | Sale, Sale Return, Purchase, Purchase Return invoices |
| Orders | Sale/Purchase orders, order cancellation, order→invoice linkage, pending-order reports |
| Challans | Sales/Purchase challans (SIGFA's SC/PC), stock effect, billing pending challans into invoices, pending challan book, challan print |
| M.R.I. | Purchase material receipt: received / accepted / rejected on a purchase bill or purchase challan, Re-MRI, pending MRI, rejected material registers (§6.41) |
| Production | Production (from a BOM), Goods Issued, Goods Received, Production planning |
| Money | Receipt/payment vouchers, bill-wise adjustment ("Against Bill") |
| Books | Cash Book, Bank Book, A/C Ledger |
| Statements | Trial Balance, Trading A/c, Profit & Loss, Balance Sheet; customer and supplier statements |
| Reports | A Reports hub by category; party ledger, stock (item) ledger, voucher register, invoice print, date-range print, Sales/Purchase Book, party-wise, item-wise. Thirteen shared date presets, CSV and `.xlsx` downloads, A4/A5 print |
| GST | GSTR-1 (e-return JSON + readable tables), GSTR-3, GSTR-3B |
| Analytics | Business dashboard — sales trends, receivables, payables, low stock, month-on-month |
| E-invoicing | IRN payload build, credential vault, per-invoice lock |
| Extras | Read a purchase bill off a photograph (in-app, reviewed before saving), email invoice, today's-orders reminder |
| Account | Sign in, sign up a firm, company profile with logo and document preferences, staff management, change password, roles (owner / accountant / biller) |

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
INVOICE_AI_KEY=...               # optional; required ONLY to read a purchase
                                 # bill off a photograph (§6.26). Deliberately
                                 # NOT NEXT_PUBLIC_ — a key that reaches the
                                 # browser is a published key. Without it
                                 # /api/invoice-extract answers 503 and says
                                 # so, rather than failing less obviously.
                                 # ANTHROPIC_API_KEY is read as a fallback.
INVOICE_AI_MODEL=...             # optional; which model reads the bill
INVOICE_AI_URL=...               # optional; the endpoint, so this can point at
                                 # a gateway, a proxy or another provider's
                                 # compatible API
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

**The Python service in `backend/` is no longer used.** `/upload` used to POST
an image to it and then POST whatever came back straight to `/api/save-invoice`.
Reading a bill now happens inside this app, in
`app/api/invoice-extract/route.js`, and what comes back is a DRAFT that a person
checks on the purchase screen — §6.26 lists the six things the old path got
wrong. `backend/` and `NEXT_PUBLIC_AI_IMPORT_URL` can both be deleted; they are
left in place only because nothing depends on removing them.

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
  challan/               Challan register / pending challan book (§6.39);
                         challan/print/ prints one
  challanadd/            Sales/Purchase challan entry (?type=Sale|Purchase;
                         &mri=1 opens a purchase challan as an M.R.I.)
  mri/                   Purchase M.R.I. registers: register, pending,
                         rejected material, party wise (§6.41)
  order-report/          Pending orders — party-wise and item-wise
  bom/                   Bill of Material register
  bomadd/                BOM entry (nested formulas)
  production/            Production / Goods Issued / Goods Received slips
  production-plan/       What to make, and what it needs
  sales-report/          Sales & Purchase Book, Party-wise, Item-wise (§6.18)
  gst-return/            GSTR-1 e-return + GSTR-1/3/3B tables
  dashboard/             Business dashboard — trends, dues, stock, comparison
  reports/               THE REPORTS HUB — every report by category, driven by
                         lib/reportCatalogue.mjs. A loop, not a page of tiles
  statement/             Customer and supplier statements (§6.24)
  customeradd/           Party master form
  itemadd/               Item master form
  company/               The firm's own profile + e-invoicing credentials
  staff/                 Owner-only: add and manage accountant/biller accounts
  change-password/       Forced on first sign-in for a staff account
  setup/                 Feature toggles + the danger zone (§7)
  upload/                Read a purchase bill off a photograph (§6.26). It
                         shows what was read and hands a DRAFT to
                         /purchaseadd?import=1 — it saves nothing
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
                         'purchaseReturn'). ALL FOUR pages are now ~25-line
                         stubs around it. It was produced by TRANSFORMING
                         saleadd/page.js programmatically, not by retyping it,
                         so the posting behaviour is byte-for-byte what it
                         always was.
  billing/QuickMaster.jsx
                         Create OR alter the master behind the focused field,
                         without leaving the bill (§6.21)
  billing/ShortcutHelp.jsx
                         Alt+H. Greys the keys this screen has not bound —
                         see §9.21a for why that matters
  billing/InfoPanel.jsx  Read-only lookups (stock, a party's bills)
  billing/LookupList.jsx Arrow/Enter/Escape picker
  billing/ItemSearch.jsx The line's item picker. Tagged `data-master-field`
  billing/ChallanPicker.jsx
                         "Pending challan [Alt+L]": pick challan lines onto the
                         bill (§6.39)
  billing/MriPanel.jsx   The purchase M.R.I. strip — tick, number peek, remark,
                         Ag. MRI No. — on the purchase bill and the purchase
                         challan form (§6.41)
  masters/useMasterActions.js
                         Alt+A / Alt+M / Alt+D over whatever field has focus.
                         Reads `data-master-field` off `document.activeElement`
  masters/MasterShortcuts.jsx
                         One-line drop-in that gives a master page the same keys
  CompanyBrand.jsx       `<CompanyLogo>`, `<CompanyBrand>`, `<CompanyBank>`,
                         `<DocumentFooter>` — the firm's identity, in ONE place,
                         shared by the invoice, the statements and the printed
                         reports (§6.25)
  EmailInvoiceDialog.jsx Emailing the bill on screen. Offers the party's address,
                         lets it be changed, attaches the same PDF the Download
                         button makes (§6.27)
  reports/DateFilter.jsx The thirteen date presets, shared by every report. It
                         holds NO period logic of its own (§6.22)
  StatementSearchParams.jsx / AccountBookSearchParams.jsx
                         `useSearchParams` behind the page's Suspense boundary,
                         the pattern ItemLedgerSearchParams established. Each
                         fires ONCE: a deep link sets the opening state and the
                         page's own controls own it afterwards
  ChallanSearchParams.jsx
                         `?type=&challanNo=&status=&mri=` for the challan pages
  StockReportSearchParams.jsx
                         `?report=` off the hub's five stock tiles, behind the
                         page's Suspense boundary (§6.40)
  TodaysOrders.jsx       The once-a-day reminder of orders dated today
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
  inventory.mjs          Sigfa's stock reports: the period split, the FIFO
                         ageing, the five supportable valuation bases and the
                         two refused ones, the day book and a physical count.
                         Holds no figure itemStock / dashboard / salesReports /
                         financials already own (§6.40)
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
  masterActions.mjs      WHICH master sits behind a field, and what Alt+A /
                         Alt+M / Alt+D do to it. 14 field names → 6 kinds, and
                         per kind the list/create/alter/delete endpoints and the
                         payload mapping. Read §6.21 before touching it — an
                         ALTER sends the whole record for a reason
  invoiceImport.mjs      A purchase bill read off a photograph, turned into a
                         draft: master matching, recomputation, and every
                         warning. Read §6.26 — this is the one path into these
                         books whose input is a guess
  invoiceEmail.mjs       Emailing a bill: who it goes to, what the covering note
                         says, what cannot be sent, and the send log. Decides;
                         sends nothing (§6.27)

  orderStatus.mjs        Order lifecycle, cancellation, restore
  orderClaims.mjs        Which order line an invoice line fulfils (Mongoose)
  orderPrefill.mjs       Building a bill from an order
  orderReports.mjs       Pending orders, party-wise and item-wise (SIGFA's
                         exact column headings)
  todaysOrders.mjs       The once-a-day reminder of orders dated today

  challanStatus.mjs      Challans (SIGFA's SC/PC): kinds, status, totals, stock
                         rows, claims, edit/delete guards, the picker (§6.39)
  challanInput.mjs       A challan request, checked field by field
  challanSave.mjs        Building the stored challan  (imports Mongoose)
  challanClaims.mjs      Billed quantities on challan lines (imports Mongoose)
  getNextChallanNo.js    One number series per challan kind
  mri.mjs                Purchase M.R.I.: received/accepted/rejected, the MRI
                         block, Re-MRI rules, the registers (§6.41). Pure
  mriSave.mjs            The MRI number series, the Ag. MRI No. check, the
                         Re-MRI lock and delete guard  (imports Mongoose)

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
  statements.mjs         Customer and supplier statements. Calls accountBook()
                         and LABELS its lines — it computes no balance of its
                         own, which is why a statement and the A/C Ledger can
                         never disagree (§6.24)
  reportCatalogue.mjs    Every report, by category, with the permission each
                         needs and the gaps each category still has

  reportPeriods.mjs      THE date filter. Thirteen presets, the financial year,
                         the financial quarters, the IST day arithmetic, the
                         range validation and the widened Mongo window. ONE
                         resolver for the whole app — read §6.22
  csv.mjs                The one CSV writer: RFC 4180 quoting, the formula-
                         injection guard, the BOM, the metadata block
  xlsx.mjs               A dependency-free .xlsx writer (ZIP + SpreadsheetML
                         over node:zlib). Numbers as numbers, IST date serials,
                         a frozen header. See §6.23
  reportExport.mjs       The format list, the filename and the headers — the
                         pure half of the export, so a test can reach it
  reportHttp.js          `reportResponse()`: JSON, CSV or XLSX from ONE sheet
                         spec. A `.js`, not a `.mjs` — it imports NextResponse

  einvoicePayload.mjs    The IRP payload for one invoice
  einvoiceCredentials.mjs Which IRP credentials a firm has set
  einvoiceLock.mjs       An invoice reported to the IRP is read-only
  secretBox.mjs          AEAD seal for the stored IRP password

  staffRules.mjs         Who an owner may add, and what they may do to them
  staffStore.mjs         The ONLY door to `User`      (imports Mongoose)
  clearData.mjs          What the danger zone deletes  (imports Mongoose)
  indexAudit.mjs         Schema indexes against the ones the database has
  company.mjs            The firm's letterhead, read from its `companies` row
  companyLogo.mjs        The firm's own logo: what is accepted (magic bytes, not
                         the filename), where it is kept, and the frame that
                         stops it being cropped. There is NO shared logo any
                         more — §6.25
  invoicePrefs.mjs       How a firm wants its documents to look. Presentation
                         ONLY, and §6.25 says why that line is hard
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
backend/                 NO LONGER USED. A FastAPI + Gemini service that
                         /upload used to POST to. Reading a bill now happens in
                         `app/api/invoice-extract/route.js`, inside this app,
                         against a model key that never reaches the browser
                         (§6.26). `NEXT_PUBLIC_AI_IMPORT_URL` is dead too.
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
`gst`, `weight`, `itemType`, `openingQuantity`, `lastQuantity`, `minQuantity`,
`reorderLevel`, `maxLevel`.

> **`lastQuantity` is dead data.** Nothing updates it from stock movement; only
> the item form writes it. Real stock comes from the item ledger. Never display
> it as "current stock".

- `uqc` is the **GST unit code** the IRP accepts (`KGS`, `NOS`, `MTR`…),
  deliberately not guessed from the free-text `unit`. `lib/uqc.mjs` stamps it
  onto every saved invoice line, so a bill keeps the code it was reported with.
- `minQuantity`, `reorderLevel` and `maxLevel` are **Sigfa's three levels** —
  ITMAST's MINLVL, ORDLVL and MAXLVL — and all three are **optional with no
  default.** An item that has never had one set is left out of the comparison
  rather than measured against an invented number: a wholesaler's minimum for
  steel plate is not a shop's for washers. Such an item is still reported when
  its stock runs out or goes negative, which needs no threshold. The re-order
  level normally sits ABOVE the minimum, and `lib/dashboard.mjs`'s
  `stockReason` is the ONE rule that reads all three (§6.40). The dashboard's
  stored alerts still raise only negative / out / below minimum.

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
- Per line: `challanNo`, `challanType`, `challanLineId`, `challanDate` — which
  challan line this bills (§6.39) — and `challanStock`, set by the SERVER from
  the challan: true means the challan already moved the stock, so this line
  writes no stock row
- Purchase M.R.I. (§6.41): header `mriNo` (its own series, shared with
  purchase challans; unique partial index per firm), `mriRemark`,
  `againstMriNo` (a Re-MRI; unique partial index — one Re-MRI per MRI),
  `mriLock` (written by a Re-MRI so concurrent ones conflict; means nothing on
  its own); per line `receivedQty`. On an MRI, `quantity` is the ACCEPTED
  quantity and may be 0 (lot rejected outright) — at least one line must be
  above 0 on a bill
- Dispatch: `shippedTo`, `dispatchFrom`, `transport`, `grNo`, `grDate`,
  `pvtMark`, `caseDetails`, `freight`, `weight`, `orderNo`, `orderDate`,
  `ewayBillNo`, `ewayBillDate`
- `partyBillNo` — **the OTHER party's own bill number**, as a String. On a
  purchase, the number the supplier printed on the bill they sent
  ("BS/2026-27/4417"). It is NOT `invoiceNo`, which is this firm's own
  sequence with a unique index on it — and conflating the two is exactly what
  the old AI import did: `parseInt(aiInvoice.invoiceNo)`, which collided with a
  real invoice when it parsed and wrote `NaN` into a required field when it did
  not. A String because a bill number carries a series prefix, a financial
  year and slashes, the same reasoning `custModel` gives for `phone`
- `partyTaxes[]` — extra overheads `{ name, rate, Amount, total }`
- `emailLog[]` — `{ to[], cc[], messageId, by, at }`, **append-only**, one row
  per mail the bill was sent in. Written by `/api/send-email` with `$push`
  **after** the provider accepts, never by the browser (§6.27)

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

### `challans` (`models/challanModel.js`) — sales and purchase challans

`challanNo` (own series per `type`, unique `{companyId, type, challanNo}`),
`type` (`Sale`/`Purchase`), `date`, `customer` (snapshot), `stateOfSupply`,
`stateCode`, `stockEffect` (Boolean, default true), totals, `status`
(`pending`/`partial`/`billed`, derived), transport fields, `partyChallanNo`/
`partyChallanDate`, `remarks`, `createdBy`/`updatedBy`/`editCount`. Lines:
`{ name, description, hsn, quantity, billedQty, cost, discount, gstRate,
taxableAmount, gstAmount, total, uqc, isService, receivedQty }`. `billedQty`
is written ONLY by `lib/challanClaims.mjs`. A purchase challan may be an
M.R.I. — the same `mriNo`, `mriRemark`, `againstMriNo`, `mriLock` fields as
the invoice (§6.41). Stock rows are keyed `SC-<n>` / `PC-<n>` in ItemLedger.

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
- `Counter`: `{ name, value }` — `invoiceNo`, `orderNo:<type>`,
  `challanNo:<type>`, `mriNo` and the stock-voucher counters. Unique per firm,
  so each firm's numbering runs independently
- `TotalSale`: legacy, effectively unused. The only model with no tenant plugin

### `companies` (`models/companyModel.js`) — the tenant

One row per subscribing firm: `name`, `legalName`, `gstin`, `phone`, `email`,
`website`, `address`, `city`, `state`, `stateCode`, `pincode`, bank details,
`active`.

- `legalName` is what the GST registration says when the shop trades under
  another name. Printed **under** the trading name, never instead of it: a
  customer looks for the name they know and an auditor for the registered one.
- `logo` — a `data:` URL on this row, capped at 150KB on the **decoded** bytes
  by `lib/companyLogo.mjs`. A deliberate, bounded exception to the rule that
  images do not belong in a database, taken because this app has no object
  storage (`cloudinary` is in `package.json` and imported in zero files) and a
  logo is a few tens of kilobytes. Everything that reads one goes through
  `logoSrc()` and everything that writes one through `storeLogo()`, so moving
  to object storage later is those two functions — read §6.25.
- `invoicePrefs` — a sub-document of **presentation-only** switches
  (`showLogo`, `showGstin`, `showPhone`, `showEmail`, `showAddress`,
  `showBank`, `showSignatory`, `paper`, `footerNote`). Every default is the
  value that reproduces TODAY's invoice, so the rows already in the database —
  none of which has this sub-document — render exactly as before. `_id: false`:
  it is a value object, not a record.

Also the e-invoicing block: `einvoiceEnabled`, `einvoiceUsername`,
`einvoicePasswordEnc` (`select: false`, sealed by `lib/secretBox.mjs`),
`einvoiceEnv`.

Deliberately **not** unique on `name` — two unrelated shops may genuinely
share one. `companies` **is** the tenant list, so it is the one collection the
tenant plugin must not apply to; the three routes that read it
(`api/company`, `api/company-update`, `api/company-logo`) scope by
`auth.companyId` explicitly and say so in a comment. **None of them reads a
company id from the body** — see §6.25.

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

### 6.21 A master is created from the field that needs it

SIGFA's four keys, read off the status bars in `SIGFA105.exe`, and they work on
**whatever field has focus** — on a bill, on a master screen, anywhere:

| Key | What it does |
|---|---|
| `Alt + A` | **Create** the master behind this field |
| `Alt + M` | **Alter** the record this field currently holds |
| `Alt + D` | **Delete** that record |
| `Alt + E` | Delete this GRID ROW — a different thing entirely |

`Alt+D` and `Alt+E` were briefly the same binding here, which meant a mis-key
dropped an invoice line instead of a master record. SIGFA's own status bar
prints `Delete Row (Alt + E)` beside `Delete (Alt + D)`; they are separate.

`lib/masterActions.mjs` owns the mapping: 14 field names → 6 master kinds, and
per kind the list/create/alter/delete endpoints plus `toPayload`.
`components/masters/useMasterActions.js` reads `data-master-field` (and
`data-master-value`) off `document.activeElement`, so **a field is wired by
tagging it**, not by a switch statement somewhere else.

> **An ALTER sends the WHOLE record, never the edited fields.** The alter
> routes rebuild the document from the body, so a partial body means
> `isService: Boolean(undefined)` → false and `uqc: ... || UQC_DEFAULT` → OTH —
> and `uqc` goes to the IRP. `alterPayload(kind, record, edits)` loads the
> record first and layers the edits over it. A source sweep in
> `master-actions.test.mjs` extracts each alter route's body identifiers and
> fails if `toPayload` omits one.

### 6.22 Every report's date filter is ONE resolver

`lib/reportPeriods.mjs`. Thirteen presets, and nothing else resolves a period:

- **The financial year runs 1 April to 31 March.** There is no per-firm
  accounting-year field on `companies`, so rather than assume a calendar year —
  wrong for every user of this app — the boundary is the constant
  `FY_START_MONTH`.
- **Quarters are FINANCIAL quarters.** Apr–Jun is Q1. A Q1 running Jan–Mar
  belongs to the previous year's books and would not tie to a GSTR-1.
- **A week starts on Monday** (`WEEK_START`), and Sunday belongs to the week
  that began the previous Monday — a naive `day % 7` puts Sunday at the start
  of the coming week, so a shop checking Sunday evening's takings sees an
  empty sheet.
- **A running period runs to its own end, not to today.** "This month" on the
  12th is the 1st to the 31st. The one place that cares is
  `previousPeriod()` in `lib/dashboard.mjs`, which cuts a half-finished month
  to the same elapsed days and *reports* the cut — that belongs to the
  comparison, not to the period.
- `queryWindow()` widens the Mongo filter by a day at each edge and leaves the
  exact cut to the pure module (§6.16).

`app/account-book/page.js` had its own two helpers before this —
`new Date().getMonth()` for the financial year and `toISOString()` for today —
so a laptop set to New York opened the book on the wrong year for eleven hours
every 1 April, and between midnight and 5:30am IST "today" was yesterday. Both
are gone; the comment where they were explains why.

### 6.23 An export is the report's own route, in its own format

There is **no separate export endpoint**, deliberately. Every report route
takes `format=json|csv|xlsx` and `lib/reportHttp.js` answers in that shape, so
the permission, the tenant scope, the filters and the figures are literally the
same code path. A second route would be a second place for the permission
table to fall out of step — and the one place it fell out of step would be the
one that hands over a spreadsheet of the whole book.

It also settles "the export must match the visible report": they are built from
the same object. The only difference the format makes is that a paginated
screen slices `rows` for display while the export gets the unsliced array.

- `lib/csv.mjs` is the ONE CSV writer. RFC 4180 quoting (a party name with a
  comma otherwise shifts that row's later columns by one — the sheet opens fine
  and an amount lands under "Balance Due"), and a leading quote on `=`, `+`,
  `-` or `@`, because a spreadsheet treats such a cell as a formula and
  "-Reliance Traders" is a plausible master entry.
- `lib/xlsx.mjs` writes `.xlsx` with no dependency — a ZIP of XML over
  `node:zlib`, the same decision `lib/password.mjs` made about `node:crypto`.
  **Numbers are written as numbers** with a display format, never as
  "1,234.50": a column of strings cannot be totalled, which is the whole
  reason to offer `.xlsx` beside `.csv`. Dates are Excel serials computed from
  the **IST** parts.
- An `.xlsx` export is checked by UNZIPPING it and verifying each entry's CRC
  against Node's own `zlib.crc32` — verifying with the writer's own `crc32`
  passed a deliberately broken CRC table.

### 6.24 A statement is the A/C Ledger with a letterhead

`lib/statements.mjs` calls `accountBook()` from `lib/accountBooks.mjs`
**unchanged** and then labels its lines. It computes no balance of its own, and
a `let running` in there would be a second running-balance implementation.

That matters because a statement is the only report that LEAVES the building:
it is emailed to a party who will check it against their own books. A statement
that disagreed with the ledger behind it is an argument with a customer that
the shop loses.

- **The side comes from the chart of accounts, never from the sign.** Group 27
  is Sundry Debtors, 28 Sundry Creditors. A customer who has paid in advance
  has a credit balance and is still a customer.
- **The same sign means opposite things on the two sides.** Dr is owed to the
  firm on both; on the customer side that is the ordinary receivable, on the
  supplier side it is an advance the firm has paid out. `balanceWording()` is
  the only place that knows this — printing a payable as a receivable is how an
  invoice gets paid twice.
- A party is matched by **GSTIN first**, name second: two shops can share a
  name, no two share a registration.
- The ledger query behind a statement is **not date-filtered**. The opening
  balance comes from everything dated before the window, so a date filter there
  would produce an opening balance of whatever the master was last typed as.
- **The Reference column is parsed out of the narration, and that is a known
  limitation.** `models/ledgerModel.js` has no document-number field; the
  posting path writes exactly three shapes ("By Invoice No: 12", "Receipt
  against Invoice No: 12", "Payment against Invoice No: 12"). The honest fix is
  a `docNo` on the ledger row written by the posting path — a migration and a
  change to posting, which reporting work is not allowed to make.

### 6.25 Branding is per-firm. There is no shared logo

`lib/company.mjs` used to export `COMPANY_LOGO = "/logo.jpg"` — one file in
`/public`, 100KB of it, rendered at the top of **every firm's** invoice. The
name, the GSTIN and the address had been moved onto the `companies` row some
time earlier; the logo had not, so the second firm to sign up printed the first
firm's mark on their tax invoices.

- **A firm with no logo prints nothing.** Any fallback is a stranger's mark on
  a tax invoice — the same decision this app already makes about a blank GSTIN.
- **The type comes from the magic bytes**, never the filename or the browser's
  Content-Type. The stored value goes into a `src` on a page served from this
  app's own origin, so a `data:text/html` accepted there is a script running as
  the app. SVG is deliberately not accepted for the same reason.
- `object-contain` in a fixed-height box, never `object-cover`, which crops to
  fill — the invoice framed it `rounded-full object-cover` and printed a wide
  wordmark as a circle cut from its middle.
- **`invoicePrefs` are presentation only, and that line is hard.** A setting
  that changes a FIGURE changes it for bills already issued, because a bill is
  printed from the invoice row plus the firm's CURRENT profile. A presentation
  setting applied to last year's invoice changes how it looks; a financial one
  makes it a different bill from the one the customer has and the one that was
  filed. `PREF_NAMES` is pinned by a test for exactly this reason.
- Every detail is gated **twice** — by the preference and by whether the firm
  filled it in. `showsDetail()` does both, because a component that checks only
  the preference prints "GSTIN:" with nothing after it.
- `components/CompanyBrand.jsx` is the one place that decides what a letterhead
  shows. The invoice, the statements and the printed reports compose the same
  two components in their own layouts.

### 6.26 An extraction is a guess. Exact matches apply; likely ones only suggest

`/upload` reads a purchase bill off a photograph.
`app/api/invoice-extract/route.js` calls the model;
`lib/invoiceImport.mjs` turns what comes back into a **draft**, which the
ordinary purchase screen receives through `sessionStorage` and a person saves
through the normal posting path. **Nothing in the import writes anything.**

The previous version POSTed the model's JSON straight to `/api/save-invoice`.
Six things were wrong with that, five of them writing bad data unseen:

1. `invoiceNo: parseInt(aiInvoice.invoiceNo)` — the supplier's bill number as
   ours (§5 `partyBillNo`).
2. `stateOfSupply: ... || "Delhi"` and `taxType: ... || "local"` — CGST+SGST
   versus IGST decided by a fallback, and not the model's to supply at all:
   the place of supply comes from the **party's master** (`placeOfSupply.mjs`).
3. Every figure was the model's arithmetic.
4. `items: aiInvoice.items || []` unvalidated, against a schema that requires
   name, quantity, cost, discount and total on every line.
5. No master matching at all — ledger rows under a party with no account, stock
   movements for items the master had never heard of.
6. It saved first and showed the user afterwards.

The rules now:

- **An exact match is applied; a near miss is only suggested.** "bharat steel"
  against "Bharat Steel " is the same name — `nameKey` already treats those as
  identical and `findNameClash` stops both existing. "Bharat Steel Pvt Ltd"
  against "Bharat Steels" is a GUESS, and applying it posts the bill to
  somebody whose balance is now wrong and whose statement shows a bill they
  never sent. `MATCH_APPLIED` and `MATCH_SUGGESTED` name the two outcomes.
- **Every figure is recomputed by `recalcItem`** — the same function the four
  billing screens use. The bill's printed totals are kept only as evidence that
  the rows were read right, and a difference is *reported*, never corrected:
  bending our rows to match a number read off a photograph is how a bill comes
  to disagree with its own lines.
- **Nothing readable is null, never a silent zero.** A quantity of 0 is a row
  to query; a quantity that was not read is a row to type in. `|| 0` makes them
  the same thing.
- **A comma used as a decimal point is refused, not stripped.** "1 250,50"
  stripped becomes 125050 — a hundredfold error in a rate, on a bill nobody
  would re-check.
- **A charge is not an item.** A bill's freight, loading and round-off rows read
  exactly like item rows, and the old import made them item master entries and
  stock movements — the firm had 1 of "Loading charges" on the shelf. They are
  flagged, never blocked, never offered as masters.
- **Where the bill is silent the MASTER fills in** (its HSN, its GST rate, its
  unit): the master is what the firm has decided, and a camera reading a
  smudged column is not better evidence. Where the bill *does* say and the
  master disagrees, the bill wins for that document and the difference is
  reported.
- The bill's rate seeds `purchasePrice` and `cost`, **never `salePrice`** —
  `resolveItemPricing` reads `salePrice` unconditionally (§9.19), which would
  price a purchase at what the firm sells it for.
- The model is never asked for one of our own fields. `EXTRACTION_FIELDS` drives
  the prompt AND the normaliser, and a test asserts the two agree.

### 6.27 Mail goes out over the firm's own domain. The route decides what it says

`/api/send-email` emails a bill to the party. `lib/invoiceEmail.mjs` decides
who, what the covering note says and what cannot be sent;
`components/EmailInvoiceDialog.jsx` is the screen. The module sends nothing.

Two things were wrong here, and the first one is the more interesting:

**The feature was complete and unreachable.** `sendInvoice()` sat in
`app/invoice/page.js`, the route worked, Resend was configured, and `email` was
already in `BUYER_FIELDS` so it reached the bill. There was no BUTTON. Reading
the route or the page's imports would have told you the feature worked. *Check
that a path is rendered before concluding it exists.*

**The route was a mail relay.** It took the recipient, the subject, the HTML
body, the filename AND the attachment bytes from the request and handed all
five to Resend, with nothing tying any of it to an invoice — so any signed-in
user could send arbitrary content with an arbitrary attachment to an arbitrary
address, **as the firm**, from the firm's own verified domain. Nothing was
recorded anywhere.

The rules now:

- **The route loads the bill.** The body supplies `invoiceNo` and
  `Invoice.findOne({ invoiceNo })` does the rest, tenant-scoped by the plugin
  (§6.14) — so a bill that is not this firm's cannot be mailed at all. The
  attachment's filename comes from the loaded invoice, never from the body.
- **`from` is the signed-in firm**, through `senderFor(firmName)`. `replyTo` is
  the signed-in user. Neither is ever read off the request.
- **Every address is validated server-side.** The dialog runs the same
  `sendProblem()` for a faster answer, but a direct POST reaches the route and
  only the route. Commas, semicolons and newlines all separate; addresses are
  deduped case-insensitively, because mailing the same accounts department
  twice over a paste in two casings is avoidable; at most `MAX_RECIPIENTS`
  including the Cc, because this is an invoice and not a newsletter and the
  firm's domain reputation is what pays for being treated as one.
- **The message is escaped** on its way into the HTML. It is free text typed by
  a person going into a mail signed by the firm.
- **The master's address is a DEFAULT, not a rule.** The bill's own frozen
  snapshot comes first, then the party's master; the person can change it or
  add others, and **nothing is written back to the master** — the address one
  bill went to is not the party's address.
- **Every send is recorded, after the provider accepts.** `emailLog` (§5) is
  `$push`ed so two people emailing the same bill at once cannot lose a row, and
  `by` comes from the session. A log the client could write is a log that says
  what the client wanted. If the mail goes out and the LOG fails, the response
  says sent-but-not-recorded: telling the shop it failed is the worse lie,
  because they would send it twice.
- The covering note carries the bill's number, date, total and **balance due
  only when there is one** — "Amount due: 0.00" on a settled bill invites a
  payment that has already been made. The old body was "Please find your
  invoice attached", which tells the reader nothing they can check without
  opening the attachment.

### 6.28 A billing request is an allowlist. The server does the arithmetic

`save-invoice` used to spread the request body into the new invoice
document. Everything the body carried was stored, including fields that were
never the client's:

- **`companyId`** — the tenant plugin stamps a firm only onto a document that
  has none (`stampDocs` leaves an explicit one alone, for the migration). A
  body naming another firm's id wrote the invoice into **that** firm's books
  while its ledger, stock and balance rows — built server-side — posted to the
  caller's. One request, two sets of books corrupted.
- **`irn` / `ackNo` / `einvoiceStatus`** — a bill could arrive "already
  reported", which freezes it against edit and delete (`lib/einvoiceLock.mjs`).
- **`emailLog`** — a forged send history.
- Every figure except `balanceDue`. `sale-alter` stored even `balanceDue` as
  sent. And `findPaymentAccount` matches the payment type against **every**
  account name, so a payment type naming a party booked the receipt to them.

`lib/invoiceInput.mjs` is now the only way a billing request reaches either
route:

- **`prepareInvoiceInput(body, { mode })`** builds a NEW object field by field
  from `PAYLOAD_KEYS` (the frozen screen payload, §8.4). `PROTECTED_FIELDS`
  (tenant, identity, timestamps, e-invoice, email log) are **refused by name**
  with a 400; unknown top-level keys are dropped. Line items drop unknown keys
  rather than refusing them — the screen spreads the whole item master
  (`_id`, `companyId`, `salePrice`…) into every line, so refusing would refuse
  every honest bill. `custId` is never taken from the request; the snapshot
  copies the master's own `_id`.
- **Every figure is recomputed with the screen's own functions**
  (`recalcItem`, `buildHsnTotals`, the `toFixed(2)` totals effect), so an
  honest screen and the server agree to the paisa and stored shapes do not
  change (`lib/billingMath.mjs` quirks are preserved). A request whose own
  `finalAmount`, line `total` or rate-based party tax disagrees with its lines
  by more than `TOTAL_TOLERANCE` is **refused, naming the line** — never
  quietly re-totalled, because the person saw a different number. An old bill
  whose stored line figures disagree with themselves (old AI imports) cannot be
  edited until that line is re-entered: deliberate.
- **Validation:** type ∈ Sale/Purchase, `return` boolean, `taxType` ∈
  local/central/blank (it picks IGST vs CGST+SGST), numbers are plain decimals
  (no `0x…`), dates real and within
  2000…+1 year, quantity > 0, rate ≥ 0, discount and GST 0–100, received ≥ 0,
  1–500 lines, order references all-three-or-none and of the bill's own type
  (none on a return), text fields typed and length-capped (an object in a name
  is how `{ "$ne": null }` would reach a query). Zero is preserved everywhere
  (`??`, never `||`): a line billed at 0 stays at 0 and does not pick up the
  master's sale price.
- **References are checked through tenant-scoped queries** in the routes:
  the party (`Customer not found`), every ordinary line's item (`unknownItems`
  — another firm's item is simply missing from the scoped `Item.find`), every
  order line a bill settles (`orderLineProblems` — the order must exist in this
  firm and the cited line must name the same item; `orderStatus` settles by
  line id alone, so without this one item could draw down another's pending
  quantity), and the payment account (`paymentAccountProblem` — must be the
  default Cash/Bank or in a cash/bank group). A line settling a verified order
  line needs no item-master entry: order prefill deliberately bills an item
  that has left the master (`orderPrefill`, `skipped`). A posting head ("Sales
  Account", the GST heads, "Round Off") is refused as the party
  (`partyProblem`, case-insensitive, checked on the stored name too); "Cash"
  stays allowed for counter sales.
- **All refusals happen before the first write.** Validation runs before
  `withTransaction`; reference checks run before `Invoice.create` /
  `findOneAndUpdate`, inside the transaction, with the session.
- **Double submits.** When the requested number is taken by a bill with the
  same fingerprint (party, date, type, money, lines) created within
  `DUPLICATE_WINDOW_MS` **by the same user**, `save-invoice` returns that bill
  with `duplicate: true` and writes nothing. `createdBy` (the session's user
  id, server-set, protected) exists for this: two clerks billing the same
  counter sale in the same minute are two sales. Bills from before `createdBy`
  are never matched. A raced unique-index clash (E11000) is a
  409 with a sentence, not a raw driver error.
- `sale-alter` still does **not** write `shippedTo`, `dispatchFrom` or
  `partyBillNo` — the edit screen does not reload the first two, so writing
  them would blank them. Unchanged, and pinned by the test.

**Not enforced, deliberately:** each line's `gstRate`/`hsn` against the item
master (an imported purchase keeps the supplier's printed rate — 
`invoiceImport`), and `taxType` against the place of supply (it is the
screen's own choice). An order's party is not compared with the bill's.

`scripts/invoice-input.test.mjs` covers all of it, including a replay of the
create route against a tenant-scoped, transactional in-memory store and a
sweep asserting every DB call inside both routes' transactions passes the
session.

### 6.29 Every report's filters live in its URL; every report downloads as Excel

**What was actually there** (checked before this change, because the brief was
partly wrong): the statement and the A/C ledger / cash / bank books exported CSV
and .xlsx from their own routes (`format=`, `lib/reportHttp.js`). The sales book
exported CSV only, built in the browser. **GST returns had no CSV** — only the
GSTR-1 portal JSON — and **the financial statements had no export at all**,
though the hub's badges claimed CSV for both. Statement and account-book *read*
a deep link once and never wrote the URL back; the order report read `type` and
`customer`; nothing else read the URL.

**Exports.** `lib/reportSheets.mjs` lays out the objects the routes already
build for the screen — it recomputes nothing — as the `sheets` array
`reportResponse` turns into CSV (first sheet) or .xlsx (every sheet), the same
contract as `statementSheets`. No new dependency: `lib/xlsx.mjs` writes it.

- `/api/sales-report?…&format=csv|xlsx` — the sheet on screen (month/date
  period sheet, bill-wise register, party-wise, item-wise) with
  `CSV_COLUMNS` headings, typed cells, and the route's own totals row. Returns
  stay at face value with a Document column and are subtracted in the totals,
  exactly as on screen; a meta row says so.
- `/api/gst-return?…&format=xlsx` — GSTR-1 as a Summary sheet (every table by
  number, row count or "Not built: needs …") plus one sheet per buildable table
  in the screen's columns, one row per rate line, the document's value on its
  first line only (so the column sums once per document), portal dates as real
  dates. GSTR-3 / 3B as one Table/Particulars/Amount/Note sheet, so they also
  take `format=csv`. **GSTR-1 CSV and any export of the e-return are refused
  (400) on purpose**: a CSV is one table, and the e-return is the portal JSON.
- `/api/financials?…&kind=&format=csv|xlsx` — all four statements, the one on
  screen first (and as the CSV). Trial balance as Group/Account/Row/Debit/Credit
  (credit balances positive in the credit column, as printed); trading, P&L and
  balance sheet in the horizontal Dr|Cr form with both totals; warnings in
  every sheet's meta.

**URL filters.** `lib/reportQuery.mjs` declares each report's filters once
(`REPORT_QUERIES`). The four new pages read a link **as their initial state**
(`useState(() => parseReportQuery(schema, searchParams).values)`), so the
first fetch is already the link's report — reading it in an effect let the
defaults' request race the link's. Every value is validated (`view=pdf` or
`2026-02-31` is dropped and the page keeps its default).
`components/reports/ReportUrlSync.jsx` writes the canonical query back with
`history.replaceState` on every change: no history entry per click, no
navigation, no loop (it never re-reads, and skips the write when the URL
already matches). Rules:

- A filter at its default is left out, so clearing a filter clears the URL.
- **Dates are always written** where a report has them — a default "this
  month" would otherwise reopen as the recipient's month.
- A **preset stays a preset** (`preset=prevQuarter`); dates only for Custom.
  All 13 presets and their IST resolution (`lib/reportPeriods.mjs`) unchanged.
- Existing link keys kept: the order report still reads `customer`.

Wired into sales book, GST returns, financials and the order report (read +
write), and statement and account book (write-back added; their existing
readers kept, now reading once even from an empty URL so the write-back is not
mistaken for a link; the account book's also reads `preset` and `daywise`).

**A pre-existing account-book bug, fixed because the write-back would have made
it permanent:** a link's `account` was applied on a `setTimeout` and then
overwritten by `loadAccounts` (which opens on the book's first account), and a
link's `group` was cleared by the tab effect — so "Open the A/C Ledger" from a
statement could open a different ledger. The link's account and group are now
held in a ref until their book's accounts have loaded, and a reply for a tab
already left is ignored.
The hub's **Purchase book** tile now opens on the purchase side
(`?side=Purchase`) — before, it opened the sales book.

**Not given URL filters:** the dashboard (a home screen, not a shareable
report), the customer ledger and stock ledger (they already open from
`?customerId=` / `?itemId=` links and have no other filter), the voucher
register, and invoice-range printing (a print batch, not a report).

Tests: `scripts/report-sheets.test.mjs` (real builders → workbook bytes read
back: headings, numeric and date cells, totals, period filtering incl. a
late-evening IST bill, returns, empty periods, 3,000-row book, filenames,
wiring) and `scripts/report-query.test.mjs` (parsing, invalid values, defaults,
clearing, presets, IST, round trips, replaceState-only wiring).

### 6.30 Inventory: one stock figure, three reports, alerts that remember

**The figure.** Stock = the item's `openingQuantity` + every receipt − every
issue, SUMMED from `itemledgers` (`lib/itemStock.mjs` `buildStockIndex`). The
dashboard, the billing screens (`/api/item-stock`), the financial statements,
the stock ledger page, the item master screen and the inventory reports all use
it. `Item.lastQuantity` ("Last Year Stock") is hand-typed and never current
stock; `balanceQuantity` on a ledger row is a cache nobody displays.

**What writes stock.** Invoices (rows keyed by the bare invoice number,
direction by `isInwardStock` — a return reverses its document) and the three
stock vouchers (keys `PRD-`, `GI-`, `GR-`). Edits delete the document's rows
and write the new ones; deletes remove them; all inside `withTransaction`.
`typeOfVoucher` says "Sale"/"Purchase" for returns too — the movement report
derives the real type from direction and prefix (`movementType`).

**Fixed (2026-10):** the stock vouchers and an opening-quantity edit now call
`recomputeItemBalances` like the invoice routes always did (the item edit
only when the opening quantity or the name actually changed), so a back-dated
production entry no longer leaves later `balanceQuantity` values wrong; and
`clear-transactions` now has a model for every collection in
`TRANSACTION_COLLECTIONS` — orders and productions had been listed and never
wired, so its own guard refused every clear.

**Reports** — *replaced by Sigfa's five stock reports, §6.40; `lib/inventoryReports.mjs`
is kept and tested but no longer behind `/stock-report`.* As first built (`/stock-report`, `/api/stock-report`, `lib/inventoryReports.mjs`,
read-only, `report:read`, CSV/xlsx/print/URL filters as §6.29):
- *Summary* — opening at the From date (master opening + movements before
  it), in, out, closing, minimum, status; search and status filter.
- *Movements* — every row in the period with its type, document, party, in,
  out and running quantity. The running quantity counts EVERY movement of the
  item in date-then-`_id` order before the type/document/search filters are
  applied. Paged on screen; capped at 20,000 rows per request (narrow the
  range). IST day boundaries.
- *Valuation* — as at the period end. **Costing method: standard cost —
  quantity × the item master's `cost`, the same basis as `stockValue` in the
  financial statements, whose figure IS the report's total.** Not FIFO or
  weighted average: ledger rows carry no cost, opening stock has no historical
  cost, GR slips and production outputs have none. Supporting either needs a
  cost on every movement (schema change + backfill) — not done.

**Persistent low-stock alerts** (`models/stockAlertModel.js`,
`lib/stockAlerts.mjs` rules, `lib/stockAlertSync.mjs` writes,
`/api/stock-alerts`). The rule is still `stockReason` against the optional
`minQuantity`. One OPEN alert per item per firm, enforced by a unique partial
index; raised once (upsert), updated when figures move (acknowledgement cleared
only when it gets WORSE), resolved when stock recovers; a later shortage is a
new alert. Synced when the alerts are looked at (dashboard, `/api/stock-alerts`)
— best-effort on the dashboard, which still renders if the sync fails, and
which hands the sync the stock it already summed (one ledger aggregation per
load). The writes are one `bulkWrite` in the session; the transaction's reads
run one after another. The unique index is built by Mongoose's autoIndex —
`scripts/sync-indexes.mjs` audits indexes and creates none, so a deployment
with autoIndex off must run `StockAlert.syncIndexes()`. A renamed item's
alert restarts under the new name; a full wipe (`clear-all-data`) leaves alert
history behind (open ones resolve on the next load). The
dashboard panel shows "Since", "New" and **Mark seen**. **Services are excluded**:
every invoice line writes a stock row, so a sold service used to read as
"negative stock".

**Known limitation, not changed:** renaming an item renames its stock rows but
not the invoice lines that name it, so editing an old invoice for a renamed item
is refused ("Not in your item master", §6.28). Fixing it means rewriting item
names on historical invoices, including ones reported to the IRP.


### 6.31 Accounting review: HSN grouping, rounding, purchase pricing, drafts, settled bills

**One HSN grouping.** `lib/hsnTotals.mjs` `hsnRateGroups` groups lines by HSN
code AND rate, sums raw and rounds each group once. Everything uses it: the
billing screen panel and the stored `hsnTotals` (`buildHsnTotals`, tax from
the line's `gstAmount`), the print and the GL (`buildHsnSummary` /
`lineTotals`, tax derived as taxable x rate), and GSTR-1 tables 4-7 and 12
(`rateGroups` / `hsnRows`, stored line figures, blank HSN filed as ""). It used
to key on the code alone and keep the FIRST line's rate. `buildHsnSummary` and
`buildHsnTotals` are keyed `hsn@rate` (`hsnKey`); render `row.hsn`.

**Rounding.** Lines stay unrounded (`recalcItem`, unchanged). Groups are rounded
once; anything totalled across groups adds the rounded groups. Table 4's
figure for a rate is the sum of table 12's rows at that rate; CGST/SGST are
halved once per group. The print's totals box is the HSN table's footing, the
same figures the GL posts. Where several groups exist, that footing can differ
from the raw-sum `finalAmount` by a paisa per group; the GL round-off absorbs
it, as before. The e-invoice payload rounds per line (IRP rules), unchanged.

**Purchase pricing.** `resolveItemPricing(item, list, { side })`: a purchase
line starts from `purchasePrice` (falling back to `salePrice` when none is
set); a sale from `salePrice`. A party's price list wins on either side. Only
the starting rate of a NEW line changes.

**Drafts.** The only draft hand-off is the read-in bill (sessionStorage,
`IMPORT_DRAFT_KEY`). It is tagged with its screen (Purchase, not a return) and
the firm and user who read the photo; `importParcelVerdict` decides. The
browser-wide `localStorage` keys `invoiceNo` (written, never read) and
`selectedCustomer` (read, never written) are gone from the billing screen.
`lib/localStorageHelper.js` and `components/clearLocalStorage.jsx` are unused.

**Settled bills.** Allocations live on voucher lines and name a bill by type
and number. `delete-invoice` and `sale-alter` now refuse (409), inside their
transaction, to delete, renumber, re-type, turn into a return, move to another
party, or cut `balanceDue` below what vouchers have settled against an invoice
(`lib/billAdjust.mjs` `settledBillProblem`, `lib/openBillsFor.mjs`
`settledAgainst`). `Invoice.againstInvoiceNo` is declared but nothing writes or
reads it; allocations do not need it. Not handled: allocations orphaned
BEFORE this check (no data was rewritten), and a voucher saved at the same
instant as the invoice is deleted (the two transactions write different
documents, so neither conflicts).

`scripts/backfill-hsn-totals.mjs` derives rows through the new grouping, so a
dry run now also lists invoices whose stored rows used the first-rate-wins
grouping. `--apply` would rewrite those rows; nothing else reads them.


### 6.32 Errors, feedback, logging, and the Next.js 16 config

**No `alert()`.** Screens report through `components/ui/notice.jsx`
(`useNotice` + `<Notice>`), which is the inline banner the app already drew by
hand (`border-destructive/40 bg-destructive/10`, the `success` colours).
Confirmations for destructive actions stay `window.confirm` / `window.prompt`
(delete from the home picker, the typed phrase on Setup).

**Reading an answer.** `lib/apiResponse.mjs` `readResponse(res)` never throws,
reads `error` or `message` (routes differ; the auth gate sends `message`), and
treats a 2xx without `success: false` as success (delete-cust and delete-hsn
answer success with `{ message }` only -- the home screen used to report a
successful customer delete as "Failed to delete: Customer deleted").
`errorMessage` never shows text that looks like an exception.

**500s.** `lib/tenantRoute.mjs` passes every tenant route's response through
`lib/serverError.mjs` `hideInternalError`: a 500's body is logged (with a short
ref) and the browser gets "The server ran into a problem (ref xxxxxxxx)". A
Mongoose `ValidationError` sent as a 500 becomes a 400 naming the fields.
Routes still `return { error: err.message }, 500` in their own catch -- the
wrapper is what keeps that off the screen. 4xx and 502/503 pass untouched.
The auth routes do the same in their catch.

**Downloads.** Report exports fetch first (`lib/downloadFile.mjs`,
`components/reports/useReportDownload.js`), so a refused export is a message
on the screen rather than raw JSON in place of the app.

**Dates.** New documents start at `istToday()` (lib/istDate.mjs), not the UTC
date, which is yesterday until 05:30 IST.

**Sign-in redirect.** `?next=` on /login is only ever a path on this site
(`safeNextPath`).

**Logging.** The temporary per-query tenant logging is gone, as are the
debugging `console.log`s. `lib/mongodb.js` keeps its one "connected" line.

**Next.js 16.2.4** (installed): `next lint` no longer exists and the `eslint`
key in next.config is ignored with a warning, so `npm run lint` is
`eslint .` (ignores in eslint.config.mjs) and the key is gone.
`middleware.js` is deprecated in favour of `proxy.js` (a warning; it still
runs). It has NOT been renamed: `proxy.js` always runs on the Node.js runtime
rather than the edge, having both files is a build error, and the move needs
a deploy to confirm the gate. To migrate: `git mv middleware.js proxy.js`,
rename `export async function middleware` to `proxy`, keep `config.matcher`,
then check sign-in, a 401 on an API call signed out, a 403 for a biller on a
report, and the `/login` -> `/` redirect when signed in.
`eslint-config-next` is 15.1.0 against Next 16; it works through FlatCompat.


### 6.33 The pending migrations

`MIGRATIONS.md` is the operator checklist for `backfill-stock-kind`,
`sync:indexes` and `backfill:gl-legs`. It covers the order (1 -> 2 -> 3), the
checks to make before `--apply`, the verification queries and rollback. All
three now:

- turn Mongoose autoIndex/autoCreate off before any model is compiled
  (`quietMongoose` in scripts/_shared.mjs), so a report run cannot build an
  index
- put every write after the `--apply` gate
- delete nothing to make data fit

What each script does now:

- **sync:indexes** finds stale per-firm unique indexes as well as global ones
  (`staleUniques`), and matches indexes on their options, not only their keys
  (`satisfies`, `indexConflicts`). It checks duplicates in each index's own
  scope (`duplicatePipeline`), builds the declared indexes first, and drops a
  stale index only once its replacement is confirmed (`replacementFor`).
  `users` is audited too.
- **backfill-stock-kind** works on the raw collection and stamps only rows
  with no kind. It refuses if a firm would then hold one FR number twice
  (`lib/stockKindBackfill.mjs`), and it backs up first.
- **backfill:gl-legs** keys every head by (companyId, name) and posts each
  invoice in its own transaction, re-checking inside it, so a rerun posts
  nothing twice. It needs a replica set. It blocks on party-group heads and on
  case-clashing heads, and settles the running balances of every head it
  affects. The pure parts are in lib/glBackfill.mjs (`netMovesByFirm`,
  `matchHeads`, `postedHeads`, `headDrift`, `runningBalances`).

Tests: scripts/migrations.test.mjs. No database is involved; the scripts'
step order is checked from the source.


### 6.34 Release-readiness audit fixes

- **An invoice billed to the cash account itself.** Edit and delete reverse
  the party by its derived delta and every other account by its rows. When
  the party IS the cash account, its cash leg sits under the party's own name
  and was dropped with the party's rows; the till kept the money.
  `withPartyCashLeg` (lib/invoicePosting.mjs) adds that leg back. It
  recognises the leg by its shape (a row owned by the party whose contra is
  the party) and takes the amount from the derived `cashDelta`, never from the
  party's row total, because an invoice last edited by the old sale-alter has
  stale party rows.
- **Ledger head names are reserved** (`headNameProblem`, lib/invoiceGl.mjs).
  A party in a party group (by the chart of accounts, so legacy spellings and
  firm-defined customer groups count) may not take a head's name, and a real
  head may not be renamed.
- **Sign-in checks every account with the address.** An email is unique per
  firm, so it can appear in more than one. Only active accounts in active
  firms count. If two of them match the same password, sign-in refuses rather
  than guessing. Passwords are capped at 1024 characters, both at sign-in and
  in the password rules.
- **The tenant stamp refuses, inside a request, a document naming another
  firm** (`stampedCompanyId`). Migrations run unscoped and are unaffected.
- **GSTR-1:**
  - The B2CL limit is Rs 1 lakh from 1 Aug 2024 (Rs 2.5 lakh before), by
    the document's date.
  - A small unregistered credit note is netted in B2CS only. CDNUR holds B2CL
    notes only (typ "B2CL").
  - The e-return must be one whole calendar month.
  - GSTR-3B 3.1(a) leaves 0% supplies out and says so.
  - The GST route validates dates strictly.
- **CSV exports:** a negative number stays a number. Balances export as an
  amount beside Dr/Cr.
- **Electron:** no Node.js in the window (`nodeIntegration` off, context
  isolation and sandbox on), and navigation is kept on the app's origin.
- **Transactions:** no `Promise.all` over a transaction's session; MongoDB
  does not support parallel operations there.

Tests: scripts/release-audit.test.mjs. Every scripts/*.test.mjs is now in
`npm test` (unique-name.test.mjs was missing).

---

### 6.35 Rate limits, alert permission, Next 16 lint

- **Rate limits** (`lib/rateLimit.mjs` rules, `lib/rateLimitStore.mjs` counter, `models/rateLimitModel.js`). Fixed windows, counted in MongoDB with one atomic `$inc` upsert, because an in-memory counter resets in every serverless instance. Keys are HMACs under `AUTH_SECRET`, never the raw email or IP; a TTL index (built by Mongoose autoIndex, not by `sync:indexes`) deletes old counters. Not tenant-scoped (sign-in happens before there is a firm).
  - Sign-in, per 15 minutes: 30 per network; 10 per email address from one network (cleared on success); 100 per email address from anywhere. All counted before any scrypt.
  - Sign-up: 5 per network per hour, counted after the form validates.
  - Emailing a bill: per user per hour (`EMAIL_HOURLY_LIMIT_PER_USER`, default 40), then per firm per day (`EMAIL_DAILY_LIMIT`, default 200). The firm is only counted once the user is allowed.
  - Refusals are 429 with `Retry-After` and `code: "rate_limited"`.
  - The network address is trusted only on Vercel (`VERCEL=1`) or with `TRUST_PROXY=true`; otherwise per-network limits are skipped and only the per-address ones apply. IPv6 is counted per /64.
  - Known trade-off: about 100 failed tries in 15 minutes, from several networks, still locks a real address out until the window ends. An edge/WAF rule is still worth adding on top.
- **Stock alerts:** acknowledging (POST) now needs `master:write`; GET still needs `report:read`. Every role with `report:read` also has `master:write`, so nobody lost access.
- **package.json:** removed the `export` script (`next export` no longer exists in Next 16); `eslint-config-next` 16.2.4 to match `next`; `jspdf` declared (it was only installed through `html2pdf.js`). `eslint.config.mjs` now spreads `eslint-config-next/core-web-vitals` directly instead of going through `FlatCompat`, which cannot read v16's flat config. Needs `npm install`, then `npm run lint`, to confirm.

### 6.36 First lint run on Next 16 (eslint-config-next 16.2.4)

56 problems (43 errors, 13 warnings) on the first `npm run lint`. Fixed:
- `app/company/page.js` rendered `<CompanyLogo>` without importing it: the owner's company page threw as soon as a logo was set. Now imported from `components/CompanyBrand`.
- `react-hooks/refs`: `useBillingKeys` and `MasterShortcuts` wrote `latest.current` during render (now in a layout effect); `useNotice` read a ref during render (now `useMemo` over the stable `show`/`clear`).
- `react-hooks/use-memo`: `useMemo(lastMonth, [])` and `useMemo(monthBounds, [])` now take inline functions.
- Two unescaped apostrophes in JSX.

Not fixed, kept visible: `react-hooks/set-state-in-effect` (~32 sites, mostly `useEffect(() => { load(); }, [load])` and form resets on open) is set to **warn** in `eslint.config.mjs`. It costs an extra render; it is not a bug. Move each to a data hook or a `key`-based reset over time. The 13 existing warnings (exhaustive-deps, `<img>`, one unused disable, tailwind default export) are unchanged.

### 6.37 Hindi insights on the dashboard (text + voice)

- **Card:** `components/HindiInsights.jsx`, at the top of the dashboard. Fixed Hindi sentences built by `lib/hindiInsights.mjs` from the SAME `/api/analytics` response the cards use (`factsFrom` reads, `insightsFrom` words) -- no figure is recomputed. Amounts are spoken rounded in lakh/hazaar/crore (`rupeesInHindi`); the exact figure is on the card below.
- **Voice:** the browser's Web Speech API, `hi-IN`, sentence by sentence (`speechChunks`; Chrome cuts long utterances). Free, nothing leaves the device. If the device has no Hindi voice the card says so and how to add one (Windows: Settings → Time & language → Speech).
- **AI summary (optional):** `/api/insights-ai` (report:read). GET says whether a key is configured; POST takes the facts, rebuilds them with `cleanFacts` (known fields, clamped numbers, one capped name -- the body is never forwarded) and asks the model to reword the fixed sentences. Same env as the bill reader: `INVOICE_AI_KEY`, `INVOICE_AI_URL`, `INVOICE_AI_MODEL` (or `INSIGHTS_AI_MODEL`). Capped per firm per day by `AI_INSIGHTS_DAILY_LIMIT` (default 50). Labelled AI-written on screen; dropped when the figures change.
- The largest debtor is named only when the receivables rows are page 1 with no search (`topParty`).

### 6.38 Bill reader: every kind of bill, not only purchases

- `/upload` reads sale bills, purchase bills, credit notes and debit notes. `lib/invoiceImport.mjs`: the `supplier*` extraction fields now mean the document's ISSUER, `buyer*` its addressee (with phone/address/state), plus `documentKind`.
- `resolveKind`: which side is this firm (`ourSide`, GSTIN first, then exact trading or legal name) + the document's kind → sale / purchase / sale return / purchase return (`kindFrom`). Debit notes are never guessed (a GST debit note is a supplier's price rise; a trade one is a buyer's return) -- the person chooses. Auto with no answer gives `kind: null` and a blocking question.
- The party is the side that is NOT us; proposed new masters are customers (Sundry Debtors) or suppliers by kind; new items seed `salePrice` on sales, `purchasePrice`/`cost` on purchases. `partyBillNo` only when the party issued the document; our own printed number is reported (Vyapaar saves under its next number).
- The draft carries `target` and `route`; the parcel opens only on that billing screen. The billing screen now applies `draft.taxType` (from the two GSTINs) -- it used to stay at the radio's 'local' default.
- `/api/invoice-extract` takes `kind`; `{ extraction, kind }` re-drafts without the model (changing the type after reading). Photo reads capped per firm per day: `BILL_READ_DAILY_LIMIT` (default 200).
- A matched party whose group contradicts the kind (supplier on a sale) gets a check warning.
- Still open, app-wide: the tax-type radio on a TYPED bill is manual and defaults to local; it is not derived from the party's state.

### 6.39 Sales and purchase challans (SIGFA's SC / PC)

*One implementation.* A second, partial challan design (`lib/challan.mjs` with `scripts/challan.test.mjs`: challans that never move stock, no screens or routes) was written in parallel and is superseded by this one, which follows SIGFA's per-challan stock effect. Nothing imports `lib/challan.mjs`, and its test is not in `npm test`; both files can be deleted.

Read out of `SIGFA105.exe` (§6.19): MKEYs `SC` Sales Challan and `PC` Purchase Challan, printed "SALES CHALLAN" / "PURCHASE CHALLAN"; a per-challan stock-effect flag (`Dsale` — SIGFA's stock query counts only `Dsale='Y'` lines); invoice lines carry `Challan` + `ChRefNo`; pending = challan qty less what invoices took; "Pending Challan [Alt+H]" on the invoice screen; "Please Select Challans With Same Effect Value"; "Can't Delete, Used In …"; "Quantity Is Less Than Quantity Entered Against This Challan".

- **Model** `models/challanModel.js`: one collection, `type` Sale|Purchase, own number series per type (`lib/getNextChallanNo.js`, counter `challanNo:<type>`), unique `{companyId, type, challanNo}`. Lines carry qty, rate, discount, GST and `billedQty` (written only by `lib/challanClaims.mjs`). Party snapshot as on invoices. `stockEffect` default true.
- **Rules** `lib/challanStatus.mjs` (pure): status pending/partial/billed, totals via `recalcItem`, stock rows, claims/net claims/apply (over-billing refused), edit/delete guards, picker, print refs. Input checking `lib/challanInput.mjs` (billed figures, totals, status never accepted; line ids must be existing ObjectIds, once).
- **Stock**: a challan with stock effect writes ItemLedger rows keyed `SC-<n>` / `PC-<n>` (`writeChallanLedgerRows`), typeOfVoucher "Sale Challan"/"Purchase Challan". **Posts nothing to the accounts.**
- **Billing**: invoice lines carry `challanNo/challanType/challanLineId/challanDate` and a server-set `challanStock`. save-invoice and sale-alter check the refs (same side, same party, same item, no mixing stock effects), stamp `challanStock` from the challan, and **skip stock rows for those lines** (`invoiceStockLines`). Claims: save → claim, alter → net difference, delete → release. Returns cannot bill a challan; a line bills an order or a challan, not both.
- **Screens**: `/challan` (register / pending challan book, Sale|Purchase, Pending|Billed|All; a purchase challan MRI that rejected every lot shows "Nothing accepted"), `/challanadd?type=` (make/alter), `/challan/print`. On the sale/purchase screens: "Pending challan [Alt+L]" (SIGFA's Alt+H is shortcut help here). Invoice print lists "Challan No.".
- **Home page**: Sales Challan is a row in the Sales section (after Sale Return) and Purchase Challan in the Purchases section (after Purchase Return), each with Create / Alter-Delete / Pending challans and a pending count.
- **Renames** of a party or item cascade into challans. Clearing transactions clears challans.
- **Not done (SIGFA has them)**: Transfer Challan (branches), carrying pending challans into a new year, returns against a challan, "Sales Challan" option in the Sales Book, the "Accept qty more than challan" setup switch (over-billing is refused), a firm-level "Stock Effect With Challan" default (it is a tick box on each challan, default on).
- **Financials note**: an unbilled stock-moving challan changes closing stock with no matching sale/purchase entry, as in SIGFA.

### 6.40 Sigfa's stock reports hold no figure of their own (supersedes the report half of §6.30)

`/stock-report` serves five of Sigfa's stock reports — **Stock Summary, Stock
Summary Value Wise, Stock Short List, Stock Aging Analysis, Stock Day Book** —
from one page and one route. `lib/inventory.mjs` has the arithmetic; the route
and the page compute nothing, and a test asserts neither contains a `reduce`.

The column captions are **Sigfa's own, read out of the binary**, not invented:
`Opening Quantity`, `Rcpt. Qty.`, `Issue Qty.`, `Balance Qty.`, and on the day
book `Vch Type`, `Voucher`, `Party Name`. The shortfall column is headed
**`Required`**, which is the word Sigfa's own stock warning uses beside
`Minimum Level` and `Re-Order Level`.

**Four figures this module is forbidden to have an opinion about:**

- **The closing quantity is `buildStockIndex`'s** (§6 and `lib/itemStock.mjs`).
  A window that reaches today foots to it exactly, and a test pins that — if
  the two disagree, the stock sheet and the stock line under an invoice item
  are two answers to one question. Neither `Item.lastQuantity` nor a row's
  `balanceQuantity` is read anywhere; a test asserts the words do not appear.
- **What counts as low is `lowStockRows`'s** (`lib/dashboard.mjs`). The Short
  List calls it, so the dashboard tile and the printed sheet cannot drift.
  `STOCK_REASONS` has five — negative, out, below, reorder, over — and
  `DASHBOARD_REASONS` has the three the tile shows: an item between its
  re-order level and its maximum is a purchasing question, and a tile that
  fired on it would be permanently full.
- **The weighted average rate is `itemWise`'s** (`lib/salesReports.mjs`), whose
  `rate` is already taxable value over quantity across the purchase bills, with
  returns netted off.
- **Valued at cost, this sheet IS the balance sheet's closing stock.**
  `lib/financials.mjs`'s `stockValue` is the figure the balance sheet carries,
  and a test asserts the two are the same number — including that a NEGATIVE
  quantity is valued rather than skipped.

**The period split.** `Opening Quantity` is the master's opening plus
everything dated before `from`; receipts and issues are the window's; `Balance
Qty.` is the sum. The same arithmetic `accountBook()` does for a party, and for
the same reason: an opening computed from before the window is the only way a
back-dated entry lands in the right place.

**Five of Sigfa's seven valuation bases, and two refusals.** Sigfa offers
`Weighted Rate : Fifo Basis : Lifo Basis : On Purchase Price : On Last Purc
Price : On Cost Price : On MRP`. `ItemLedger` has **no rate column** — every row
is quantities and a date — so a FIFO or LIFO *valuation* cannot be computed from
it, and both are listed, refused with the reason, and shown disabled on the
screen rather than quietly dropped. A route asked for one answers **400**: a
sheet headed FIFO that was valued some other way is the one mistake here that
would be carried into a balance sheet. A missing rate is **null, never zero** —
zero writes the stock off — and the headline total goes null the moment one row
is unvalued, with the valued subtotal and the count of what was left out
printed beside it.

FIFO **ageing** is a different question and IS done properly, because ageing
needs only quantities and dates: receipts are consumed oldest-first by the
total issued, and what survives is the stock still on hand with the date it
came in. An over-issue is covered by the next receipt before any of it is
treated as stock, or a shop that billed before the bill arrived would show the
same goods as both missing and sitting on a shelf. Stock of unknown age goes in
the OLDEST slab, which is the truthful place for it.

**A sales return is told from a sale by its DIRECTION.** The ledger writer
records only `"Sale"` or `"Purchase"` and not the return flag
(`lib/itemLedger.mjs`), so inward on a Sale can only be a return and outward on
a Purchase can only be a return — which is exactly
`isInwardStock({ type, isReturn })`. The three stock vouchers are told apart by
their key's prefix (`PRD-`, `GI-`, `GR-`), because `typeOfVoucher` is hardcoded
to `"Production"` for all three.

The page ignores a reply for a sheet it has already left (`latest` ref, as
the other report pages do) — switching chips quickly used to let a slow, older
reply overwrite the sheet on screen.

Two of the five reports take **no date range** — a level and an age are about
the stock on the shelf now — and the screen says "As on" instead of offering a
filter that could not change the answer.

### 6.41 Purchase M.R.I. (SIGFA's material receipt note)

Read out of `SIGFA105.exe`: an MRI is not a document of its own but a Purchase Invoice or Purchase Challan flagged as one (`Subkey='MI'`, menus "Purchase Invoice & MRI" / "Purchase Challan & MRI"), with its own MRI series, a remark, and Received / Accepted / Rejected quantities ("Accepted Qty. Is More Than Received Qty."). Rejected material taken in again is a Re-MRI against the earlier one ("Ag. MRI No."); "List Of Pending MRI [Alt+H]" is every MRI with rejected material and no Re-MRI yet (`RCQty>Qty and MRINO not in (AgMRINo…)`). Reports: Rejected Material Register, Party Wise Rejected Material.

- **Rules** `lib/mri.mjs` (pure, `scripts/mri.test.mjs`). **DB half** `lib/mriSave.mjs`: the number series (counter `mriNo`, ONE series across bills and challans, nudged past the highest used on either; its queries run one after another — a transaction's session takes one operation at a time), the Ag. MRI No. check (exists, same supplier, has a rejection, not already re-MRI'd, not itself), and the guards.
- **Posting is unchanged.** `quantity` on the line stays the ACCEPTED quantity — billed, taxed and stocked exactly as before — and `receivedQty` is stored beside it. Rejected = received − accepted, never negative.
- **Zero accepted.** A lot rejected outright is a line at quantity 0, allowed on an MRI only and only when something was received; `invoiceStockLines` skips such a line. A **bill** must still accept something on at least one line ("Nothing was accepted, so there is nothing to bill") — a delivery rejected outright is recorded as a **purchase challan** MRI, which bills nothing.
- **Fields.** Invoice and challan headers: `mriNo`, `mriRemark`, `againstMriNo`, `mriLock`; lines: `receivedQty` (§5). Unique partial indexes per firm on `mriNo` and on `againstMriNo` in each collection. The request carries `mri: { on, remark, againstMriNo }` — one more key in the frozen billing contract (`PAYLOAD_KEYS`, now **33**: the 31 originals, `partyBillNo`, `mri`) — never the number. A received figure on a document that is not an MRI is refused, so the screens drop them when the tick is cleared.
- **A blank Received means "received what was accepted"** and is stored as the accepted figure. On reload the screens show a received figure equal to the accepted one as blank again, so raising the accepted quantity on an edit is not refused against a stale copy.
- **Re-MRI guards.** A Re-MRI writes `mriLock` on the MRI it re-inspects inside its transaction, so two Re-MRIs at once — or a Re-MRI racing an alter/delete of that MRI — conflict and only one commits (backed by the unique `againstMriNo` index within each collection). An MRI that a Re-MRI points at cannot be switched off, moved to another supplier, edited to reject nothing, or deleted (`assertMriDeletable`).
- **Routes.** `save-invoice`, `sale-alter`, `challan-add`/`challan-alter` (via `lib/challanSave.mjs`) call `mriFields({ session, mri, previous, party, items })` inside their transaction; `delete-invoice` and `delete-challan` call `assertMriDeletable`. `/api/mri?view=register|pending|rejected|party&party=&from=&to=` (read-only, `invoice:read`; the date range is IST days via `istDayWindow`, applied to the MRIs AFTER Re-MRIs are matched); `/api/next-mri-no` (peek, `invoice:write`).
- **Screens.** `components/billing/MriPanel.jsx` on the purchase bill and the purchase challan form (tick M.R.I., number peek, remark, Ag. MRI No. from the supplier's pending list — cleared when the supplier changes); Received and Rejected columns appear on the lines. `/mri` — the four registers, printable; a table is only drawn from rows fetched for the view now chosen. Home page: "Purchase M.R.I." row in the Purchases section after Purchase Challan (create on a bill `/purchaseadd?mri=1` / on a challan `/challanadd?type=Purchase&mri=1`, register, pending, rejected, party wise) with the pending count. The bill and challan prints show the MRI No., received/accepted/rejected and the rejected lines.
- **Not done (SIGFA has them)**: the automatic Debit Note for (bill amount − accepted purchase) — there is no debit note voucher yet; `rejectedValue` is the figure it would use. The M.R.O. slip on the sales side. Receipt Slip & M.R.I. (store receipts outside a purchase). A separate MRI date (the document's date is used).


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
| `save-invoice` | POST | Create. Transactional. Allowlisted and recomputed by `lib/invoiceInput.mjs` (§6.28); refuses protected fields, unknown items, a non-cash/bank payment account; returns the existing bill for a double submit. Posts both legs, writes ledger + stock, recomputes |
| `sale-alter` | POST | Edit. Same allowlist and arithmetic (§6.28). Reverses the old posting and applies the new one. Looks the row up by `originalInvoiceNo` because `invoiceNo` is itself editable |
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

### Challans and M.R.I.
| Route | Method | Notes |
|---|---|---|
| `challan-add` / `challan-alter` | POST | Make and alter a sales or purchase challan; stock rows in the same transaction; a purchase challan may be an M.R.I. (§6.39, §6.41) |
| `delete-challan` | POST `?challanNo&type` | Refused once anything is billed, or while a Re-MRI points at it |
| `challan` / `get-challan` | GET | Register (`?type&status=pending\|billed&customer&from&to`), and one challan with the invoices that billed it |
| `challan-pending` | GET | A party's pending challan lines, for the bill's picker |
| `next-challan-no` | GET `?type` | Peek, like `next-invoice-no` |
| `mri` | GET `?view=register\|pending\|rejected\|party&party&from&to` | Purchase M.R.I. registers; read-only (§6.41) |
| `next-mri-no` | GET | Peek at the next M.R.I. number; reserved on save |

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
| `account-book` | GET `?kind=cash\|bank\|ledger&account=&from=&to=&format=` | Cash Book, Bank Book, A/C Ledger. `format=csv\|xlsx` downloads the same figures; a group-wise book becomes one worksheet per account (§6.23) |
| `statement` | GET `?side=customer\|supplier&account=&preset=&from=&to=&view=&format=` | Customer and supplier statements (§6.24). Behind `ledger:read`, the same rule as `account-book`, because it IS one account's history |
| `financials` | GET `?kind=trial\|trading\|pl\|balance&from=&to=` | All four statements from one route, so they agree with each other. `&format=csv\|xlsx` downloads them, `kind` first (§6.29) |
| `sales-report` | GET `?view=book\|party\|item&side=&grain=&scope=&month=` | Sales/Purchase Book (month/date/bill), Party-wise, Item-wise (§6.18). `&format=csv\|xlsx` (§6.29) |
| `gst-return` | GET `?view=gstr1-ereturn\|gstr1\|gstr3\|gstr3b&from=&to=` | The e-return returns the portal's JSON and the filename; the rest return numbered tables. `&format=xlsx` for all three, `csv` for GSTR-3/3B only (§6.29) |
| `analytics` | GET `?preset=&from=&to=&grain=&side=&search=&page=` | The whole dashboard in one response, so the cards and the tables cannot disagree |
| `open-bills` | GET `?party=&type=` | A party's unsettled bills, for Against Bill (§6.18) |

Every one of these validates its period with `lib/reportPeriods.mjs` on the
server — an unknown preset is refused rather than quietly defaulted, because a
preset this build does not know means the caller and the server disagree about
which period they are discussing.

**The four report routes compute nothing themselves.** Every figure comes from
the matching `lib/*.mjs`, and `scripts/*.test.mjs` asserts the route contains
no `reduce(` of its own. Keep it that way: a route that totals is a route whose
total can disagree with the module the tests exercise.

### Account and staff
| Route | Method | Notes |
|---|---|---|
| `company` | GET | The firm's own profile. Readable by any role — a biller cannot print a bill without the letterhead. Projects by field name, so a credential column added later is not served to the browser |
| `company-update` | POST | Owner-only. Allowlists the profile fields AND the invoice preferences field by field — never `...body` — and seals the IRP password with `lib/secretBox.mjs` |
| `company-logo` | POST | Owner-only. Upload (`{data}`) or remove (`{remove:true}`) the firm's logo. **Reads no company id from the body**, so there is nothing to manipulate; validates the decoded bytes (§6.25) |
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
`send-email` (POST — email a bill to the party, through Resend. Takes
`invoiceNo` and **loads the bill**; the sender, the filename and the recipient
validation are the route's, not the body's. Records the send on the invoice.
Behind the same permission as `/invoice`. §6.27),
`clear-all-data` (DELETE — body `{"confirm": "DELETE ALL DATA"}`),
`clear-transactions` (DELETE — body `{"confirm": "CLEAR TRANSACTIONS"}`),
`item-stock` (GET — current stock per item, summed from the stock ledger in
**one** `$group`; never a query per item),
`invoice-extract` (POST — read a purchase bill off a photograph and return a
DRAFT; §6.26. Behind `master:write`, the same permission as `/upload`, because
an import creates masters and spends the firm's model budget per call. Writes
nothing, and `maxDuration = 60` because a vision call on a phone photo takes
ten to thirty seconds).

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
           .report-sheet   — opt a sheet into the A4 print rules below
           .report-table   — repeats thead on every page, keeps tfoot,
                             right-aligns .num, prints black on white
           .report-party   .report-party-label  .report-party-name
           .report-row-opening  .report-note
Modals     .modal-overlay  .modal-card  .modal-title   (non-Radix prompts)
Home       .nav-tile  .nav-tile-icon  .stat-card  .stat-label  .stat-value
Misc       .chip  .empty-state  .no-print
Print      .invoice-doc  .invoice-print-page  .inv-table  .inv-scroll
           .pdf-export  .pdf-export-wide
```

**A report sheet opts into the print rules by naming two classes** —
`report-sheet` on the container and `report-table` on each table — rather than
carrying its own `@media print` block. That block sets A4 with `@page`, repeats
the column headings on every sheet with `display: table-header-group` (a
twelve-page ledger whose headings appear only on page one is a ledger nobody
can read), keeps `tfoot` from being the thing that falls off the bottom,
unwraps horizontal scrollers so a printed table is not the slice that happened
to be visible, and forces black text — the muted greys come out as pale,
uneven dots on an office laser.

> **`@page` cannot be scoped to an element**, which is why the A5 invoice
> emits its own `<style>{'@page { size: A5 }'}</style>` from
> `components/InvoiceDocument.jsx` while the scaling rule lives in
> `globals.css`. A5 needs both halves: without the scale the bill is 203mm
> wide on a 148mm sheet and the money column is clipped; without the `@page`
> the printer is still told A4 and leaves half the sheet blank.

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
- `PAYLOAD_KEYS` in `billingMath.mjs` is the **frozen list of fields** the save
  request carries — 31 extracted mechanically from the four pages before
  anything moved, plus `partyBillNo` and `mri` added deliberately since (§5,
  §6.41) — 33 in all. The server
  derives what it must (§6.5), but adding a key here changes what four screens
  send — check the route reads it, and remember Mongoose strict mode silently
  drops an undeclared field (§9.18).

  `billing.test.mjs` asserts the count, and in **both directions**: a payload
  key the screen does not supply, and a field the screen supplies that the
  payload has no room for. Adding `partyBillNo` failed it twice before the
  screen was wired, which is the test doing its job.

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

**It also carries the twenty keyboard actions** (`lib/billingKeys.mjs`) and the
four master keys over whatever field has focus (§6.21), and it picks up a bill
read off a photograph: `?import=1` makes it read a draft out of
`sessionStorage`, apply it, and print what still needs settling on an amber
strip. The draft is read **once and removed** — a refresh must not re-apply it
over what the person has since typed, and an abandoned import must not land on
a different bill tomorrow. Nothing in that path sets a place of supply or a tax
type; both follow whichever party is picked (§6.26).

On the purchase screen (not the return) it also carries the **M.R.I.** strip
(`MriPanel`, §6.41): ticking it adds Received and Rejected columns around the
quantity, which becomes Accepted, and `?mri=1` opens a new bill already ticked.
The Received box shares the row's `setActiveRow` focus, so the row shortcuts
act on it like the other three boxes (`billing.test.mjs` counts four).

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

### 8.6 Shared report furniture

Three things every new report should reuse rather than rebuild:

- **`components/reports/DateFilter.jsx`** — the thirteen presets, the two date
  boxes, the resolved window printed in words. It holds **no period logic**:
  it reports a preset upward and `resolvePeriod` does the work, so a component
  cannot become a second resolver (§6.22). A report that wants fewer presets
  passes a `presets` list.
- **`components/CompanyBrand.jsx`** — `<CompanyLogo>` and `<CompanyBrand>` for
  the letterhead, `<CompanyBank>` and `<DocumentFooter>` for the foot. Deliberately
  not ONE header component: the invoice puts the firm on the left with the bill
  number on the right and a report centres it over the sheet, and forcing both
  through one layout would be a prop that switches between two designs. What
  must agree — which details print, and whether the logo is cropped — is what
  these share (§6.25).
- **`lib/reportHttp.js`'s `reportResponse()`** — one sheet spec drives the
  screen, the CSV and the workbook, so a column cannot be called two things
  (§6.23).

A report also needs an entry in **`lib/reportCatalogue.mjs`**, which is what
`/reports` loops over. `report-catalogue.test.mjs` then checks the path has a
`page.js` on disk, that it is in the permission table at all (an unlisted PAGE
path demands only a session — for a report that means a biller reaching the
trial balance), and that a page and its API route are behind the same rule.

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
    **Fixed, in full.** The profile is the firm's own `companies` row, the
    logo is per-firm (§6.25), and `lib/company.mjs` is the shape and the rules
    around them rather than any constant. The last piece was the logo — see
    21b for why it survived the first pass.
11. ~~~22 `console.log` calls and ~55 `alert()`s in production paths.~~
    **Fixed** (§6.32): inline notices, one response reader, 500s sanitised.
12. ~~`save-invoice` spreads `{...body}` into `Invoice.create`.~~ **Fixed**
    (§6.28, allowlist). The tenant stamp now also refuses a document naming
    another firm inside a request (§6.34).
13. Master-data routes (`customer-add`, `item-add`, `hsn-*`, `delete-item`,
    `delete-hsn`) are **not** transactional. The money paths all are.
14. `main.js` (Electron) still points at `vyapaar-ten.vercel.app` -- the
    production domain is unconfirmed. (Hardened in §6.34: no Node.js in the
    window, navigation kept on the app.) The FastAPI
    CORS list no longer matters: `backend/` is unused and
    `NEXT_PUBLIC_AI_IMPORT_URL` is dead — reading a bill is now an in-app
    route (§6.26).
15. `capacitor.config.ts` still says `com.example.app`. (`README.md` has been
    written; it points here for anything beyond running the app.)
16. The Electron build (`main.js`) loads the deployed URL in a window, so it
    now shows the sign-in page like any browser. Nothing stores a session for
    it beyond the embedded browser's own cookie jar.

**Known defects in the billing arithmetic — reported, not repaired**

These are preserved deliberately. Each one changes what prints on a GST
return, so fixing it is a decision with the client, not a tidy-up.
`lib/billingMath.mjs` documents all four at the line.

17. ~~**The HSN summary takes the first line's GST rate.**~~ **Fixed** (§6.31). `buildHsnTotals`
    assigns `grouped[hsn]` only on first sight, so billing a 5% item and an
    18% item under one HSN code prints both at 5% — while the *amounts* are
    correct. `lib/hsnTotals.mjs` derives it properly for the print, and
    `lib/gstReturns.mjs` reads the **lines** rather than the stored array for
    exactly this reason (its table 12 is per HSN *and* per rate).
18. **`recalcItem` never rounds.** A stored `taxableAmount`, `gstAmount` or
    `total` can carry floating-point tail digits, which is why §6.17 says read
    what was stored rather than recompute from the rate.
19. ~~**`resolveItemPricing` reads `salePrice` unconditionally**~~ **Fixed**
    (§6.31: a purchase starts from `purchasePrice`). so a purchase
    invoice prices from the *sale* price unless the line is edited. The price
    list is party-wise, not side-wise, and nothing distinguishes the two.
20. ~~**Invoice-draft `localStorage` keys are global across all four billing
    screens**~~ **Fixed** (§6.31: removed; the read-in bill hand-off is tagged), so a half-finished sale and a half-finished purchase can
    overwrite each other. Keying them by `typeKey` is the fix.
21. **`againstInvoiceNo` on the Invoice schema is declared and never set.**
    Harmless, but it looks like a working link. Bill-wise adjustment lives on
    the **voucher** (§5 `Voucher.allocations`), not here. Not to be confused
    with `partyBillNo`, which IS set and IS the other party's bill number (§5).

**Limitations accepted deliberately in the reporting and import work**

21g. **A statement's Reference column is parsed out of the narration.**
    `models/ledgerModel.js` has no document-number field, so `referenceOf()`
    reads "...No: 12" out of the three narration shapes the posting path
    writes and returns "" for anything else. A user who types "Chq No: 4411"
    into a voucher narration will see 4411 there, which is arguably right and
    is not something the schema promised. The honest fix is a `docNo` on the
    ledger row written by the posting path — a migration and a change to
    posting, which reporting work is not allowed to make (§6.24).

21h. **The firm's logo is a data URL in MongoDB.** Bounded at 150KB on the
    decoded bytes and behind a two-function adapter, for the reasons in §6.25.
    It is the wrong long-term home for an image and is marked as such.

21i. ~~**`.xlsx` is wired on the statements and the account books only.**~~
    **Fixed** (§6.29). The
    sales book, the GST returns and the financial statements still download CSV
    only. The infrastructure is shared (§6.23), so each is a small wiring job.

21j. ~~**No report page except `/statement` and `/account-book` reads its filters
    from the URL.**~~ **Fixed** (§6.29). The Reports hub can therefore preselect a side or a book on
    those two and not on the rest; `report-catalogue.test.mjs` asserts that a
    tile is only given a query the target page actually reads, so the gap is
    enforced rather than forgotten.

**Shipped-and-fixed defects worth remembering**

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

21b. **One shared logo on every firm's invoice.** `COMPANY_LOGO = "/logo.jpg"`
    — one file in `/public`, rendered unconditionally, so the second firm to
    sign up printed the first firm's mark on their tax invoices. The name, the
    GSTIN and the address had been moved onto the `companies` row long before;
    the logo had not. Fixed per-firm (§6.25). **The lesson:** when branding is
    de-hardcoded, sweep for the ASSETS too — a path is as much a constant as a
    string, and it does not look like one.

21c. **A date default read from the browser's clock.**
    `app/account-book/page.js` had `new Date().getMonth()` for the financial
    year and `toISOString()` for today, so a laptop set to New York opened the
    book on the wrong year for eleven hours every 1 April, and between midnight
    and 5:30am IST "today" was yesterday. Both gone (§6.22). **The lesson:** a
    DEFAULT is as load-bearing as a filter, and §6.16 applies to it.

21d. **A mutation harness left a mutant on disk.** `mutate-fin.mjs` was
    interrupted by a command timeout mid-run, and because it restored
    `lib/financials.mjs` only after its loop, the file stayed mutated — with
    `creditAccounts` always empty, so the Trading Account listed no Sales. The
    test suite caught it three suites later. **Every harness now restores after
    EACH mutant**, not at the end. Nearly shipped; worth remembering because a
    broken dev tool quietly corrupts the thing it is testing.

21e. **A preference with no effect.** `showBank` was added, stored, validated
    and shown in the settings form — and the invoice had never printed bank
    details, so the switch did nothing. Found by asking what each new
    preference actually changed. Now `<CompanyBank>` is mounted and the switch
    defaults OFF so the bill is unchanged until a firm asks for it. **The
    lesson:** a setting is not done when it saves; it is done when something
    reads it.

21f. **A dead parameter.** `particularsOf(row, side)` took a `side` it never
    read — found by a mutant that replaced the argument with a constant and
    changed nothing. A parameter that does not change the answer is a lie about
    what a function depends on. Removed.

**Build warnings, offered and not actioned**

22. `next.config.mjs` still carries an `eslint` key that Next 16 rejects, and
    `middleware.js` should be renamed `proxy.js` for Next 16. Both are
    warnings in the Vercel build today, not failures.

**Migrations that have not been run against the live database**

23. `npm run sync:indexes` — `orders`, `boms`, `productions` (now
    `{companyId, kind, docNo}`), `challans`, the invoice line-challan index,
    the M.R.I. indexes (`mriNo`, `againstMriNo` on invoices and challans) and
    the voucher-allocation indexes all want building; stale global uniques
    want dropping (§2).
24. `node scripts/backfill-stock-kind.mjs` — stamps `kind: "FR"` on production
    rows written before the field existed (§5).
25. `npm run backfill:gl-legs` — adds GL legs to invoices raised before
    `lib/invoiceGl.mjs` existed.

   All three are dry-run by default. Run the dry run, read it, then `--apply`.

**Not yet in the other repo**

26. **`C:\Vs Code\SAAS Project\vyapaar` has none of this.** Orders, BOM,
    production, books, financials, the planner, bill adjustment, staff, the
    billing consolidation, stock vouchers, the sales/purchase reports, the GST
    returns, the dashboard, the master keys, the reporting and export layer,
    the statements, company settings and branding, and the invoice import all
    exist **only** in `vyapaar-einvoice`. The two repos have diverged a long
    way; treat `vyapaar-einvoice` as the live one.

**Left behind by a parallel session (13 Oct)**

28. `lib/challan.mjs` and `scripts/challan.test.mjs` are an abandoned second
    challan design (challans that never move stock). Nothing imports them and
    the test is not in `npm test`. **Delete both.** That session also worked
    from a stale copy and reverted several fixes in the files it touched; they
    were restored on 14 Oct (§6.39, §6.40), but if anything from before then
    looks missing, compare against git history before assuming it never
    existed.
29. `scripts/inventory-reports.test.mjs` was written for the first stock
    report (`lib/inventoryReports.mjs`). That report was replaced by Sigfa's
    five (§6.40); the two route/page checks now assert the new route's
    validation and the page's stale-reply guard. `lib/inventoryReports.mjs`
    itself is still tested but no longer behind `/stock-report`.
30. **M.R.I. has not been saved against a real database.** The rules and the
    wiring are tested; the counter, the Re-MRI lock and the unique indexes
    need one end-to-end run (create an MRI with a rejection, a Re-MRI against
    it, try a second Re-MRI and a delete) after `npm run sync:indexes` on a
    development database.

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

Runs **48 suites** in `scripts/` — about **1,913 assertions**, in roughly two
minutes. **Run it after any change to `lib/`, to a posting route, or after
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
| `inventory-reports.test.mjs` | Stock replayed through receipts, issues, both returns, production, edits, deletes and back-dated entries; summary, movements and valuation agree with the dashboard's figure and the balance sheet's closing stock |
| `inventory.test.mjs` | That a window reaching today foots to `buildStockIndex`, that a back-dated entry lands in the opening, that the Short List keeps no rule of its own, that FIFO and LIFO valuation are refused with the reason, and that valued at cost the sheet IS the balance sheet's closing stock (§6.40) |
| `mri.test.mjs` | Purchase M.R.I.: received/accepted/rejected and SIGFA's refusal, the MRI block and the 33-key contract, zero-accepted lines moving no stock, Re-MRI rules, the pending list, the rejected and party-wise registers, the shared session-carrying counter, the delete guards, permissions and the home-page row (§6.41) |
| `stock-alerts.test.mjs` | Low-stock alerts over time: one per condition, worse re-notifies, recovery resolves, per-firm isolation, transaction wiring |
| `report-sheets.test.mjs` | Sales book, GST return and financial statement downloads, built from the real report modules and read back from the workbook bytes |
| `report-query.test.mjs` | Report filters in the URL: validation, defaults, clearing, the 13 presets, round trips, and that the URL is replaced, never pushed |
| `invoice-input.test.mjs` | The billing allowlist (§6.28): protected and operator-shaped fields refused, figures recomputed bit-for-bit like the screen, legitimate zeros kept, edits, double submits, cross-tenant references and rollback replayed against a scoped in-memory store, and a sweep that every DB call in both routes' transactions carries the session |
| `invoice-posting.test.mjs` | The two-leg posting rule |
| `voucher-ledger.test.mjs` | Voucher rows and deltas |
| `price-list.test.mjs` | Rate/discount resolution, legacy chain collapse |
| `backfill-hsn-totals.test.mjs` | HSN summary derivation |
| `index-audit.test.mjs` | Schema indexes against the ones the database has; catches a stale **global** unique that should be `{companyId, …}` |
| `orders.test.mjs`, `order-reports.test.mjs` | Order claims and cancellation; the pending-order reports and SIGFA's exact headings |
| `challans.test.mjs` | Challans (§6.39): SIGFA's two kinds and stock keys, status and totals, claims and over-billing, the picker, input refusals, the routes' wiring, permissions, Alt+L, clearing, the model |
| `bom.test.mjs` | Nested explosion, wastage, by-product, and the three stock vouchers' direction and reversal |
| `account-books.test.mjs`, `financials.test.mjs` | The books, and that all four statements agree with each other |
| `production-plan.test.mjs` | What to make, net of stock |
| `bill-adjust.test.mjs` | Against Bill: FIFO, every refusal, and the money tolerance |
| `staff.test.mjs` | Who may be added, and that a firm cannot reach zero active owners |
| `billing.test.mjs` | The 2×2 type table, the verbatim arithmetic, SIGFA's shortcuts |
| `sales-reports.test.mjs` | The Book at three grains, the zoom, the scope selector, and that a return subtracts (§6.18) |
| `gst-returns.test.mjs` | One table per document, a tax that adds back to the paisa, and that an empty table says **why** |
| `dashboard.test.mjs` | Gross/returns/net, the sign of a balance, period vs point-in-time, and that nothing is invented where the data does not exist |
| `master-actions.test.mjs` | Alt+A/M/D over whichever field has focus, and that an ALTER sends the whole record — it extracts each alter route's body identifiers and fails if the payload mapping omits one (§6.21) |
| `report-periods.test.mjs` | All thirteen presets, the financial year and its quarters, a Monday week, inclusive ends, the widened Mongo window, and that the IST day is used rather than the server's (§6.22) |
| `report-export.test.mjs` | CSV injection and RFC 4180 quoting; the `.xlsx` is **unzipped** and each entry's CRC checked against Node's own `zlib.crc32`, numbers asserted to be numbers, dates asserted to be the right serial from the IST day (§6.23) |
| `report-catalogue.test.mjs` | Every hub tile opens a page that exists on disk, is in the permission table, and is behind the same rule as its API route |
| `statements.test.mjs` | Opening from before the window, the running balance in `(date, _id)` order, the reconciliation, a back-dated entry, an empty period, and that a supplier's Cr balance reads as a payable and not an advance (§6.24) |
| `company-branding.test.mjs` | The logo's type from its bytes, the size cap, that a `data:text/html` is refused, that there is no fallback logo at all, and that every preference default reproduces today's invoice (§6.25) |
| `invoice-email.test.mjs` | That the route loads the bill rather than mailing whatever it was handed, that every address is validated server-side, that the message is escaped, that a paid bill invites no payment, and that the send is logged only after the provider accepts (§6.27) |
| `invoice-import.test.mjs` | That a near miss is never applied, that every figure is recomputed, that the tax type is not defaulted, that a charge is not an item, and that the module writes nothing (§6.26) |
| `einvoice-payload.test.mjs`, `einvoice-credentials.test.mjs`, `einvoice-lock.test.mjs`, `secret-box.test.mjs` | The IRP payload, the credential vault, and that a reported invoice is read-only |
| `company-profile.test.mjs`, `buyer-snapshot.test.mjs` | The letterhead, and the buyer block frozen onto a bill |
| `report-periods` + `statements` + `report-export` | Together: the whole reporting layer. A new report should extend these rather than add a suite |
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
node mutate-gst.mjs        # 122/122
node mutate-dash.mjs       # 111/111   (15 moved to mutate-periods)
node mutate-bom.mjs        # 136/136
node mutate-bill.mjs       #  58/58
node mutate-staff.mjs      #  53/53
node mutate-billing.mjs    #  75/75
node mutate-fin.mjs        #  90/90
node mutate-books.mjs      #  67/67
node mutate-plan.mjs       #  50/50
node mutate-sigfa.mjs      #  36/36
node mutate-master.mjs     #  51/51
node mutate-periods.mjs    #  62/62
node mutate-export.mjs     #  66/66   (two targets: csv.mjs and xlsx.mjs)
node mutate-catalogue.mjs  #  19/19
node mutate-statements.mjs #  80/80
node mutate-branding.mjs   #  62/62   (three targets)
node mutate-import.mjs     #  86/86
node mutate-email.mjs      #  61/61
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
- **Restore the target after EACH mutant, not at the end of the loop.** A
  harness interrupted mid-run otherwise leaves a mutant on disk — which
  happened, and left `lib/financials.mjs` with a Trading Account that listed no
  Sales until a test three suites later caught it (§9.21d).
- When a shared contract grows, the harnesses that anchor on its **last** entry
  go stale and report `SKIP`. Adding `partyBillNo` to `PAYLOAD_KEYS` did that
  to two of `mutate-billing`'s. Read the skips.

What the sweeps have actually caught in this codebase, all of them green-suite
bugs: a fixture of round thousands that could not test money rounding; a
fixture already in sort order that could not tell a sort from no sort; a
comparison that read `resolveGroup()`'s **record** against a string, so every
party landed on neither side and the dashboard showed no receivables at all;
`istDayNumber` being subtracted as though it were a day count (§6.16); a
workbook verified with the writer's **own** CRC function, which passed a
deliberately broken CRC table; a prompt instruction asserted against the whole
prompt rather than its rules section, so the assertion passed with the rule
deleted because a field note mentioned the same words; a suggestion-ranking
fixture listed best-first, which a stable no-op sort leaves in order; and a
`num()` that stripped a European decimal comma and turned 1250.50 into 125050.

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
5. **One page, following §8.5 and §8.6** — `doc-sheet report-sheet`,
   `data-table report-table`, `no-print`, `<DateFilter>` for the period,
   `<CompanyBrand>` for the letterhead, captions from the module, no
   arithmetic.
6. **Periods come from `lib/reportPeriods.mjs`** (§6.22). Do not resolve a
   month, a quarter or a financial year anywhere else, and validate the preset
   on the server with `isPreset`.
7. **Exports are `format=csv|xlsx` on the SAME route** (§6.23), built from one
   sheet spec through `reportResponse()`. Do not add an export endpoint.
8. Add the path pair to `PATH_RULES` in `lib/roles.mjs` (a report is normally
   `report:read`: owner and accountant, not biller; one account's own history
   is `ledger:read`). **A page and its API route must carry the same rule** —
   `report-catalogue.test.mjs` asserts it.
9. An entry in `lib/reportCatalogue.mjs` so it appears on `/reports`, and a
   tile on `app/page.js` if it is one a shop opens daily.
10. **A suite, then a mutation harness, driven to a full kill (§10.1).**
   Register the suite in `package.json`'s `test` script.

### Add a document preference

1. One entry in `PREF_FIELDS` in `lib/invoicePrefs.mjs`, with the default that
   **reproduces today's document** — measured against the component, not
   guessed. A default that changes an existing bill is the one mistake here.
2. The matching field on the `invoicePrefs` sub-document in
   `models/companyModel.js` (strict mode drops what is not declared), with the
   same default.
3. Read it where it is used, through `prefsFrom()` and `showsDetail()` — never
   `company.invoicePrefs.showX` directly, because a detail has to be gated on
   the firm having filled the field in as well as on the switch (§6.25).
4. **Mount something that reads it.** A preference nothing reads is §9.21e.
5. `PREF_NAMES` is pinned by `company-branding.test.mjs`, deliberately: adding
   one is an edit there too, where the comment about presentation-only lives.

### Add a field the invoice importer should read

1. One entry in `EXTRACTION_FIELDS` in `lib/invoiceImport.mjs`, with the note
   the prompt will carry. The prompt is built FROM that list, and
   `invoice-import.test.mjs` asserts the two agree — so a field the normaliser
   knows and the prompt never mentions cannot happen.
2. Coerce it in `normalizeExtraction` (text or `num`, never `|| 0`).
3. Carry it on the draft, and set it in the `?import=1` effect in
   `BillingScreen`.
4. **Never ask the model for one of our own fields** — an invoice number, a
   total, a place of supply, a tax type. §6.26 says why each of those is ours.

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
> calendar days, and there are two different day numbers), §6.17
> (`totalAmount` is tax-inclusive), §6.22 (one date resolver for every report)
> and §6.26 (an extraction is a guess: an exact match applies, a likely one is
> only ever suggested). For challans and purchase M.R.I., read §6.39 and §6.41:
> on an MRI line `quantity` is the ACCEPTED quantity and `receivedQty` sits
> beside it.
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
> and the entry in `PATH_RULES` if you add a route. Billing behaviour is in
> **one** component now (§8.4) — if you find yourself editing four pages, stop.
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
