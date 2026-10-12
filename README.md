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
| §9 | What is broken, what is deliberately left broken, and why. |

E-invoicing has its own two documents: [`EINVOICE_PLAN.md`](./EINVOICE_PLAN.md)
and [`EINVOICE_IMPLEMENTATION.md`](./EINVOICE_IMPLEMENTATION.md).

---

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 40 suites — run this before you call anything done
npm run build
```

`.env.local` at the repo root needs two things at minimum:

```
MONGO_URI=mongodb+srv://...     # must be a replica set (Atlas is one)
AUTH_SECRET=<48+ random bytes>  # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Without `AUTH_SECRET` every page returns 500 — the gate fails closed rather
than letting requests past unverified. The rest of the environment, including
the optional e-invoicing and AI-import settings, is listed in
`PROJECT_CONTEXT.md` §2.

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
Sales/Purchase Book, party-wise and item-wise · GSTR-1 (e-return JSON and
readable tables), GSTR-3, GSTR-3B · a business dashboard · e-invoicing payload
and credential vault · staff management · AI invoice-image import.

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

Also shipped as an Electron wrapper (`main.js`) that loads the deployed URL.
The Python AI-import service in `backend/` is separate and optional.
