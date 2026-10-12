import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Company from "@/models/companyModel";
import Customer from "@/models/custModel";
import Item from "@/models/itemModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { companyFrom } from "@/lib/company.mjs";
import { sniffImageType } from "@/lib/companyLogo.mjs";
import {
  AUTO_KIND,
  IMPORT_KINDS,
  draftFromExtraction,
  extractionPrompt,
  importIsReady,
  importWarnings,
  newMasters,
  parseExtractionJson,
} from "@/lib/invoiceImport.mjs";
import { tooManyResponse } from "@/lib/rateLimit.mjs";
import { hitRateLimit } from "@/lib/rateLimitStore.mjs";

/**
 * Read a bill off a photograph -- a sale, a purchase, or a return of either.
 *
 *   POST { data, kind }        read the photo, then draft it
 *   POST { extraction, kind }  draft an earlier reading again as another
 *                              kind, WITHOUT reading the photo again: the
 *                              person changed "Purchase" to "Sale" after
 *                              seeing the result, and the model call is the
 *                              slow, paid part
 *
 * `kind` is "auto" (worked out from which side of the bill carries the
 * firm's GSTIN or name) or one of sale, purchase, salereturn,
 * purchasereturn. lib/invoiceImport.mjs `resolveKind`.
 *
 * Returns a DRAFT and a list of things to look at. It writes nothing: the
 * draft goes to the ordinary purchase screen, the person checks it, and the
 * save goes through the same posting path as a hand-typed bill. The note atop
 * lib/invoiceImport.mjs lists the six things the previous import got wrong,
 * five of which put bad data into the books with nobody watching.
 *
 *
 * THE MASTERS ARE MATCHED HERE, NOT IN THE BROWSER
 * -----------------------------------------------
 * Two queries for the whole bill -- the party master and the item master,
 * projected to the columns matching needs -- and then one pure pass over
 * them. Matching in the browser would mean shipping both masters to it, and
 * matching per line in the database would be a query per row: a twenty-line
 * bill as forty round trips.
 *
 *
 * WHAT IS CONFIGURED
 * ------------------
 *   INVOICE_AI_KEY     the model key. Without it this route answers 503 and
 *                      says so, rather than failing somewhere less obvious.
 *   INVOICE_AI_MODEL   which model. Defaulted, overridable without a deploy.
 *   INVOICE_AI_URL     the endpoint, so this can point at a proxy, a
 *                      gateway, or a different provider's compatible API.
 *
 * None of them is NEXT_PUBLIC_, which the old service URL was -- a key that
 * reaches the browser is a key that is published.
 */

// A reading is never a cached reading.
export const dynamic = "force-dynamic";

// Vision calls take ten to thirty seconds on a phone photograph. The default
// on some plans is ten, which would cut off a perfectly good read -- and the
// failure looks like a model that cannot handle the bill.
export const maxDuration = 60;

/**
 * The cap, on the decoded image.
 *
 * 6MB. A phone photograph of a bill is 2-5MB, and the page downscales before
 * uploading anyway -- this is the backstop for a caller that does not.
 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_URL = "https://api.anthropic.com/v1/messages";

/** Decoded base64, or null. Strict: Buffer.from ignores what it cannot parse. */
const decode = (value) => {
  const body = String(value ?? "").trim();
  if (!body) return null;
  const payload = body.includes(",") ? body.slice(body.indexOf(",") + 1) : body;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) return null;
  try {
    const bytes = Buffer.from(payload, "base64");
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
};

/**
 * Ask the model to read the image.
 *
 * Plain `fetch`, so no npm dependency joins the project for this -- the same
 * decision lib/xlsx.mjs took about Excel. Kept in one function so swapping
 * the provider is this function and the three environment variables above.
 */
async function readBill({ bytes, mime }) {
  const key = process.env.INVOICE_AI_KEY || process.env.ANTHROPIC_API_KEY || "";
  if (!key) {
    return {
      error:
        "No model key is configured on the server, so a bill cannot be read yet. Set INVOICE_AI_KEY.",
      status: 503,
    };
  }

  const res = await fetch(process.env.INVOICE_AI_URL || DEFAULT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.INVOICE_AI_MODEL || DEFAULT_MODEL,
      max_tokens: 4096,
      // Zero, because this is transcription. A bill read twice should come
      // back the same twice; a creative temperature is the wrong setting for
      // copying numbers off paper.
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: bytes.toString("base64") } },
            { type: "text", text: extractionPrompt() },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    // The provider's own message is not shown to the shopkeeper -- it names
    // models and quotas and means nothing to them -- but it is logged.
    const detail = await res.text().catch(() => "");
    console.error("Invoice extraction failed:", res.status, detail.slice(0, 500));
    return {
      error:
        res.status === 429
          ? "The reading service is busy. Try again in a moment."
          : "The bill could not be read just now. Try again, or type it in.",
      status: 502,
    };
  }

  const body = await res.json();
  const reply = (body?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");

  const extraction = parseExtractionJson(reply);
  if (!extraction) {
    console.error("Invoice extraction returned no JSON:", reply.slice(0, 500));
    return {
      error:
        "That image could not be read as a bill. A straight-on photo with the whole bill in frame reads best.",
      status: 422,
    };
  }

  return { extraction };
}

