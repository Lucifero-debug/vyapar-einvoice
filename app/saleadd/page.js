'use client'
import BillingScreen from '@/components/billing/BillingScreen';

export const dynamic = 'force-dynamic';

/**
 * Sale Invoice.
 *
 * The whole screen is components/billing/BillingScreen.jsx, which serves all
 * four billing types. What makes this one a sale invoice is the key below,
 * looked up in lib/billingTypes.mjs: the payload's `type`, the `return` flag,
 * the title, the subtitle, and which side's orders it may bill.
 *
 * The audit that justified collapsing them: saleadd and purchaseadd differed
 * in 8 lines out of 1,547, salereturn and purchasereturn in 6 out of 1,220,
 * and a return screen was the add screen with the order-billing feature
 * deleted. Four files, one behaviour, and four places for a fix to be applied
 * to three of them.
 */
export default function SaleAddPage() {
  return <BillingScreen typeKey='sale' />;
}
