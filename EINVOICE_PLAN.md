# Vyapaar — E-Invoicing (IRN) Implementation Plan

> ## Where this stands
>
> **Steps 1 to 6 of the build order in section 9 are built and tested** in this
> project (`vyapaar-einvoice`). The original `vyapaar` folder is untouched.
>
> | # | Step | Where it lives |
> |---|---|---|
> | 1 | Invoices freeze once they carry an IRN | `lib/einvoiceLock.mjs`, the IRN fields on `invoiceModel`, a 409 from `sale-alter` and `delete-invoice`, `components/EinvoiceLockNotice.jsx` on the four billing pages |
> | 2 | Company profile and a real letterhead | `lib/company.mjs` (no hardcoded firm left), `/company`, `GET /api/company`, `POST /api/company-update`, `context/CompanyContext.js` |
> | 3 | Buyer snapshotted onto the invoice | `lib/buyerSnapshot.mjs`, the `customer` block on `invoiceModel`, both invoice routes |
> | 4 | UQC and goods/service per item | `lib/uqc.mjs` (all 44 codes), `uqc` + `isService` on `itemModel` and on each invoice line, the item form |
> | 5 | The INV-01 payload | `lib/einvoicePayload.mjs`, `lib/istDate.mjs` |
> | 6 | Encrypted credential storage | `lib/secretBox.mjs`, `lib/einvoiceCredentials.mjs`, the credential fields on `companyModel`, the E-invoicing panel on `/company` |
>
> **Before step 6 can store anything**, add a key to `.env.local`:
>
> ```
> EINVOICE_KEY=<64 hex characters>
> ```
>
> Generate one with
> `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
> It is deliberately NOT `AUTH_SECRET`: one leaked secret must not both forge
> sessions and decrypt every firm's portal password.
>
> **Steps 7 to 10 need WhiteBooks sandbox credentials** and are not built.
> Section 6 has the confirmed request shapes.
>
> Seven new test suites, all mutation-tested: `einvoice-lock`,
> `company-profile`, `buyer-snapshot`, `uqc`, `einvoice-payload`, `secret-box`,
> `einvoice-credentials`. `npm test` runs 25 suites.


**Read `PROJECT_CONTEXT.md` first.** This file assumes it. It covers one
feature: generating an **IRN** (Invoice Reference Number) for each B2B sale by
reporting it to the government's **IRP** (Invoice Registration Portal), through
**WhiteBooks** as the GSP.

Written so it can be handed to any AI assistant — ChatGPT, Gemini, Claude —
with no other context than `PROJECT_CONTEXT.md`. §13 is the prompt to paste.

**Written: 8 October 2026.** The rules below were checked on that date against
the sources in §12. **Tax rules change. Re-check §1 before you start**, and
confirm applicability with the customer's CA — this is an engineering plan, not
tax advice.

**GSP: WhiteBooks** (`developer.whitebooks.in`). Their API reference was read
on 8 Oct 2026 and §6 records it exactly. **Good news: it is a pass-through
gateway — plain JSON, plain headers, no RSA, no AES, no AppKey, no SEK.** The
whole encryption layer that the raw NIC API demands does not apply. Their
sandbox is free and needs no card.

**Status: NOTHING BUILT.** No code for this feature exists in the repo yet.

---

## 1. The compliance facts

| Question | Answer (Oct 2026) |
|---|---|
| Who must do it? | Businesses with **aggregate annual turnover ≥ ₹5 crore** (since 1 Aug 2023) |
| Which documents? | **B2B**, B2G, **exports**, and **credit/debit notes** against those |
| Which documents are exempt? | **B2C is NOT e-invoiced.** Neither are your purchase entries — your *supplier* reports those |
| Reporting deadline | **30 days** from invoice date, for turnover **≥ ₹10 crore** (from April 2025). No hard window below that yet |
| Can an e-invoice be edited? | **No. Never.** Cancel within **24 hours** (with a reason), or issue a credit note |
| Penalty | Invoice treated as not issued: ₹10,000 or the tax amount, whichever is higher. The buyer's input tax credit is at risk |

A further threshold cut has been rumoured for 2026 but was not in any
notification as of this writing.

### What this means for the app

1. An invoice that has an IRN is **frozen**. §3 is about enforcing that.
2. Only **Sale** and **Sale Return** are ever reported. Purchase and Purchase
   Return must be refused by the generate route.
3. `Sale` → document type **`INV`**. `Sale Return` → **`CRN`** (credit note).
4. A sale to a party with **no GSTIN is B2C** and must not be sent at all.

---

## 2. What the IRP gives back

On success you get, per invoice:

| Field | What it is |
|---|---|
| `Irn` | 64-character hash. The unique id of this invoice in the government's records |
| `AckNo` | Acknowledgement number |
| `AckDt` | Acknowledgement date-time |
| `SignedInvoice` | The whole invoice, JWT-signed by the IRP |
| `SignedQRCode` | A signed JWT that **must be printed on the invoice as a QR code** |

Store all five. `SignedQRCode` is what goes on the printed bill; keep
`SignedInvoice` too, because it is the government-signed record of exactly what
was filed and is what you show in a dispute.

---

## 3. STEP ZERO — freeze invoices that have an IRN

**BUILT.** `lib/einvoiceLock.mjs` + `scripts/einvoice-lock.test.mjs`.

**Do this before any API work. It is small, self-contained, and useful even if
the rest is never built.**

The problem: `app/api/sale-alter/route.js` lets a user edit a saved invoice
freely — **including `invoiceNo` itself**, which is why it looks rows up by
`originalInvoiceNo`. `app/api/delete-invoice/route.js` deletes outright. Both
are incompatible with e-invoicing: once an IRN exists, the government has a
signed copy, and your books silently diverging from it is the worst outcome
this feature can produce.

**What to build**

1. `lib/einvoiceLock.mjs` — pure, so it is testable under bare node:

   ```js
   /** Why this invoice may not be changed, or null when it may. */
   export const editBlockedReason = (invoice) => {
     if (!invoice?.irn) return null;
     if (invoice.einvoiceStatus === "cancelled") return null;
     return `Invoice ${invoice.invoiceNo} has been reported to the IRP ` +
            `(IRN ${invoice.irn}). It cannot be edited. Cancel the e-invoice ` +
            `within 24 hours of ${invoice.ackDt}, or raise a credit note.`;
   };

   /** Is the 24-hour cancellation window still open? */
   export const cancelWindowOpen = (invoice, now = Date.now()) => { /* ackDt + 24h */ };
   ```

2. `sale-alter` and `delete-invoice` call `editBlockedReason()` first and
   return **409** with that message when it is non-null.
3. The billing pages disable the Save button and show the reason when editing
   an invoice that carries an IRN.
4. `scripts/einvoice-lock.test.mjs` — assert an invoice with an IRN is blocked,
   one without is not, a cancelled one is editable again, and the 24-hour
   window closes at the right minute (including across a month boundary).

**Acceptance:** `npm test` passes; editing an invoice with an IRN set by hand
in the database returns 409.

---

## 4. STEP ONE — the data you do not have yet

**BUILT** (4.1 to 4.5). One correction to 4.4 below: the official UQC list has
**no code for litres**. A litre is 1000 MLT, or use KLR. `lib/uqc.mjs` carries
all 44 codes, checked against three published copies of the list.

The IRP rejects a payload missing any mandatory field, so collect these before
writing the mapper. Each is a small, independently shippable change.

### 4.1 Seller details, per firm

`models/companyModel.js` already declares `gstin`, `address`, `city`, `state`,
`stateCode`, `pincode` — **they are blank**. The IRP requires all of them.

Add a **Company Profile** page (owner-only, `/company`, permission
`setup:write`) where the owner fills them in. Validate:

- `gstin` — 15 characters, and its **first two digits must equal `stateCode`**
- `pincode` — 6 digits
- `stateCode` — 2 digits, use `normalizeStateCode()` from `lib/gst.mjs`

This page is needed anyway: `lib/company.mjs` is still a hard-coded single
firm, so every tenant's invoice currently prints the wrong letterhead
(`PROJECT_CONTEXT.md` §9.1). **Build this page and switch `InvoiceDocument` to
read the signed-in firm's record as part of this step.**

### 4.2 E-invoice credentials, per firm

Also on `companies`:

```js
einvoiceEnabled:     { type: Boolean, default: false },
einvoiceUsername:    { type: String, trim: true, default: "" },
einvoicePasswordEnc: { type: String, default: "", select: false },
einvoiceEnv:         { type: String, enum: ["sandbox", "production"], default: "sandbox" },
```

**The password must be encrypted at rest.** Use AES-256-GCM from
`node:crypto`, keyed from a **new** `EINVOICE_KEY` env var — *not* `AUTH_SECRET`.
A leaked session secret must not also grant the ability to file invoices as
your customers. Put the encrypt/decrypt pair in `lib/secretBox.mjs` and test it
round-trips, rejects a tampered ciphertext, and never returns the plaintext on
failure.

`select: false` so it is never returned by an ordinary query.

### 4.3 Buyer details must be snapshotted onto the invoice

**This is the subtle one.**

`models/invoiceModel.js` embeds only:

```js
customer: { name, phone, email, custId }
```

No GSTIN, no address, no PIN, no state code — but the IRP needs all of them for
a B2B invoice.

You **could** look the buyer up in the master at generate time. **Do not.** The
IRN is tied to what was filed; if the party later changes address, your stored
invoice must still show what was reported. Legally the snapshot is the record.

So **extend the embedded customer block** at save time, in
`app/api/save-invoice/route.js` and `sale-alter`:

```js
customer: {
  name, phone, email, custId,
  gstin, address, city, pincode, stateCode,   // ← new, captured at save
}
```

> ⚠ **Mongoose strict mode silently drops undeclared fields.** This has bitten
> this project at least five times. Declare them in the schema *and* add them
> in both the create and the alter route, or editing an invoice will wipe them.

Old invoices will not have them. That is fine — they predate e-invoicing and
will never be reported.

### 4.4 UQC (unit) codes on items

`models/itemModel.js` has `unit` as free text. The IRP wants a **standard Unit
Quantity Code**. Common ones:

```
NOS  numbers      PCS  pieces     KGS  kilograms   MTR  metres
LTR  litres       BOX  box        BAG  bag         SET  set
PAC  packs        ROL  rolls      SQM  square m    TON  tonnes
DOZ  dozen        BDL  bundles    CTN  cartons     OTH  others
```

**Verify the full list against the current INV-01 schema document** — it is
~40 codes and this is a subset from memory.

Add `uqc` to the item master as a dropdown, defaulting to `OTH`. Do **not**
try to guess it from the existing free-text `unit`; a wrong UQC is a rejected
invoice and a silent mapping is worse than an explicit default.

### 4.5 Goods or service, per item

Add `isService: { type: Boolean, default: false }` to `itemModel`. It becomes
`IsServc: "Y" | "N"` on each line.

---

## 5. STEP TWO — `lib/einvoicePayload.mjs`, the real work

**BUILT.** Section 5.5's tests are in `scripts/einvoice-payload.test.mjs`, and
each one was checked by breaking the source until it failed.

**Pure. No network, no Mongoose.** This is where ~80% of the bugs in any
e-invoice integration live, and every one of them costs a round trip to the IRP
to discover. It is exactly the shape this project's test suite is built for.

```js
/**
 * A saved Invoice document -> the INV-01 payload the IRP expects.
 *
 * @param invoice  the Mongoose document, plain
 * @param company  the firm's own record (seller)
 * @returns { payload, problems }  problems is a list of human-readable
 *          reasons this invoice CANNOT be reported. Never throw: the caller
 *          shows them to the user, who has to fix the data.
 */