/** Far beyond any real bill; keeps a crafted re-draft body bounded. */
const MAX_LINES = 300;

async function handlePOST(req, auth) {
  try {
    const body = await req.json();

    const kind = String(body?.kind ?? AUTO_KIND).trim() || AUTO_KIND;
    if (kind !== AUTO_KIND && !IMPORT_KINDS.includes(kind)) {
      return NextResponse.json(
        { success: false, error: `"${kind}" is not a kind of bill.` },
        { status: 400 }
      );
    }

    // Drafting an earlier reading again: no photo, no model call. The
    // extraction is as untrusted as the model's reply always was, and goes
    // through the same normaliser in draftFromExtraction.
    if (body?.extraction && !body?.data) {
      const extraction = body.extraction;
      if (typeof extraction !== "object" || Array.isArray(extraction)) {
        return NextResponse.json({ success: false, error: "Read the photo again." }, { status: 400 });
      }
      if (Array.isArray(extraction.lines) && extraction.lines.length > MAX_LINES) {
        return NextResponse.json({ success: false, error: "That bill has too many rows." }, { status: 400 });
      }
      return NextResponse.json(await draftResponse({ extraction, kind, auth }));
    }

    const bytes = decode(body?.data);
    if (!bytes) {
      return NextResponse.json(
        { success: false, error: "Choose a photo of the bill." },
        { status: 400 }
      );
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        {
          success: false,
          error: `That image is ${Math.round(bytes.length / (1024 * 1024))}MB. Use one under ${
            MAX_IMAGE_BYTES / (1024 * 1024)
          }MB.`,
        },
        { status: 413 }
      );
    }

    // The TYPE comes from the bytes, not from the filename or the browser's
    // Content-Type -- both are supplied by the caller. The same sniffer the
    // logo upload uses; see lib/companyLogo.mjs for why it is the magic bytes
    // and nothing else.
    const type = sniffImageType(bytes);
    if (!type) {
      return NextResponse.json(
        { success: false, error: "Use a PNG, JPEG or WebP photo of the bill." },
        { status: 400 }
      );
    }

    await connect();

    // Each read is a paid model call on the firm's key. BILL_READ_DAILY_LIMIT
    // (lib/rateLimit.mjs).
    const allowance = await hitRateLimit("bill-read-firm", String(auth?.companyId || ""));
    if (!allowance.allowed) {
      const { status, body: refused, headers } = tooManyResponse(allowance, "bills read today");
      return NextResponse.json(refused, { status, headers });
    }

    const read = await readBill({ bytes, mime: type.mime });
    if (read.error) {
      return NextResponse.json({ success: false, error: read.error }, { status: read.status });
    }

    return NextResponse.json(await draftResponse({ extraction: read.extraction, kind, auth }));
  } catch (error) {
    console.error("Invoice extract error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** The draft, matched against this firm's masters, as the screen takes it. */
async function draftResponse({ extraction, kind, auth }) {
  await connect();

  // Three queries for the whole bill, projected to what matching needs. See
  // the note above about why this is not done per line or in the browser.
  const [parties, items, companyDoc] = await Promise.all([
    Customer.find({}, { name: 1, group: 1, gstIn: 1, state: 1, stateCode: 1, phone: 1 }).lean(),
    Item.find({}, { name: 1, hsn: 1, unit: 1, gst: 1, purchasePrice: 1, salePrice: 1, cost: 1 }).lean(),
    Company.findById(auth.companyId).lean(),
  ]);

  const company = companyFrom(companyDoc);

  const draft = draftFromExtraction({ extraction, parties, items, company, kind });

  return {
    success: true,
    draft,
    warnings: importWarnings(draft),
    ready: importIsReady(draft),
    // What the screen offers to create. Offered -- the existing master
    // routes do the creating, with their own validation.
    newMasters: newMasters(draft),
  };
}

// Signed in, permission checked, and every query above scoped to the caller's
// own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
