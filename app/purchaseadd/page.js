'use client'
import BillingScreen from '@/components/billing/BillingScreen';

export const dynamic = 'force-dynamic';

/**
 * Purchase Invoice.
 *
 * The whole screen is components/billing/BillingScreen.jsx, which serves all
 * four billing types. What makes this one a Purchase Invoice is the key below,
 * looked up in lib/billingTypes.mjs: the payload's `type`, the `return` flag,
 * the title, the subtitle, and which side's orders it may bill.
 *
 * A purchase may be billed from a purchase order, so the order strip appears here as it does on a sale. The server derives the signs -- party credited, stock received -- from `type` and `return`.
 *
 * WHAT THIS PAGE USED TO BE. A ~73 KB copy of the sale screen, last touched
 * before the consolidation and therefore missing everything added since. The
 * audit before replacing it compared its state, its functions and its imports
 * against BillingScreen's and found NOTHING unique to it -- it was a strict
 * subset. So the migration loses nothing, and it gains what the copy had
 * drifted away from.
 */
export default function PurchaseAddPage() {
  return <BillingScreen typeKey='purchase' />;
}