export function buildIrnPayload(invoice, company) { ... }
```

### 5.1 The payload shape

```jsonc
{
  "Version": "1.1",
  "TranDtls": {
    "TaxSch": "GST",
    "SupTyp": "B2B",          // or EXPWP / EXPWOP for exports
    "RegRev": "N",
    "IgstOnIntra": "N"
  },
  "DocDtls": {
    "Typ": "INV",             // INV for Sale, CRN for Sale Return
    "No": "123",              // invoiceNo as a STRING. Max 16 chars.
                              // Must not start with 0, / or -
    "Dt": "08/10/2026"        // dd/mm/yyyy, NOT ISO
  },
  "SellerDtls": {
    "Gstin": "...", "LglNm": "...", "Addr1": "...",
    "Loc": "...", "Pin": 110076, "Stcd": "07"
  },
  "BuyerDtls": {
    "Gstin": "...", "LglNm": "...",
    "Pos": "07",              // place of supply = buyer's state code
    "Addr1": "...", "Loc": "...", "Pin": 110076, "Stcd": "07"
  },
  "ItemList": [
    {
      "SlNo": "1",
      "IsServc": "N",
      "HsnCd": "7308",
      "Qty": 15,
      "Unit": "PCS",
      "UnitPrice": 450.00,
      "TotAmt": 6750.00,      // UnitPrice * Qty, before discount
      "Discount": 0.00,
      "AssAmt": 6750.00,      // TotAmt - Discount  (the taxable value)
      "GstRt": 18.0,
      "CgstAmt": 607.50,      // local supply
      "SgstAmt": 607.50,
      "IgstAmt": 0.00,        // central supply: IGST only, CGST/SGST zero
      "TotItemVal": 7965.00   // AssAmt + taxes
    }
  ],
  "ValDtls": {
    "AssVal": 6750.00,
    "CgstVal": 607.50,
    "SgstVal": 607.50,
    "IgstVal": 0.00,
    "OthChrg": 0.00,          // freight + partyTaxes
    "RndOffAmt": 0.00,
    "TotInvVal": 7965.00
  }
}
```

### 5.2 Where each value comes from in Vyapaar

| IRP field | Source |
|---|---|
| `DocDtls.No` | `String(invoice.invoiceNo)` |
| `DocDtls.Dt` | `invoice.date`, reformatted to `dd/mm/yyyy` |
| `DocDtls.Typ` | `invoice.type === "Sale" && invoice.return ? "CRN" : "INV"` |
| `SellerDtls.*` | the `companies` row (§4.1) |
| `BuyerDtls.*` | the embedded `invoice.customer` snapshot (§4.3) |
| `BuyerDtls.Pos` | buyer's `stateCode`; for exports, `96` |
| `ItemList[].HsnCd` | `item.hsn` |
| `ItemList[].GstRt` | `item.gstRate` |
| `ItemList[].AssAmt` | `item.taxableAmount` — already derived and stored |
| CGST/SGST vs IGST | `invoice.taxType` — `"local"` → CGST+SGST, `"central"` → IGST. Split with `splitGst()` from `lib/gst.mjs` so it matches the printed bill exactly |
| `ValDtls.OthChrg` | `invoice.freight` (**a String in the schema — coerce**) plus `invoice.partyTaxes` totals |
| `ValDtls.TotInvVal` | `invoice.finalAmount` |

### 5.3 The validation rules that will reject you

- **Totals must reconcile within ±1 rupee.** `ValDtls.TotInvVal` must equal the
  sum of `ItemList[].TotItemVal` plus `OthChrg` plus `RndOffAmt`. Use `round2`
  from `lib/balance.mjs` throughout and compute `RndOffAmt` as the remainder —
  do not let it drift.
- **`TotItemVal` must equal `AssAmt + CgstAmt + SgstAmt + IgstAmt`**, per line.
- **Never send both** CGST/SGST and IGST non-zero on the same line.
- `Pin` and `Stcd` are **numbers and strings respectively** — the IRP is fussy;
  `Stcd` keeps its leading zero (`"07"`, not `7`). `normalizeStateCode()`
  already does this.
- An invoice number containing a character outside `A-Z 0-9 / -`, or longer
  than 16, is rejected.
- A **future-dated** invoice is rejected.

### 5.4 What `problems` should catch before you ever call the API

Return a problem — do not throw, do not send — when:

- the buyer has no GSTIN (**it is a B2C sale; do not report it**)
- the seller firm has no GSTIN, address, PIN or state code
- any line has no HSN code, or a UQC of `OTH` where you want to be strict
- totals do not reconcile
- the document is a Purchase or Purchase Return
- the invoice already has an IRN
- the invoice date is more than 30 days old **and** the firm's `aato` is ≥ ₹10cr

### 5.5 Tests — `scripts/einvoice-payload.test.mjs`

Mirror the style of `scripts/party-balance.test.mjs`. Cover at minimum:

- a local supply splits CGST+SGST and leaves IGST zero; a central one the reverse
- line totals and the grand total reconcile, including a rounding remainder
- a sale return produces `Typ: "CRN"`
- a buyer with no GSTIN produces a problem, not a payload
- a purchase produces a problem
- the date is `dd/mm/yyyy`, and a single-digit day/month keeps its leading zero
- `Stcd` keeps its leading zero for Delhi (`"07"`)
- freight stored as the string `"500"` still reaches `OthChrg` as `500`
- an invoice with 30+ lines still reconciles (float drift)

**Then break the source and watch each test fail.** A test that cannot fail is
worth nothing.

---

## 6. STEP THREE — authentication and transport

**This is now the easy part.** WhiteBooks is a pass-through gateway: you send
plain JSON over TLS and they do the GSTN-side signing and encryption. There is
**no RSA, no AES, no AppKey and no SEK** — none of the handshake the raw NIC
API demands. `lib/einvoiceCrypto.mjs` does not need to exist.

### 6.1 Base URLs

```
sandbox     https://apisandbox.whitebooks.in
production  (shown on the portal once you hold production credentials)
```

> ⚠ Their own "Best Practices" panel says `https://api.sandbox.whitebooks.in/`
> while the endpoint reference says `https://apisandbox.whitebooks.in`. **The
> endpoint reference is the one the code samples use — trust that.** Confirm
> before go-live; put the base URL in an env var either way.

