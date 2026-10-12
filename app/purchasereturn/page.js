'use client'
import BillingScreen from '@/components/billing/BillingScreen';

export const dynamic = 'force-dynamic';

/**
 * Purchase Return.
 *
 * The whole screen is components/billing/BillingScreen.jsx, which serves all
 * four billing types. What makes this one a Purchase Return is the key below,
 * looked up in lib/billingTypes.mjs: the payload's `type`, the `return` flag,
 * the title, the subtitle, and which side's orders it may bill.
 *
 * A return bills from no order: `orderDoc` is null for both return types. The server derives the signs -- party debited, stock issued -- from `type` and `return` through lib/invoicePosting.mjs.
 *
 * WHAT THIS PAGE USED TO BE. A ~55 KB copy of the sale screen, last touched
 * before the consolidation and therefore missing everything added since. The
 * audit before replacing it compared its state, its functions and its imports
 * against BillingScreen's and found NOTHING unique to it -- it was a strict
 * subset. So the migration loses nothing, and it gains what the copy had
 * drifted away from.
 */
export default function PurchaseReturnPage() {
  return <BillingScreen typeKey='purchasereturn' />;
}
