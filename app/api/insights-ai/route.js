import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { aiPrompt, cleanFacts, cleanSummary } from "@/lib/hindiInsights.mjs";
import { tooManyResponse } from "@/lib/rateLimit.mjs";
import { hitRateLimit } from "@/lib/rateLimitStore.mjs";

/**
 * The dashboard's optional AI summary, in Hindi.
 *
 *   GET   { available }  -- is a model key configured, so the button is worth
 *                           showing at all
 *   POST  { facts }      -- the dashboard's figures (lib/hindiInsights.mjs
 *                           factsFrom), back as { summary } in Hindi
 *
 * The fixed-sentence insights need none of this and always work; this is the
 * "say it more naturally" button on top.
 *
 * WHAT REACHES THE MODEL
 * ----------------------
 * Only `cleanFacts(body.facts)`: known fields, clamped numbers, one capped
 * party name. Never the body as sent -- otherwise this route is a free
 * general-purpose model on the firm's key for anyone signed in.
 *
 * CONFIGURED BY the same three variables as the bill reader
 * (app/api/invoice-extract/route.js): INVOICE_AI_KEY, INVOICE_AI_URL and
 * INVOICE_AI_MODEL, with INSIGHTS_AI_MODEL to use a different model here.
 * Capped per firm per day by AI_INSIGHTS_DAILY_LIMIT (lib/rateLimit.mjs).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_URL = "https://api.anthropic.com/v1/messages";

const modelKey = () => process.env.INVOICE_AI_KEY || process.env.ANTHROPIC_API_KEY || "";

async function handleGET() {
  return NextResponse.json({ success: true, available: Boolean(modelKey()) });
}

async function handlePOST(req, auth) {
  try {
    const key = modelKey();
    if (!key) {
      return NextResponse.json(
        { success: false, error: "AI summary is not set up on the server. Set INVOICE_AI_KEY." },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => ({}));
    if (!body?.facts || typeof body.facts !== "object") {
      return NextResponse.json({ success: false, error: "No figures were sent." }, { status: 400 });
    }
    const facts = cleanFacts(body.facts);

    await connect();
    const allowance = await hitRateLimit("ai-insights-firm", String(auth?.companyId || ""));
    if (!allowance.allowed) {
      const { status, body: refused, headers } = tooManyResponse(allowance, "AI summaries today");
      return NextResponse.json(refused, { status, headers });
    }

    const res = await fetch(process.env.INVOICE_AI_URL || DEFAULT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.INSIGHTS_AI_MODEL || process.env.INVOICE_AI_MODEL || DEFAULT_MODEL,
        max_tokens: 700,
        // Low: this rewords figures, and the same figures should come back
        // worded much the same way.
        temperature: 0.2,
        messages: [{ role: "user", content: aiPrompt(facts) }],
      }),
    });

    if (!res.ok) {
      // The provider's own words name models and quotas; they are logged,
      // not shown to the shopkeeper.
      const detail = await res.text().catch(() => "");
      console.error("AI insights failed:", res.status, detail.slice(0, 500));
      return NextResponse.json(
        {
          success: false,
          error:
            res.status === 429
              ? "The AI service is busy. Try again in a moment."
              : "The AI summary could not be written just now. The insights above are unaffected.",
        },
        { status: 502 }
      );
    }

    const reply = await res.json();
    const text = (reply?.content || [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join(" ");
    const summary = cleanSummary(text);
    if (!summary) {
      return NextResponse.json(
        { success: false, error: "The AI returned nothing to read out. Try again." },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, summary });
  } catch (error) {
    console.error("AI insights error:", error);
    return NextResponse.json(
      { success: false, error: "The AI summary could not be written just now." },
      { status: 500 }
    );
  }
}

// Signed in, report:read (lib/roles.mjs), scoped to the caller's firm.
export const GET = tenantRoute(handleGET);
export const POST = tenantRoute(handlePOST);
