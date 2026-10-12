import { Resend } from "resend";
import { NextResponse } from "next/server";
import Invoice from "@/models/invoiceModel";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  attachmentName,
  defaultMessage,
  defaultSubject,
  logEntry,
  messageHtml,
  sendProblem,
  sendTargets,
} from "@/lib/invoiceEmail.mjs";
import { tooManyResponse } from "@/lib/rateLimit.mjs";
import { hitRateLimit } from "@/lib/rateLimitStore.mjs";

/**
 * Email a bill to the party it was raised against.
 *
 *
 * IT USED TO BE A MAILER, NOT AN INVOICE ROUTE
 * --------------------------------------------
 * The previous version took the recipient, the subject, the HTML body, the
 * filename AND the attachment bytes straight from the request and handed all
 * five to Resend. Nothing tied any of it to an invoice, so any signed-in user
 * — a biller included — could send arbitrary content, with an arbitrary
 * attachment, to an arbitrary address, **from the firm's own verified
 * domain**. That is somebody else's reputation to spend, and it is the one
 * action in this app that cannot be taken back.
 *
 * So the route now requires an `invoiceNo`, loads it (tenant-scoped, so it can
 * only ever be this firm's own bill), and derives the ATTACHMENT'S NAME from
 * the loaded document. The subject and the message are still the sender's own
 * words — they are a person writing to their own customer, and that is the
 * point of the feature — but they are capped, escaped (`messageHtml`), and
 * they travel with a bill that provably exists.
 *
 * The PDF itself is still rendered in the browser (html2pdf over
 * `components/InvoiceDocument.jsx`) because that is where the bill is already
 * laid out, and there is no server-side renderer in this project. The cap in
 * `lib/invoiceEmail.mjs` is what keeps that from being a way to post 40MB.
 *
 *
 * AND IT RECORDS THE SEND
 * -----------------------
 * `emailLog` on the invoice, appended after the provider ACCEPTS — not before,
 * and not when it rejects. A log that records attempts as sends is how a shop
 * tells a customer the bill went out when it never left the building.
 */

// Sending is never cached, and never prerendered.
export const dynamic = "force-dynamic";

/** Long enough for a covering note, short enough not to be a payload. */
const MAX_SUBJECT = 200;
const MAX_MESSAGE = 4000;

const senderFor = (firmName) => {
  const name = String(firmName || "").trim() || "Vyapaar";
  const address = process.env.INVOICE_FROM_EMAIL || "onboarding@resend.dev";
  return `${name} <${address}>`;
};

async function handlePOST(req, auth) {
  try {
    // Missing configuration used to surface as an opaque failure from the
    // Resend client. Say what is actually wrong.
    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { success: false, error: "Email is not configured — RESEND_API_KEY is not set." },
        { status: 503 }
      );
    }

    const body = await req.json();
    const { invoiceNo, to, cc, subject, message, pdfBase64 } = body;

    const number = Number(invoiceNo);
    if (!Number.isFinite(number) || number <= 0) {
      return NextResponse.json(
        { success: false, error: "Which invoice? No invoice number was given." },
        { status: 400 }
      );
    }

    await connect();

    // Scoped by the plugin, so this can only ever be the caller's own firm's
    // bill (§6.14). That single lookup is what stops this being a generic
    // mailer — see the note above.
    const invoice = await Invoice.findOne({ invoiceNo: number }).lean();
    if (!invoice) {
      return NextResponse.json(
        { success: false, error: `No invoice ${number} in your books.` },
        { status: 404 }
      );
    }

    const firmName = auth?.company?.name;
    const company = { name: firmName };

    // The sender's own words, defaulted from the bill and capped. `undefined`
    // takes the default; an empty string does not — somebody who cleared the
    // message meant to clear it.
    const finalSubject = (
      subject === undefined || subject === null ? defaultSubject(invoice, company) : String(subject)
    )
      .trim()
      .slice(0, MAX_SUBJECT);
    const finalMessage = (
      message === undefined || message === null ? defaultMessage(invoice, company) : String(message)
    ).slice(0, MAX_MESSAGE);

    // Every address, the recipient count and the attachment size — all checked
    // here, because the dialog's identical check is a convenience and this is
    // the rule.
    const problem = sendProblem({ to, cc, subject: finalSubject, pdfBase64 });
    if (problem) {
      return NextResponse.json({ success: false, error: problem }, { status: 400 });
    }

    // How many go out: per person per hour, then per firm per day
    // (EMAIL_HOURLY_LIMIT_PER_USER, EMAIL_DAILY_LIMIT; lib/rateLimit.mjs).
    // The person's count goes FIRST, and the firm is only counted once the
    // person is allowed, so one member of staff retrying past their own cap
    // cannot use up the whole firm's day.
    const byUser = await hitRateLimit("email-user", String(auth?.userId || auth?.email || ""));
    const byFirm = byUser.allowed
      ? await hitRateLimit("email-firm", String(auth?.companyId || ""))
      : null;
    const refused = !byUser.allowed ? byUser : byFirm && !byFirm.allowed ? byFirm : null;
    if (refused) {
      const { status, body, headers } = tooManyResponse(refused, "emails sent");
      return NextResponse.json(body, { status, headers });
    }

    const targets = sendTargets({ to, cc });

    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      // NOT from the body. The sender is the signed-in firm, or this would be
      // a way to send mail as somebody else.
      from: senderFor(firmName),
      to: targets.to,
      ...(targets.cc.length ? { cc: targets.cc } : {}),
      // A reply goes to whoever sent it, not to the no-reply sending address.
      ...(auth?.email ? { replyTo: auth.email } : {}),
      subject: finalSubject,
      html: messageHtml(finalMessage),
      attachments: [
        {
          content: String(pdfBase64),
          // Named from the LOADED invoice, so the attachment always names the
          // bill it actually is.
          filename: attachmentName(invoice),
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });

    // Resend answers with { data, error } rather than throwing. That `error`
    // was ignored once, so the route returned 200 and the page cheerfully said
    // "Invoice sent successfully!" for mail that had never left the building.
    if (error) {
      console.error("Resend rejected the message:", error);
      return NextResponse.json(
        { success: false, error: error.message || "The email provider rejected the message." },
        { status: 502 }
      );
    }

    // Recorded only now — after it was accepted. `by` is the session's user.
    const entry = logEntry({
      to: targets.to,
      cc: targets.cc,
      messageId: data?.id,
      by: auth?.name || auth?.email || "",
    });

    // $push rather than a read-modify-write: two people emailing the same bill
    // at once must not lose one of the two rows.
    //
    // A failure HERE is not a failure of the send — the mail has gone. So it
    // is logged and the reply still says sent, with a note that the record did
    // not save. Telling the shop the mail failed would be the worse lie, and
    // they would send it twice.
    let logged = true;
    try {
      await Invoice.updateOne({ invoiceNo: number }, { $push: { emailLog: entry } });
    } catch (logError) {
      logged = false;
      console.error("The invoice was emailed but the send could not be recorded:", logError);
    }

    return NextResponse.json({
      success: true,
      id: data?.id,
      sentTo: targets.to,
      cc: targets.cc,
      logged,
      message: logged
        ? `Emailed to ${targets.to.join(", ")}.`
        : `Emailed to ${targets.to.join(", ")} — but the send could not be recorded against the bill.`,
      entry,
    });
  } catch (error) {
    console.error("Error sending email:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to send email" },
      { status: 500 }
    );
  }
}

// Signed in, permission checked, and every query above scoped to the caller's
// own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