### 6.2 Authenticate

```
GET {base}/einvoice/authenticate?email=<email>
```

Headers, all required, all plain strings:

| Header | Value |
|---|---|
| `username` | the firm's IRP API username |
| `password` | the firm's IRP API password |
| `ip_address` | the caller's IP |
| `client_id` | from the WhiteBooks dashboard |
| `client_secret` | from the WhiteBooks dashboard |
| `gstin` | the firm's GSTIN |

Returns an auth token. **It expires after 3600 seconds — one hour**, which is
*not* the ~6 hours the raw NIC API gives. Refresh when fewer than ~5 minutes
remain. Cache it **per firm**, never share one across tenants.

### 6.3 Generate IRN

```
POST {base}/einvoice/type/GENERATE/version/V1_03?email=<email>
Content-Type: application/json
```

| Header | Value |
|---|---|
| `ip_address`, `client_id`, `client_secret`, `username`, `gstin` | as above |
| `auth-token` | the token from §6.2. **Note the hyphen** — not `authtoken` |

The body is the **standard INV-01 payload** described in §5 — `Version`,
`TranDtls`, `DocDtls`, `SellerDtls`, `BuyerDtls`, `ItemList`, `ValDtls`, sent
as plain JSON. Optional blocks: `DispDtls`, `ShipDtls`, `PayDtls`, `RefDtls`,
`ExpDtls`, `EwbDtls`.

