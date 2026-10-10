import { Resend } from "resend";
import { NextResponse } from "next/server";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Email an invoice PDF to the party it was raised against.
 *
 * `INVOICE_FROM_EMAIL` must be an address on a domain verified with Resend.
 * Until one is set this falls back to Resend's shared sandbox sender, which
 * only delivers to the account owner's own address — fine for a demo, useless
 * for a real customer.
 */
/**
 * Who the mail is from. Built per request, not once at import: the name is the
 * signed-in firm's, and this instance serves more than one firm.
 */
const senderFor = (firmName) => {
  const name = String(firmName || "").trim() || "Vyapaar";
  const address = process.env.INVOICE_FROM_EMAIL || "onboarding@resend.dev";
  return `${name} <${address}>`;
};

const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

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

    const { toEmail, subject, htmlContent, pdfBase64, fileName } = await req.json();

    if (!looksLikeEmail(toEmail)) {
      return NextResponse.json(
        { success: false, error: "No valid recipient email address." },
        { status: 400 }
      );
    }
    if (!pdfBase64) {
      return NextResponse.json(
        { success: false, error: "No invoice PDF to attach." },
        { status: 400 }
      );
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    // requireAuth() already read the firm's record to check it is active, so
    // its name is on `auth` and costs nothing here.
    const firmName = auth?.company?.name;

    const { data, error } = await resend.emails.send({
      from: senderFor(firmName),
      to: toEmail,
      subject: subject || `Invoice from ${firmName || "us"}`,
      html: htmlContent || "<p>Please find your invoice attached.</p>",
      attachments: [
        {
          content: pdfBase64,
          filename: fileName || "invoice.pdf",
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });

    // Resend answers with { data, error } rather than throwing. That `error`
    // was ignored, so the route returned 200 and the page cheerfully said
    // "Invoice sent successfully!" for mail that had never left the building.
    if (error) {
      console.error("Resend rejected the message:", error);
      return NextResponse.json(
        { success: false, error: error.message || "The email provider rejected the message." },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, id: data?.id, message: "Email sent successfully" });
  } catch (error) {
    console.error("Error sending email:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to send email" },
      { status: 500 }
    );
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
