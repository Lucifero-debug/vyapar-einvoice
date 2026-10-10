"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

// The invoice-image extraction service (backend/app.py). Hard-coding the
// deploy URL meant a local backend could never be used and a redeploy to a new
// host silently broke the import. Set NEXT_PUBLIC_AI_IMPORT_URL to override.
const AI_IMPORT_URL =
  process.env.NEXT_PUBLIC_AI_IMPORT_URL || "https://vyapaar-4.onrender.com";

export default function Home() {

  const [file, setFile] = useState(null)
  const [response, setResponse] = useState("")
  const [loading, setLoading] = useState(false)
    const router = useRouter()

const handleUpload = async () => {
  if (!file) return;
  setLoading(true);

  const formData = new FormData();
  formData.append("file", file);

  try {
    // 1. Get structured data from FastAPI
    const res = await fetch(`${AI_IMPORT_URL}/start`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error("AI Extraction failed");
    const aiInvoice = await res.json();

    // 2. Formatting Numbers (Sanitizer to prevent NaN)
    const toNum = (val) => {
      const n = parseFloat(val);
      return isNaN(n) ? 0 : n;
    };

    // 3. Replicate hsnTotalsArray logic from your manual code
    // AI returns a list, but we ensure it matches your Mongoose schema structure
    const hsnTotalsArray = (aiInvoice.hsnTotals || []).map(h => ({
      hsn: h.hsn || "N/A",
      gstRate: toNum(h.gstRate),
      amount: toNum(h.amount),
      total: toNum(h.total)
    }));

    // 4. Construct invoiceData exactly like submitInvoice
    const invoiceData = {
      invoiceNo: parseInt(aiInvoice.invoiceNo),
      date: aiInvoice.date ? aiInvoice.date.split("T")[0] : new Date().toISOString().substring(0, 10),
      customer: {
        name: aiInvoice.customer?.name || "Unknown",
        phone: aiInvoice.customer?.phone || "",
        email: aiInvoice.customer?.email || "",
        custId: aiInvoice.customer?.custId || ""
      },
      return: false,
      paymentType: aiInvoice.paymentType || "Cash",
      balanceDue: toNum(aiInvoice.balanceDue),
      stateOfSupply: aiInvoice.stateOfSupply || "Delhi",
      taxType: aiInvoice.taxType || "local",
      gst: toNum(aiInvoice.gst),
      totalAmount: toNum(aiInvoice.totalAmount),
      finalAmount: toNum(aiInvoice.finalAmount),
      received: toNum(aiInvoice.received) || 0,
      items: aiInvoice.items || [],
      partyTaxes: aiInvoice.partyTaxes || [],
      type: "Purchase",
      hsnTotals: hsnTotalsArray,
      // Optional fields
      transport: aiInvoice.transport || "",
      grNo: aiInvoice.grNo || "",
      grDate: aiInvoice.grDate || "",
      ewayBillNo: aiInvoice.ewayBillNo || "",
      orderNo: aiInvoice.orderNo || "",
      source:"upload"
    };

    // 5. Send to your Next.js API
    const saveRes = await fetch('/api/save-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invoiceData),
    });

    const result = await saveRes.json();

    if (result.success) {
      // 6. Navigate to Invoice view page with URL params (Matches your query logic)
      const encodedItems = encodeURIComponent(JSON.stringify(invoiceData.items));
      const encodedParty = encodeURIComponent(JSON.stringify(invoiceData.partyTaxes));
      const encodedHsnTotals = encodeURIComponent(JSON.stringify(aiInvoice.hsnTotals));

      const query = new URLSearchParams({
        invoiceNo: invoiceData.invoiceNo,
        date: invoiceData.date,
        customer: invoiceData.customer.name,
        phone: invoiceData.customer.phone,
        totalAmount: invoiceData.totalAmount,
        finalAmount: invoiceData.finalAmount,
        received: invoiceData.received,
        balanceDue: invoiceData.balanceDue,
        items: encodedItems,
        partyTaxes: encodedParty,
        hsnTotals: encodedHsnTotals,
        type: "Purchase"
      }).toString();

      alert("Invoice processed and saved successfully! 🚀");
      router.push(`/invoice?${query}`);
    } else {
      alert('Failed to save invoice: ' + result.error);
    }

  } catch (error) {
    console.error("AI Upload error:", error);
    alert("Error: " + error.message);
  } finally {
    setLoading(false);
  }
};

  return (
    <main className="page-shell flex max-w-lg flex-col justify-center">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">Invoice AI Analyzer</h1>
        </div>

        <div className="panel-body space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a photo of a purchase bill and it will be read and saved for you.
          </p>

          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-6 py-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/40">
            <span className="text-sm font-medium text-foreground">
              {file ? file.name : "Choose an image"}
            </span>
            <span className="text-xs text-muted-foreground">PNG or JPG of the bill</span>
            <input
              type="file"
              accept="image/*"
              onChange={(e)=>setFile(e.target?.files?.[0] || null)}
              className="sr-only"
            />
          </label>

          <button
            onClick={handleUpload}
            disabled={!file || loading}
            className="btn btn-primary w-full"
          >
            {loading ? "Analyzing..." : "Upload Invoice"}
          </button>

          {response && (
            <div className="rounded-lg border border-border bg-muted/50 p-4 text-sm text-foreground">
              {response}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}