Two fields the schema has that §5 does not spell out, both worth sending:

- **`ItemList[].PrdDesc`** — the product description. Map `item.description`,
  falling back to `item.name`.
- **`ValDtls.Discount`** and **`ValDtls.OthChrg`** — invoice-level, alongside
  the per-line `Discount` and `OthChrg`.

Note the sample invoice number is `"MAHI/10"`, confirming that alphanumerics
with a slash are accepted.

### 6.4 The other endpoints

Eleven in total. The ones that matter here:

| Endpoint | Use |
|---|---|
| `/einvoice/authenticate` | §6.2 |
| `/einvoice/type/GENERATE/version/V1_03` | §6.3 |
| **Get IRN details by Doc Details** | **Idempotency — §7.2.** Confirmed to exist |
| Cancel IRN | Within 24 hours |
| Get e-Invoice details | Fetch a signed invoice by IRN |
| Get Rejected IRNs | Reconciliation |
| Generate e-Way Bill / Get e-Way Bill by IRN | Later, if you add e-way bills |
| Get GSTN Details | Validate a buyer's GSTIN — useful on the customer master |
| B2C QR Code | Not needed; B2C is out of scope (§1) |

### 6.5 `lib/einvoiceClient.mjs`

Thin, now that there is no crypto. One job each: `authenticate(company)`,
`generateIrn(company, payload)`, `cancelIrn(company, { irn, reason, remark })`,
`getIrnByDocDetails(company, { docType, docNo, docDate })`.

