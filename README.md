# Vyapaar

A **GST billing and accounting app for small Indian trading businesses**,
replacing desktop software of the SIGFA/Tally generation. Multi-tenant: one
deployment serves many firms, each signing in to see only its own books.

Next.js 16 (App Router) · JavaScript · MongoDB + Mongoose 8 · Tailwind 3

---

## Read this first

**[`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) is the real documentation.** It
has the architecture, the data model, the accounting rules that must not be
broken, the UI vocabulary and the honest list of known landmines. It is written
to be pasted into an AI assistant that knows nothing about the codebase.

If you are about to change anything, read at least:

| Section | Why |
|---|---|
| §6.14 | Every query is scoped to one firm, **automatically**. The mechanism is not visible in a route. |
| §6.15 | Auth and roles — an edge gate plus a database-backed guard. |
| §6.16 | Dates are IST calendar days, and there are **two** different day numbers. Subtracting the wrong one gives a plausible wrong answer. |
| §6.17 | `Invoice.totalAmount` is **tax-inclusive**, whatever its name suggests. |
| §6.22 | One date resolver for every report. The financial year starts in April and the quarters follow it. |
| §6.26 | The invoice importer is the only path into the books whose input is a guess. An exact match applies; a likely one is only ever suggested. |
| §9 | What is broken, what is deliberately left broken, and why. |

E-invoicing has its own two documents: [`EINVOICE_PLAN.md`](./EINVOICE_PLAN.md)
and [`EINVOICE_IMPLEMENTATION.md`](./EINVOICE_IMPLEMENTATION.md).

---

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 48 suites, ~1,900 assertions — run before calling anything done
npm run build
```

`.env.local` at the repo root needs two things at minimum:

```
MONGO_URI=mongodb+srv://...     # must be a replica set (Atlas is one)
AUTH_SECRET=<48+ random bytes>  # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Without `AUTH_SECRET` every page returns 500 — the gate fails closed rather
than letting requests past unverified.

Two more are optional and each unlocks one feature:

```
SECRET_BOX_KEY=<32 random bytes>   # to store e-invoicing credentials
INVOICE_AI_KEY=...                 # to read a purchase bill off a photograph
```

Neither is `NEXT_PUBLIC_`, deliberately — a key that reaches the browser is a
published key. Without `INVOICE_AI_KEY` the extract route answers 503 and says
so. The full list is in `PROJECT_CONTEXT.md` §2.

**There is no seeded account, by design.** Go to `/signup`: it creates the firm
and its first owner together and signs you in.

### After a deploy that added a model or an index

```bash
npm run sync:indexes          # dry run: reports drift
npm run sync:indexes:apply
```

Mongoose creates indexes but never drops one you removed — including a stale
**global** unique index from before multi-tenancy, which is what produces
"duplicate invoice number" errors across two unrelated firms.

### Upgrading a database that predates multi-tenancy

Old rows have no `companyId` and every query now filters on it, so until you
run this the old books are **invisible, not lost**:

```bash
npm run adopt:tenant          # dry run
npm run adopt:tenant:apply    # backs up first, then stamps every row
```

---

## What it does

Masters (parties, items, HSN, price lists, groups, states, bill of material) ·
Sale/Purchase invoices and returns · Sale/Purchase orders with cancellation and
order→invoice linkage · Production, Goods Issued, Goods Received and production
planning · Receipt and payment vouchers with bill-wise adjustment · Cash Book,
Bank Book, A/C Ledger · Trial Balance, Trading A/c, P&L, Balance Sheet ·
customer and supplier statements · a Reports hub with thirteen shared date
presets, CSV and `.xlsx` downloads and A4/A5 print · Sales/Purchase Book,
party-wise and item-wise · GSTR-1 (e-return JSON and readable tables), GSTR-3,
GSTR-3B · a business dashboard · per-firm branding: logo, legal name and
document preferences · e-invoicing payload and credential vault · staff
management · emailing a bill to the customer, with every send recorded on it ·
reading a purchase bill off a photograph, reviewed before it is saved.

SIGFA's keyboard is reproduced too: twenty actions on a bill, and `Alt+A` /
`Alt+M` / `Alt+D` to create, alter or delete the master behind whatever field
has focus — on an invoice or on a master screen (§6.21).

---

## Working on it

Two house rules worth knowing before you open a file:

**Arithmetic lives in `lib/*.mjs`, pure.** Those modules import nothing and run
under bare `node`, which is how they are tested. Routes fetch and shape; pages
format and lay out. Neither computes. A route or a page that totals money is a
total that can disagree with the module the tests exercise — the suites assert
there is no `reduce(` in either.

**A green suite proves nothing on its own.** Every domain module has a mutation
harness beside it that breaks one rule at a time and expects the suite to fail
(§10.1). They are work-tree only and not committed. Most of the assertions in
this codebase were written *after* a sweep showed the obvious one did not bite.

**Three things that have each cost real money here**, so they are worth the
thirty seconds: a default read from the browser's clock is as load-bearing as a
filter (§6.22); a setting is not finished when it saves, only when something
reads it (§9.21e); and when you de-hardcode branding, sweep for the *assets*
too — a path is as much a constant as a string and does not look like one
(§9.21b).

Also shipped as an Electron wrapper (`main.js`) that loads the deployed URL.
`backend/` held a Python invoice-reading service and is **no longer used** —
reading a bill is now an in-app route (`PROJECT_CONTEXT.md` §6.26).
