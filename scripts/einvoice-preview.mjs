/**
 * Show the INV-01 payload for an invoice you have already saved — or say why
 * it cannot be built yet.
 *
 *   node scripts/einvoice-preview.mjs 42
 *   node scripts/einvoice-preview.mjs 42 --json > invoice-42.json
 *
 * READ ONLY. It touches no network, needs no WhiteBooks credentials, and
 * changes nothing in the database.
 *
 * This exists because the reporting routes are not built yet (steps 7 to 10 of
 * EINVOICE_PLAN.md), so saving an invoice produces no payload on its own. The
 * mapper is finished and tested, though, and it is the part that decides
 * whether a filing would be accepted — so this runs it against your real data
 * and prints either the JSON the IRP would receive or the list of reasons it
 * would be refused.
 *
 * Run it on a bill you have just raised. It is the cheapest way to find out
 * which of your masters are still incomplete, long before any credentials
 * exist.
 *
 * Deliberately uses the RAW driver rather than the Mongoose models: the models
 * are tenant-scoped and would need a request context. A script has none, so it
 * scopes by companyId itself, explicitly, which is also easier to read.
 */

import mongoose from "mongoose";
import { loadEnv } from "./_shared.mjs";
import { buildEinvoicePayload } from "../lib/einvoicePayload.mjs";
import { irpMissing } from "../lib/company.mjs";
import { buyerMissing, isB2B } from "../lib/buyerSnapshot.mjs";

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const invoiceNo = Number(args.find((a) => /^\d+$/.test(a)));

const say = (...parts) => {
  // With --json, everything but the payload goes to stderr, so the output can
  // be piped straight into a file.
  if (jsonOnly) console.error(...parts);
  else console.log(...parts);
};

if (!Number.isFinite(invoiceNo)) {
  console.error("Usage: node scripts/einvoice-preview.mjs <invoiceNo> [--json]");
  process.exit(1);
}

loadEnv();
if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
say(`database : ${mongoose.connection.name}`);

const companies = await db.collection("companies").find({}).toArray();
if (companies.length === 0) {
  console.error("No firm in this database. Sign up first.");
  await mongoose.disconnect();
  process.exit(1);
}
if (companies.length > 1) {
  console.error(`This database holds ${companies.length} firms:`);
  for (const c of companies) console.error(`   ${c._id}  ${c.name}`);
  console.error("This preview expects one. Point it at a database with a single firm.");
  await mongoose.disconnect();
  process.exit(1);
}

const company = companies[0];
say(`firm     : ${company.name}`);

const invoice = await db
  .collection("invoices")
  .findOne({ invoiceNo, companyId: company._id });

if (!invoice) {
  console.error(`\nNo invoice ${invoiceNo} in this firm's books.`);
  const some = await db
    .collection("invoices")
    .find({ companyId: company._id }, { projection: { invoiceNo: 1, type: 1 } })
    .sort({ invoiceNo: -1 })
    .limit(10)
    .toArray();
  if (some.length) {
    console.error("The most recent are:");
    for (const i of some) console.error(`   ${i.invoiceNo}  ${i.type}`);
  } else {
    console.error("This firm has no invoices at all yet.");
  }
  await mongoose.disconnect();
  process.exit(1);
}

say(
  `invoice  : ${invoice.invoiceNo}  ${invoice.type}` +
    `${invoice.return ? " (return)" : ""}  ${invoice.customer?.name || "no party"}` +
    `  ${Number(invoice.finalAmount || 0).toFixed(2)}`
);
say("");

const { payload, problems } = buildEinvoicePayload({ invoice, company });

if (problems.length) {
  say(`This invoice cannot be reported yet — ${problems.length} thing${problems.length === 1 ? "" : "s"} to fix:\n`);
  problems.forEach((p, i) => say(`  ${i + 1}. ${p}`));

  // The two that are almost always about master data rather than this bill.
  const seller = irpMissing(company);
  if (seller.length) {
    say(`\n  Your firm's profile is missing: ${seller.join(", ")}`);
    say("  Fill it in at /company (Setup -> Business profile).");
  }
  if (isB2B(invoice.customer)) {
    const buyer = buyerMissing(invoice.customer);
    if (buyer.length) {
      say(`\n  The buyer snapshot on this invoice is missing: ${buyer.join(", ")}`);
      say("  Correct the party's master, then re-save this invoice to re-snapshot it.");
    }
  }
  say("");
  await mongoose.disconnect();
  process.exit(1);
}

say("This invoice would be accepted. The payload the IRP would receive:\n");
console.log(JSON.stringify(payload, null, 2));
say("");
say(`lines    : ${payload.ItemList.length}`);
say(`taxable  : ${payload.ValDtls.AssVal.toFixed(2)}`);
say(
  `tax      : CGST ${payload.ValDtls.CgstVal.toFixed(2)}  ` +
    `SGST ${payload.ValDtls.SgstVal.toFixed(2)}  IGST ${payload.ValDtls.IgstVal.toFixed(2)}`
);
say(`total    : ${payload.ValDtls.TotInvVal.toFixed(2)} (rounding ${payload.ValDtls.RndOffAmt.toFixed(2)})`);
say("");
say("Nothing has been sent anywhere. Reporting it needs steps 7 and 8 of EINVOICE_PLAN.md.");

await mongoose.disconnect();