- Token cache keyed by `companyId`, in memory, refreshed at 55 minutes.
- **Never log the payload, the password, the client secret or the token.**
  The password travels in a plain header — it must not reach a log line.
- Map IRP error codes to readable messages; the error-codes PDF is on the
  WhiteBooks portal. Code **2150 = "duplicate IRN"** — treat it as success and
  fetch the existing IRN, because it means a previous attempt actually went
  through and you lost the response.

### 6.6 Getting credentials

**There are TWO separate sets, and conflating them is where this stalls.**

| | What | Whose | Where it lives |
|---|---|---|---|
| **A** | `client_id` + `client_secret` | **Yours**, as the software vendor. One pair for all your customers | `.env.local` — `EINVOICE_CLIENT_ID`, `EINVOICE_CLIENT_SECRET` |
| **B** | an IRP API **username + password** | **Each client firm's own**, created by them on the government portal | `companies.einvoiceUsername` / `einvoicePasswordEnc`, encrypted per firm |

Both are sent on every authenticate call (§6.2), along with that firm's GSTIN.
Set A identifies your software to WhiteBooks; set B is the taxpayer authorising
you to file on their behalf. Neither substitutes for the other.

#### A. WhiteBooks credentials — you, once

Free, no card:

1. Sign up at `developer.whitebooks.in`.
2. Log in to the developer dashboard.
3. On the **e-Invoice API** card, click **Credentials → Create Credentials**.
4. Fill in the popup; the `client_id` and `client_secret` come back immediately.

