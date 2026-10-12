/**
 * Fixture tests for emailing a bill to the customer.
 *
 *   node scripts/invoice-email.test.mjs
 *
 * Sending mail is the one action in this app that cannot be taken back, and it
 * goes out over the firm's own verified domain — their reputation, not ours.
 * So these are mostly about the four things that matter more than the feature:
 *
 *   1. THE ROUTE IS NOT A MAILER. It used to take the recipient, the subject,
 *      the body, the filename AND the attachment bytes from the request and
 *      hand all five to Resend, with nothing tying any of it to an invoice —
 *      so any signed-in user could send arbitrary content with an arbitrary
 *      attachment to an arbitrary address, as the firm. It now requires an
 *      invoice number and loads the bill.
 *
 *   2. EVERY ADDRESS IS VALIDATED, server-side. The dialog's identical check
 *      is a convenience; a direct POST reaches the route and only the route.
 *
 *   3. THE MESSAGE IS ESCAPED. It is free text typed by a user, going into an
 *      HTML email signed by the firm.
 *
 *   4. A SEND IS RECORDED, and only once the provider has accepted it. A log
 *      that records attempts as sends is how a shop tells a customer the bill
 *      went out when it never left the building.
 *
 * And one thing about the feature itself: the address on a party's master is a
 * DEFAULT, not a rule. A bill goes to whoever asked for it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_RECIPIENTS,
  RECIPIENT_SOURCES,
  attachmentName,
  billDate,
  decodedSize,
  defaultMessage,
  defaultMessageLines,
  defaultSubject,
  documentName,
  logEntry,
  looksLikeEmail,
  messageHtml,
  parseAddresses,
  recipientFor,
  sendProblem,
  sendTargets,
  sentSummary,
} from "../lib/invoiceEmail.mjs";
import { BUYER_FIELDS } from "../lib/buyerSnapshot.mjs";
import { canAccessPath, permissionForPath } from "../lib/roles.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const COMPANY = { name: "Shah Brothers" };

const BILL = {
  invoiceNo: 412,
  type: "Sale",
  return: false,
  date: "2026-10-05",
  customer: { name: "Acme Traders", email: "accounts@acme.in" },
  finalAmount: 118000,
  balanceDue: 48000,
};

const ok = { to: "a@b.in", subject: "Invoice 1", pdfBase64: "QUJDRA==" };

console.log("\n--- one address ---");

test("the rule is the same one the rest of the app uses", () => {
  for (const good of ["a@b.in", "accounts.dept@acme-traders.co.in", "x+bills@y.io"]) {
    assert.equal(looksLikeEmail(good), true, good);
  }
  for (const bad of ["", "   ", "a@b", "a.b.in", "@b.in", "a@", "a b@c.in", null, undefined]) {
    assert.equal(looksLikeEmail(bad), false, JSON.stringify(bad));
  }
});

console.log("\n--- a typed list ---");

test("commas, semicolons and newlines all separate", () => {
  // All three are what comes out of a paste from a contact list, a spreadsheet
  // or a WhatsApp message.
  const { valid } = parseAddresses("a@b.in, c@d.in; e@f.in\ng@h.in");
  assert.deepEqual(valid, ["a@b.in", "c@d.in", "e@f.in", "g@h.in"]);
});

test('"Name <a@b.in>" is unwrapped', () => {
  // What a paste from a mail client gives.
  assert.deepEqual(parseAddresses("Acme Accounts <ap@acme.in>").valid, ["ap@acme.in"]);
  assert.deepEqual(parseAddresses("A <a@b.in>, B <c@d.in>").valid, ["a@b.in", "c@d.in"]);
});

test("the same address twice in different casing is ONE recipient", () => {
  // Mailing the same accounts department twice because it was pasted in two
  // casings is a small embarrassment that is entirely avoidable.
  assert.deepEqual(parseAddresses("a@b.in, A@B.IN, a@b.in").valid, ["a@b.in"]);
});

test("a bad one is reported rather than swallowing the whole line", () => {
  const { valid, invalid } = parseAddresses("a@b.in, oops, c@d.in");
  assert.deepEqual(valid, ["a@b.in", "c@d.in"]);
  assert.deepEqual(invalid, ["oops"]);
});

test("empty and whitespace-only entries are not addresses, and not errors", () => {
  const { valid, invalid } = parseAddresses("a@b.in,, ,;\n");
  assert.deepEqual(valid, ["a@b.in"]);
  assert.deepEqual(invalid, []);
  assert.deepEqual(parseAddresses("").valid, []);
  assert.deepEqual(parseAddresses(null).valid, []);
});

console.log("\n--- who it goes to ---");

test("the bill's own snapshot comes first, then the master", () => {
  // The snapshot is what the bill was raised against and is frozen
  // (lib/buyerSnapshot.mjs), so an old bill stays addressed to where it went.
  const fromBill = recipientFor(BILL, { email: "newer@acme.in" });
  assert.equal(fromBill.to, "accounts@acme.in");
  assert.equal(fromBill.source, "invoice");
  assert.equal(fromBill.note, RECIPIENT_SOURCES.invoice);
});

test("the master is the fallback for a bill raised before the snapshot had one", () => {
  const fromMaster = recipientFor({ customer: { name: "Acme" } }, { email: "ap@acme.in" });
  assert.equal(fromMaster.to, "ap@acme.in");
  assert.equal(fromMaster.source, "master");
});

test("no address anywhere is reported as none, not as empty-but-fine", () => {
  const none = recipientFor({ customer: { name: "Acme" } }, null);
  assert.deepEqual([none.to, none.source], ["", "none"]);
  // An unusable stored value is the same as none -- it must not be offered.
  assert.equal(recipientFor({ customer: { email: "not-an-address" } }).source, "none");
  assert.equal(recipientFor(null).source, "none");
});

test("the email IS part of the buyer snapshot, so it reaches the bill at all", () => {
  // The whole chain depends on this. If `email` were not snapshotted,
  // `invoice.customer.email` would always be blank and the feature would
  // appear broken for every bill.
  assert.ok(BUYER_FIELDS.includes("email"));
});

console.log("\n--- what the mail says ---");

test("a credit note is not called an invoice", () => {
  // Sending one headed "your invoice" is a phone call. Derived from the same
  // { type, return } pair the whole app decides document kind from.
  assert.equal(documentName({ type: "Sale", return: false }), "Invoice");
  assert.equal(documentName({ type: "Sale", return: true }), "Credit Note");
  assert.equal(documentName({ type: "Purchase", return: false }), "Purchase Bill");
  assert.equal(documentName({ type: "Purchase", return: true }), "Debit Note");
});

test("the subject names the document, its number and the firm", () => {
  assert.equal(defaultSubject(BILL, COMPANY), "Invoice 412 from Shah Brothers");
  assert.equal(
    defaultSubject({ ...BILL, return: true }, COMPANY),
    "Credit Note 412 from Shah Brothers"
  );
  // A firm with no name yet does not get "from ".
  assert.equal(defaultSubject(BILL, {}), "Invoice 412");
  assert.equal(defaultSubject({}, COMPANY), "Invoice from Shah Brothers");
});

test("the body carries the figures, not just 'please find attached'", () => {
  // The old body was "<p>Please find your invoice attached.</p>" -- nothing a
  // reader could check without opening the attachment, and nothing at all if
  // the attachment fails to download.
  const body = defaultMessage(BILL, COMPANY);
  assert.match(body, /Dear Acme Traders,/);
  assert.match(body, /Invoice no\. 412/);
  assert.match(body, /dated 05-10-2026/);
  assert.match(body, /Total: 1,18,000\.00/);
  assert.match(body, /Amount due: 48,000\.00/);
  assert.match(body, /Shah Brothers/);
});

test("a PAID bill does not invite a payment that has been made", () => {
  // "Amount due: 0.00" on a settled bill is worse than silence.
  const paid = defaultMessage({ ...BILL, balanceDue: 0 }, COMPANY);
  assert.equal(/Amount due/.test(paid), false);
  assert.match(paid, /Total: 1,18,000\.00/);
  // And a credit note, whose balanceDue is negative, likewise.
  assert.equal(/Amount due/.test(defaultMessage({ ...BILL, balanceDue: -500 }, COMPANY)), false);
});

test("a bill with no total prints no total line", () => {
  const blank = defaultMessageLines({ invoiceNo: 1, type: "Sale" }, COMPANY);
  assert.equal(blank.some((l) => /Total:/.test(l)), false);
  assert.ok(blank.some((l) => /Please find attached/.test(l)));
  // Nor a zero one. "Total: 0.00" is a figure the recipient has to ring up
  // about, and a bill that totals nothing is a bill still being drafted.
  const nil = defaultMessageLines({ ...BILL, finalAmount: 0, balanceDue: 0 }, COMPANY);
  assert.equal(nil.some((l) => /Total:/.test(l)), false);
});

test("the date is the IST calendar day", () => {
  // 19:00 UTC on the 4th is 00:30 IST on the 5th.
  assert.equal(billDate("2026-10-04T19:00:00Z"), "05-10-2026");
  assert.equal(billDate("2026-10-04T12:00:00Z"), "04-10-2026");
  assert.equal(billDate(""), "");
  assert.equal(billDate("nonsense"), "");
});

test("THE MESSAGE IS ESCAPED on its way into the HTML", () => {
  // Free text typed by a user, going into an email signed by the firm.
  const html = messageHtml('Hi <script>alert(1)</script> & "quoted"');
  assert.equal(/<script>/.test(html), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("newlines become breaks, and blank lines become paragraphs", () => {
  const html = messageHtml("one\ntwo\n\nthree");
  assert.match(html, /one<br \/>two/);
  assert.equal((html.match(/<p /g) || []).length, 2);
});

test("an emptied message still sends something", () => {
  // Somebody who cleared the box meant to clear it, and an email with an
  // attachment and no body at all reads as a mistake.
  assert.match(messageHtml(""), /Please find the attached document/);
  assert.match(messageHtml("   \n  "), /Please find the attached document/);
});

console.log("\n--- the attachment ---");

test("it is named after the document, so four bills are four files", () => {
  // A customer with four bills from you should not end up with invoice.pdf,
  // invoice(1).pdf, invoice(2).pdf.
  assert.equal(attachmentName(BILL), "Invoice_412.pdf");
  assert.equal(attachmentName({ ...BILL, return: true }), "Credit_Note_412.pdf");
  assert.equal(attachmentName({ type: "Purchase", invoiceNo: 9 }), "Purchase_Bill_9.pdf");
  assert.equal(attachmentName({}), "Invoice.pdf");
});

test("its size is measured on the DECODED bytes", () => {
  assert.equal(decodedSize("QUJDRA=="), 4);
  assert.equal(decodedSize(""), 0);
  assert.equal(decodedSize(null), 0);
  // Padding discounted: a measure that ignores it is wrong for two thirds of
  // all payloads.
  assert.equal(decodedSize(Buffer.from("x".repeat(3001)).toString("base64")), 3001);
  assert.equal(decodedSize(Buffer.from("x".repeat(3002)).toString("base64")), 3002);
});

console.log("\n--- what cannot be sent ---");

test("a good request has no problem", () => {
  assert.equal(sendProblem(ok), null);
  assert.equal(sendProblem({ ...ok, cc: "c@d.in" }), null);
});

test("no recipient, or a bad one, is refused", () => {
  assert.match(sendProblem({ ...ok, to: "" }), /at least one email address/);
  assert.match(sendProblem({ ...ok, to: "   " }), /at least one email address/);
  assert.match(sendProblem({ ...ok, to: "oops" }), /"oops" is not an email address/);
  // The bad one is named even when a good one is beside it -- silently
  // dropping it would send to fewer people than the sender believes.
  assert.match(sendProblem({ ...ok, to: "a@b.in, oops" }), /"oops"/);
  assert.match(sendProblem({ ...ok, cc: "nope" }), /"nope" is not an email address/);
});

test("a subject is required", () => {
  assert.match(sendProblem({ ...ok, subject: "" }), /subject/);
  assert.match(sendProblem({ ...ok, subject: "   " }), /subject/);
});

test("an attachment is required, and capped", () => {
  assert.match(sendProblem({ ...ok, pdfBase64: "" }), /no document to attach/);
  const huge = "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1024) / 3) * 4);
  assert.match(sendProblem({ ...ok, pdfBase64: huge }), /MB/);
});

test("a mailing list is refused", () => {
  // This is an invoice, not a newsletter, and the firm's domain reputation is
  // what pays for being treated as one.
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `a${i}@b.in`).join(",");
  assert.match(sendProblem({ ...ok, to: many }), new RegExp(String(MAX_RECIPIENTS + 1)));
  // And the Cc counts towards it.
  const toMany = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `a${i}@b.in`).join(",");
  assert.match(sendProblem({ ...ok, to: toMany, cc: "one@more.in" }), /at most/);
  assert.equal(sendProblem({ ...ok, to: toMany }), null);
});

test("the targets are the deduped, validated lists", () => {
  // Both lists: a bad address handed to the provider is a bounce on the
  // firm's own domain, which is what their deliverability is made of.
  const targets = sendTargets({ to: "a@b.in, A@B.IN, oops", cc: "c@d.in, bad" });
  assert.deepEqual(targets.to, ["a@b.in"]);
  assert.deepEqual(targets.cc, ["c@d.in"]);
});

console.log("\n--- the send log ---");

test("an entry records who, where and when", () => {
  const entry = logEntry({
    to: ["a@b.in"],
    cc: ["c@d.in"],
    messageId: "re_123",
    by: "Prashant",
    at: Date.parse("2026-10-12T06:00:00Z"),
  });
  assert.deepEqual(entry.to, ["a@b.in"]);
  assert.deepEqual(entry.cc, ["c@d.in"]);
  assert.equal(entry.messageId, "re_123");
  assert.equal(entry.by, "Prashant");
  assert.ok(entry.at instanceof Date);
});

test("an entry is a COPY, so the row Mongo stores cannot change afterwards", () => {
  // The route builds the entry and then pushes it; if the entry held the
  // caller's own arrays, anything that touched them in between would change
  // what the log says the mail went to.
  const to = ["a@b.in"];
  const cc = [];
  const entry = logEntry({ to, cc, by: "Prashant" });
  to.push("someone@else.in");
  cc.push("also@else.in");
  assert.deepEqual(entry.to, ["a@b.in"]);
  assert.deepEqual(entry.cc, []);
});

test("the sender and the message id are stored as plain trimmed text", () => {
  // `by` comes from the session, but it is still a name typed by a person
  // when the staff row was created.
  assert.equal(logEntry({ by: "  Prashant  " }).by, "Prashant");
  assert.equal(logEntry({ by: null }).by, "");
  assert.equal(logEntry({ messageId: " re_9 " }).messageId, "re_9");
  assert.equal(logEntry({}).messageId, "");
});

test("the summary names the latest send and counts them all", () => {
  // A bill emailed four times is usually a bill somebody kept being asked
  // for, and that is worth seeing before sending a fifth.
  const once = sentSummary({ emailLog: [{ to: ["a@b.in"], at: "2026-10-05" }] });
  assert.equal(once, "Emailed to a@b.in on 05-10-2026");

  const twice = sentSummary({
    emailLog: [
      { to: ["a@b.in"], at: "2026-10-05" },
      { to: ["c@d.in"], at: "2026-10-11" },
    ],
  });
  assert.match(twice, /Emailed to c@d.in on 11-10-2026/, "the LATEST, not the first");
  assert.match(twice, /2 times in all/);
});

test("reading the summary does not reorder the log it read", () => {
  // It sorts to find the latest. Sorting the invoice's own array in place
  // would hand the screen a reordered log -- and, on a Mongoose document,
  // mark it dirty.
  const log = [
    { to: ["a@b.in"], at: "2026-10-05" },
    { to: ["c@d.in"], at: "2026-10-11" },
  ];
  sentSummary({ emailLog: log });
  assert.deepEqual(log.map((r) => r.to[0]), ["a@b.in", "c@d.in"]);
});

test("a bill never emailed says nothing at all", () => {
  // Rather than "never emailed", which is a line on every bill in the book.
  assert.equal(sentSummary({}), "");
  assert.equal(sentSummary({ emailLog: [] }), "");
  assert.equal(sentSummary(null), "");
});

console.log("\n--- the route is not a mailer ---");

test("it requires an invoice number and LOADS the bill", () => {
  const route = read("../app/api/send-email/route.js");
  assert.match(route, /Invoice\.findOne\(\{ invoiceNo: number \}\)/);
  assert.match(route, /No invoice \$\{number\} in your books/);
  // Tenant-scoped by the plugin, so it can only ever be this firm's bill.
  assert.match(route, /export const POST = tenantRoute\(handlePOST\);/);
});

test("the sender and the filename are NOT taken from the body", () => {
  const route = code(read("../app/api/send-email/route.js"));
  // `from` is the signed-in firm, or this is a way to send mail as somebody
  // else.
  assert.match(route, /from: senderFor\(firmName\)/);
  assert.equal(/from: body\.|from: req/.test(route), false);
  // The attachment is named from the LOADED invoice.
  assert.match(route, /filename: attachmentName\(invoice\)/);
  assert.equal(/fileName/.test(route), false, "the old client-supplied filename is back");
  // And the old client-supplied HTML body is gone.
  assert.equal(/htmlContent/.test(route), false);
  assert.equal(/toEmail/.test(route), false);
});

test("every address and the attachment are validated server-side", () => {
  const route = read("../app/api/send-email/route.js");
  assert.match(route, /sendProblem\(\{ to, cc, subject: finalSubject, pdfBase64 \}\)/);
  assert.match(route, /sendTargets\(\{ to, cc \}\)/);
  assert.match(route, /messageHtml\(finalMessage\)/);
});

test("the send is recorded AFTER the provider accepts, not before", () => {
  const route = read("../app/api/send-email/route.js");
  const rejected = route.indexOf("if (error) {");
  const pushed = route.indexOf("$push: { emailLog");
  assert.ok(rejected > 0 && pushed > rejected, "the log is written before the rejection check");
  // $push rather than read-modify-write: two people emailing the same bill at
  // once must not lose one of the rows.
  assert.match(route, /\$push: \{ emailLog: entry \}/);
  // And `by` is the session's user, never the body's.
  assert.match(route, /by: auth\?\.name \|\| auth\?\.email/);
});

test("a failed LOG does not report a failed send", () => {
  // The mail has gone. Telling the shop it failed is the worse lie -- they
  // would send it twice.
  const route = read("../app/api/send-email/route.js");
  assert.match(route, /logged = false/);
  assert.match(route, /could not be recorded/);
});

test("the model declares the log, because strict mode drops what is not", () => {
  const model = read("../models/invoiceModel.js");
  assert.match(model, /emailLog: \[/);
  for (const field of ["to", "cc", "messageId", "by", "at"]) {
    assert.match(model, new RegExp(`\\b${field}:`), field);
  }
});

console.log("\n--- the button that was missing ---");

test("THERE IS A BUTTON NOW", () => {
  // The feature was complete and unreachable: `sendInvoice()` sat in this page
  // and nothing rendered it. Reading the route or the module would have told
  // you it worked.
  const page = read("../app/invoice/page.js");
  assert.match(page, /Email to Customer/);
  assert.match(page, /<EmailInvoiceDialog/);
  assert.match(page, /setEmailing\(true\)/);
  // And the dead function is gone rather than left beside the new path.
  assert.equal(/const sendInvoice = async/.test(code(page)), false);
});

test("the page shows when the bill was last emailed", () => {
  const page = read("../app/invoice/page.js");
  assert.match(page, /sentSummary\(invoice\)/);
});

test("the dialog offers the address, editable, and says where it came from", () => {
  const dialog = read("../components/EmailInvoiceDialog.jsx");
  assert.match(dialog, /recipientFor\(invoice, party\)/);
  assert.match(dialog, /onChange=\{\(e\) => setTo\(e\.target\.value\)\}/);
  // It must say plainly that changing it does not touch the master: the
  // address one bill went to is not the party's address.
  assert.match(dialog, /not saved back to their master/);
  // And it checks the same rules the route does.
  assert.match(dialog, /sendProblem\(/);
  assert.match(dialog, /sentSummary\(invoice\)/);
});

test("the dialog does not write to the customer master", () => {
  const dialog = code(read("../components/EmailInvoiceDialog.jsx"));
  for (const route of ["customer-alter", "customer-add", "item-alter"]) {
    assert.equal(dialog.includes(route), false, `the dialog posts to ${route}`);
  }
});

console.log("\n--- permissions ---");

test("the route is behind the same rule as the page it is used from", () => {
  // Emailing a bill is part of billing: all three roles raise invoices and
  // all three may send them. What matters is that the route and the page
  // cannot drift apart.
  assert.equal(permissionForPath("/api/send-email"), permissionForPath("/invoice"));
  for (const role of ["owner", "accountant", "biller"]) {
    assert.equal(
      canAccessPath(role, "/api/send-email"),
      canAccessPath(role, "/invoice"),
      role
    );
  }
});

test("nothing in the pure module sends or stores anything", () => {
  const src = read("../lib/invoiceEmail.mjs");
  assert.equal(/import mongoose/.test(src), false);
  assert.equal(/from "\.\.\/models/.test(src), false);
  assert.equal(/fetch\(|new Resend/.test(code(src)), false);
});

console.log(`\n  ${passed} checks passed\n`);
