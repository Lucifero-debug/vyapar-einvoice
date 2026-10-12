/**
 * Emailing a bill to the party it was raised against.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/invoice-email.test.mjs directly. Never import Mongoose in here, and
 * nothing here sends anything — it decides who, what it says, and what is
 * wrong with the request.
 *
 *
 * WHAT WAS MISSING, AND IT WAS NOT THE CODE
 * -----------------------------------------
 * `sendInvoice()` has been sitting in `app/invoice/page.js` for some time,
 * `/api/send-email` works, Resend is configured, and `customer.email` is part
 * of the buyer snapshot (`lib/buyerSnapshot.mjs`) so it reaches the invoice.
 *
 * There was no BUTTON. The function was never rendered, so nothing could call
 * it. The feature was complete and unreachable — which is worth recording,
 * because reading the route or the module would have told you it worked.
 *
 *
 * THE ADDRESS IS PREFILLED, NOT FIXED
 * -----------------------------------
 * The old function took `invoice.customer.email` and, finding none, alerted
 * "add one under Customers, then try again" — a dead end in the middle of
 * something else.
 *
 * It is also the wrong model of how a bill is sent. A shop emails an invoice
 * to whoever asked for it: an accounts department, a purchase officer, a
 * WhatsApp-forwarded "send it to my CA at ...". The party's master holds ONE
 * address, which is a good default and a bad rule. So the master's address is
 * offered, `source` says where it came from, and the person can change it or
 * add others — and nothing is written back to the master, because the address
 * one bill went to is not the party's address.
 *
 *
 * EVERY SEND IS RECORDED
 * ----------------------
 * "Did you send me the bill?" is a daily question in a trading business, and
 * before this nothing could answer it. `emailLog` on the invoice is
 * append-only: who it went to, when, and the provider's message id. It is
 * written by the ROUTE after the provider accepts, never by the browser —
 * a log the client could write is a log that says what the client wanted.
 */

const text = (value) => String(value ?? "").trim();

/**
 * One address, by the same rule the rest of the app uses.
 *
 * Deliberately the simple shape — something, an @, something, a dot,
 * something. The full RFC grammar accepts addresses no mail server will
 * deliver to and rejects none of the typos that actually happen. The same
 * pattern guards `profileProblems` in lib/company.mjs; keep them identical.
 */
export const looksLikeEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value));

export const MAX_RECIPIENTS = 10;

/**
 * A typed list of addresses, split and cleaned.
 *
 * Commas, semicolons and newlines all separate, because all three are what
 * comes out of a paste from a contact list or a WhatsApp message.
 * Case-insensitively deduped — mailing the same accounts department twice
 * because it was pasted in two casings is a small embarrassment that is
 * entirely avoidable.
 *
 * Returns `{ valid, invalid }` rather than throwing, so a screen can show the
 * one bad address rather than refusing the whole line.
 */