Sandbox credentials are isolated — no real GSTN data is touched. Also download
from the portal: the **SSL certificate (.CRT)**, the **API Reference (.DOCX)**,
the **Error Codes (.PDF)**, the **Generate IRN Attribute Details (.XLSX)** —
which is the authoritative field-level spec and should beat this file wherever
the two disagree — and the **Node.js SDK**, which may save writing §6.5 by hand.

#### B. An IRP API user — every firm, once each

The firm does this themselves, on `einvoice1.gst.gov.in`, with their own portal
login:

1. Log in.
2. **API Registration → Create API User.**
3. Choose **"Through GST Suvidha Provider"** and pick **WhiteBooks** from the
   dropdown.
4. Set a username and password, re-enter it, save.

That username and password is what they hand to you, and what the Business
profile page stores encrypted.

**The GSP route skips IP whitelisting and the sandbox test report.** This is the
single most important fact in this section. The alternative — direct API
access — requires:

- aggregate turnover **above ₹500 crore**, which no small trading firm has,
- up to **four whitelisted static public Indian IPs**, through which every
  request for every GSTIN must arrive, and
- a **sandbox test report**, scrutinised by NIC before credentials are issued.

The IP requirement alone rules out Vercel and any other host without a fixed
outbound address. Going through a GSP is what makes this feasible at all, and it
is why §11 question 6 — whether WhiteBooks itself registers your server's IP —
matters so much. If they do, the hosting constraint comes back by the side door.

**A firm that already has e-way bill API credentials can reuse them**; the same
client id, secret and API user work for e-invoicing. Worth asking each customer
before sending them through the steps above.

#### What this means for onboarding

Step B is a task you **cannot do for your customers**. Every firm you sign up
has to create its own API user and hand you the username and password. Write
them a one-page guide with screenshots — they will get stuck on it, and a
support call per customer does not scale.

#### Open question

Whether the WhiteBooks **sandbox** supplies a test username, password and GSTIN,
or expects a real IRP API user from step B. Their docs are rendered in the
browser, so this could not be read from the page source. **This is the only
thing standing between you and testing steps 7 and 8** — ask them:

> For the sandbox, do you provide test login credentials and a test GSTIN, or do
> I need to create an API user on einvoice1 first?

## 7. STEP FOUR — storage and routes

### 7.1 Invoice schema additions

```js
irn:              { type: String, index: true },
ackNo:            { type: String },
ackDt:            { type: Date },
signedQrCode:     { type: String },
signedInvoice:    { type: String },
einvoiceStatus:   { type: String, enum: ["none","generated","cancelled","failed"], default: "none" },
einvoiceCancelledAt: { type: Date },
einvoiceError:    { type: String },
```

Scoped per firm automatically by `tenantPlugin` — **do not add `companyId`
yourself** (`PROJECT_CONTEXT.md` §6.14).

### 7.2 Routes

Both wrapped in `tenantRoute`, both added to `PATH_RULES` in `lib/roles.mjs`:

| Route | Permission | Does |
|---|---|---|
| `POST /api/einvoice/generate` | `einvoice:generate` | Build payload → validate → call IRP → store IRN. Refuses a purchase, a B2C sale, or an invoice that already has an IRN |
| `POST /api/einvoice/cancel` | `einvoice:generate` | Cancel within 24h, with a reason code and remark |