export const parseAddresses = (value) => {
  const seen = new Set();
  const valid = [];
  const invalid = [];

  for (const part of text(value).split(/[,;\n]+/)) {
    const one = text(part);
    if (!one) continue;
    // "Name <a@b.in>" is what a paste from a mail client gives.
    const angled = /<([^>]+)>\s*$/.exec(one);
    const address = text(angled ? angled[1] : one);
    if (!looksLikeEmail(address)) {
      invalid.push(one);
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(address);
  }

  return { valid, invalid };
};

/* ──────────────────────────── who it goes to ─────────────────────────── */

export const RECIPIENT_SOURCES = {
  invoice: "the address on this bill",
  master: "the address on the party's master",
  none: "",
};

/**
 * The address to offer, and where it came from.
 *
 * The INVOICE's snapshot first, then the party's master. That order is not
 * arbitrary: the snapshot is what the bill was raised against and is frozen
 * (lib/buyerSnapshot.mjs), so a party whose address changed next year still
 * has their old bill addressed to where it was sent from. The master is the
 * fallback for a bill raised before the snapshot carried an email.
 *
 * `party` is optional — the screen passes the master row when it has one.
 */
export const recipientFor = (invoice, party = null) => {
  const onInvoice = text(invoice?.customer?.email);
  if (looksLikeEmail(onInvoice)) {
    return { to: onInvoice, source: "invoice", note: RECIPIENT_SOURCES.invoice };
  }

  const onMaster = text(party?.email);
  if (looksLikeEmail(onMaster)) {
    return { to: onMaster, source: "master", note: RECIPIENT_SOURCES.master };
  }

  return { to: "", source: "none", note: RECIPIENT_SOURCES.none };
};

/* ───────────────────────── what the mail says ────────────────────────── */

const money = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** dd-mm-yyyy, from the IST calendar day like every other date in this app. */
export const billDate = (value) => {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const ist = new Date(at.getTime() + (5 * 60 + 30) * 60 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${ist.getUTCFullYear()}`;
};

/**
 * What kind of document this is, in the words a customer would recognise.
 *
 * A credit note is not "your invoice", and sending one headed that way is a
 * phone call. Derived from the same `{ type, return }` pair the whole app
 * decides document kind from (lib/billingTypes.mjs's 2x2).
 */
export const documentName = (invoice) => {
  const purchase = text(invoice?.type) === "Purchase";
  const isReturn = invoice?.return === true;
  if (purchase) return isReturn ? "Debit Note" : "Purchase Bill";
  return isReturn ? "Credit Note" : "Invoice";
};

/** "Invoice 412 from Shah Brothers". */
export const defaultSubject = (invoice, company) => {
  const kind = documentName(invoice);
  const no = text(invoice?.invoiceNo);
  const firm = text(company?.name);
  const head = no ? `${kind} ${no}` : kind;
  return firm ? `${head} from ${firm}` : head;
};

/**
 * The covering note, as lines.
 *
 * The old body was `"<p>Please find your invoice attached.</p>"` — which tells
 * the reader nothing they could check without opening the attachment, and
 * nothing at all if the attachment fails to download. A bill's number, date
 * and amount in the body means the mail is useful on a phone, searchable in
 * the recipient's inbox, and verifiable against the PDF.
 *
 * The BALANCE DUE is included only when there is one. "Amount due: 0.00" on a
 * paid bill invites a payment that has already been made.
 */
export const defaultMessageLines = (invoice, company) => {
  const kind = documentName(invoice);
  const no = text(invoice?.invoiceNo);
  const date = billDate(invoice?.date);
  const firm = text(company?.name);
  const party = text(invoice?.customer?.name);

  const lines = [];
  lines.push(party ? `Dear ${party},` : "Hello,");
  lines.push("");

  const what = [kind, no && `no. ${no}`, date && `dated ${date}`].filter(Boolean).join(" ");
  lines.push(`Please find attached ${what}.`);

  const total = Number(invoice?.finalAmount);
  if (Number.isFinite(total) && total !== 0) {
    lines.push(`Total: ${money(total)}`);
  }
  const due = Number(invoice?.balanceDue);
  if (Number.isFinite(due) && due > 0) {
    lines.push(`Amount due: ${money(due)}`);
  }

  lines.push("");
  lines.push("Do let us know if anything on it needs correcting.");
  lines.push("");
  lines.push(firm ? `Regards,\n${firm}` : "Regards");

  return lines;
};

export const defaultMessage = (invoice, company) =>
  defaultMessageLines(invoice, company).join("\n");

/**
 * The body as HTML, from whatever the person typed.
 *
 * ESCAPED, then newlines turned into breaks. The message is free text typed
 * by a user and it is going into an HTML email over the firm's own verified
 * domain: pasting it in raw would let a stray `<` break the mail at best, and
 * at worst put whatever was pasted into a message signed by the firm.
 */
export const messageHtml = (message) => {
  const escaped = text(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, "<br />"))
    .filter((block) => block.length);
  if (!paragraphs.length) return "<p>Please find the attached document.</p>";
  return paragraphs
    .map((block) => `<p style="margin:0 0 12px;font:14px/1.5 Arial,sans-serif">${block}</p>`)
    .join("");
};

/**
 * The attachment's name: what the recipient will see in their downloads.
 *
 * The document kind and the number, slugged. "Invoice_412.pdf" rather than
 * "invoice.pdf" — a customer with four bills from you should not end up with
 * invoice.pdf, invoice(1).pdf, invoice(2).pdf.
 */
export const attachmentName = (invoice) => {
  const kind = documentName(invoice).replace(/\s+/g, "_");
  const no = text(invoice?.invoiceNo);
  return no ? `${kind}_${no}.pdf` : `${kind}.pdf`;
};

/* ──────────────────────────── the request ────────────────────────────── */

/**
 * The cap on the attachment, in DECODED bytes.
 *
 * 8MB. Resend's own limit is around 40MB total and most mail servers start
 * refusing around 10 to 25, so a bill that exceeds this would not arrive
 * anywhere useful — and a page-per-line PDF of a two-hundred-line bill is the
 * only way to reach it.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Roughly how many bytes a base64 payload decodes to. */
export const decodedSize = (base64) => {
  const payload = text(base64);
  if (!payload) return 0;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

/**
 * Why this cannot be sent, in words. Null when it can be.
 *
 * CHECKED ON THE SERVER. The dialog checks the same things for a quicker
 * answer, but a direct POST reaches this and only this — and this route sends
 * mail from the firm's own verified domain, which is the one thing in the app
 * that cannot be taken back once it has happened.
 */
export const sendProblem = ({ to, cc, subject, pdfBase64 } = {}) => {
  const recipients = parseAddresses(to);

  if (recipients.invalid.length) {
    return `"${recipients.invalid[0]}" is not an email address.`;
  }
  if (!recipients.valid.length) {
    return "Give at least one email address to send this to.";
  }

  const copies = parseAddresses(cc);
  if (copies.invalid.length) {
    return `"${copies.invalid[0]}" is not an email address.`;
  }

  const total = recipients.valid.length + copies.valid.length;
  if (total > MAX_RECIPIENTS) {
    return `That is ${total} recipients. Send to at most ${MAX_RECIPIENTS} at a time.`;
  }

  if (!text(subject)) return "Give the email a subject.";

  if (!text(pdfBase64)) return "There is no document to attach.";
  const size = decodedSize(pdfBase64);
  if (size > MAX_ATTACHMENT_BYTES) {
    return `That attachment is ${Math.round(size / (1024 * 1024))}MB. The limit is ${
      MAX_ATTACHMENT_BYTES / (1024 * 1024)
    }MB.`;
  }

  return null;
};

/** The addresses a validated request actually sends to. */
export const sendTargets = ({ to, cc } = {}) => ({
  to: parseAddresses(to).valid,
  cc: parseAddresses(cc).valid,
});

/* ──────────────────────────── the send log ───────────────────────────── */

/**
 * One row for the invoice's `emailLog`.
 *
 * `by` is the signed-in user, from the session — never from the body. A log
 * saying who sent something, where the sender is whoever the request claimed
 * to be, is worse than no log.
 */
export const logEntry = ({ to = [], cc = [], messageId = "", by = "", at = Date.now() } = {}) => ({
  to: [...to],
  cc: [...cc],
  messageId: text(messageId),
  by: text(by),
  at: new Date(at),
});

/**
 * "Emailed to a@b.in on 12-10-2026" — the line the screen shows.
 *
 * The LATEST send, and how many there have been. A bill emailed four times is
 * usually a bill somebody kept being asked for, and that is worth seeing
 * before sending a fifth.
 */
export const sentSummary = (invoice) => {
  const log = Array.isArray(invoice?.emailLog) ? invoice.emailLog : [];
  if (!log.length) return "";

  const sorted = [...log].sort((a, b) => new Date(b?.at || 0) - new Date(a?.at || 0));
  const latest = sorted[0];
  const who = (Array.isArray(latest?.to) ? latest.to : []).filter(Boolean);
  const when = billDate(latest?.at);

  const head = who.length
    ? `Emailed to ${who.join(", ")}${when ? ` on ${when}` : ""}`
    : `Emailed${when ? ` on ${when}` : ""}`;

  return log.length > 1 ? `${head} · ${log.length} times in all` : head;
};