Add the permission to `roles.mjs` for **owner and accountant only — not
biller**.

**Idempotency matters.** A timeout where the IRP actually registered the
invoice is the dangerous case. Before generating, call "get IRN by document
details"; if one exists, store it rather than trying again. Treat error 2150
the same way.

### 7.3 Printing the QR

`components/InvoiceDocument.jsx`. Needs the `qrcode` npm package to turn
`signedQrCode` into an image.

Print the QR plus **IRN** and **Ack No** in the header area. A reported invoice
without a visible QR is not compliant.

---

## 8. STEP FIVE — the UI

- On the billing pages: a **Generate E-Invoice** button, shown only when the
  firm has `einvoiceEnabled` and the document is a Sale or Sale Return to a
  party with a GSTIN.
- Show `problems` from the mapper **inline, before** calling the API — the user
  can fix a missing PIN without a round trip.
- Once an IRN exists: show it, show the Ack No, disable editing (§3), and offer
  **Cancel** while the 24-hour window is open.
- Invoice list / `invoice-range`: a column showing e-invoice status, so a
  shopkeeper can see at a glance what has not been reported.

---

## 9. Build order

| # | Step | Depends on | Independently useful? |
|---|---|---|---|
| 1 | Freeze invoices with an IRN (§3) | — | Yes |
| 2 | Company profile page + letterhead from the firm's record (§4.1) | — | **Yes — fixes §9.1 of the context file** |
| 3 | Buyer snapshot on the invoice (§4.3) | — | Yes |
| 4 | UQC + isService on items (§4.4, §4.5) | — | Yes |
| 5 | `einvoicePayload.mjs` + tests (§5) | 2, 3, 4 | Testable offline |
| 6 | Credential storage + `secretBox.mjs` (§4.2) | — | Yes |
| 7 | Auth + client (§6) | 6 | No — but small: no crypto layer |
| 8 | Routes + schema (§7) | 5, 7 | No |
| 9 | QR on the print (§7.3) | 8 | No |
| 10 | UI (§8) | 8 | No |

**Steps 1–6 need no credentials and no network.** Do them first — they are most
of the work, they are all testable offline, and several fix problems the app has
anyway. Step 7 is now genuinely small: a token cache and two fetch calls.

WhiteBooks' sandbox is free and instant, so you can get `client_id` and
`client_secret` today and have them waiting (§6.6).

---

## 10. Gotchas specific to this codebase

1. **`sale-alter` edits `invoiceNo`.** Incompatible with e-invoicing. §3.
2. **Mongoose strict mode silently drops undeclared fields.** Five times
   already in this project. Every new field: schema **and** create route **and**
   alter route.
3. **The invoice's `customer` is a snapshot, not a reference.** §4.3.
4. **`freight` is a `String`** in the invoice schema. Coerce it.
5. **`invoiceNo` is a `Number`.** The IRP wants a string with format rules.
6. **Four copies of the billing page.** Any UI change is made four times
   (`PROJECT_CONTEXT.md` §9.8).
7. **`stateCode` must keep its leading zero.** Use `normalizeStateCode()`.
8. **Use `splitGst()` for the tax split**, so the reported figures and the
   printed figures cannot disagree. One rule, one place.
9. **Do not add `companyId` to any query.** `tenantPlugin` does it.
10. **Never log the payload, the password, the SEK or the AppKey.**

---

## 11. Questions for WhiteBooks

**Answered already, by reading their docs (§6):**

- ~~Pass-through or client-side encryption?~~ **Pass-through. Plain JSON.**
- ~~Is there a "get IRN by document details" endpoint for idempotency?~~ **Yes.**
- ~~Sandbox cost and lead time?~~ **Free, instant, no card.**

**Still to ask their sales team (+91 8106433737):**

0. **Does the sandbox come with test login credentials and a test GSTIN**, or
   must an API user be created on `einvoice1.gst.gov.in` first? Numbered zero
   because nothing can be tested until it is answered (§6.6).
1. **Per-IRN pricing**, and any monthly minimum. No public rate card exists.
2. **Can one WhiteBooks account serve many client GSTINs**, or does each of your
   customers need their own WhiteBooks contract? **This decides whether you
   resell with a markup or your customers each contract directly** — a pricing
   decision as much as a technical one. Settle it early.
3. Do **cancellations and failed attempts** burn billable IRNs?
4. **Rate limits**, and the production base URL.
5. Is **e-way bill generation** bundled or billed separately?
6. The `ip_address` header: is it informational, or must your server's IP be
   registered with them? **This matters if you deploy to Vercel**, where the
   outbound IP is not fixed.

Question 6 is the one that could bite silently in production. Ask it before you
pick where to host.

## 12. Sources, checked 8 October 2026

- **WhiteBooks e-Invoice API reference — https://developer.whitebooks.in/apis/docs/e-invoice-api**
  (§6 is transcribed from the Authentication and Generate IRN pages there)
- MasterGST developer portal (the alternative GSP first considered) — https://mastergst.com/gst/gst-developer-api-portal.html
- NIC sandbox, Generate IRN — https://einv-apisandbox.nic.in/version1.03/generate-irn.html
- Vayana, e-invoice authentication flow — https://docs.gsp.vayana.com/E-Invoice/einvoice-authentication/
- Turnover limits and penalties — https://www.incorpx.io/blog/gst-e-invoice-turnover-limit-2026
- GSTN advisory, 30-day limit at AATO ₹10cr — https://www.taxmann.com/post/blog/time-limit-of-30-days-for-reporting-e-invoice-on-irp-portal-for-taxpayers-with-aato-of-10-crores-and-above-gstn-update/
- ClearTax, time limit for reporting — https://cleartax.in/s/time-limit-for-reporting-e-invoices-on-the-irp-portal
- **Setting up the API system, and the Create API User flow — https://cleartax.in/s/e-invoicing-api-system**
  (§6.6 B is taken from here)
- **NIC e-invoice portal FAQs, direct vs GSP access — https://einvoice1.gst.gov.in/Others/Faqs**
  (the ₹500 crore threshold, the four-IP limit, and that the GSP route needs
  neither IP whitelisting nor a test report)

The authoritative documents are the **E-Invoice API Reference (.DOCX)**, the
**Generate IRN Attribute Details (.XLSX)** and the **E-Invoice Error Codes
(.PDF)**, all downloadable from the WhiteBooks portal once you are signed in.
Prefer them over this file wherever the two disagree.

---

## 13. Prompt to paste into ChatGPT or Gemini

> I'm adding **GST e-invoicing (IRN generation)** to **Vyapaar**, a Next.js 16 +
> MongoDB GST billing app that serves several small Indian trading firms from
> one deployment. I'm pasting two files: `PROJECT_CONTEXT.md` (the codebase)
> and `EINVOICE_PLAN.md` (this feature). Read both fully before answering.
>
> Constraints from the codebase: **JavaScript, not TypeScript. React 18.
> Mongoose. Tailwind plus the component classes in §8.1 of the context file.**
> Every money write goes through `withTransaction` with `{ session }` on every
> query inside it. Every API route exports through `tenantRoute`; every tenant
> model applies `tenantPlugin`; **never add `companyId` to a query filter
> yourself.** Pure logic goes in `lib/*.mjs` with no Mongoose import, so the
> `node:assert` test suites can import it directly.
>
> For this feature specifically: **an invoice with an IRN can never be edited**;
> only Sale and Sale Return are ever reported, never Purchase; a buyer with no
> GSTIN is B2C and must not be reported; buyer details are snapshotted onto the
> invoice at save time, not looked up later; all money arithmetic goes through
> `round2` and the GST split through `splitGst()` so the reported figures and
> the printed figures cannot disagree.
>
> I'm working through §9 of the plan in order. **I am on step _<N>_.**
>
> Give me **complete files or exact find-and-replace blocks** — I paste them in
> by hand, so snippets with "..." are not useful. Tell me every file that needs
> to change, including the three sibling billing pages if you touch one of
> them. For any pure module, also give me the fixture test in the style of
> `scripts/party-balance.test.mjs`, and tell me which line to break to prove
> each test can fail.
>
> ---
>
> _<paste PROJECT_CONTEXT.md>_
>
> ---
>
> _<paste EINVOICE_PLAN.md>_

Then paste the source files that step touches. For the payload mapper that is
`models/invoiceModel.js`, `models/custModel.js`, `models/companyModel.js`,
`lib/gst.mjs`, `lib/balance.mjs` and `lib/hsnTotals.mjs`.
