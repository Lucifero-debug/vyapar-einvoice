'use client'

import { useEffect } from 'react'

const ClearLocalStorageOnLeave = () => {
  useEffect(() => {
    const handleBeforeUnload = () => {
      const keysToRemove = [
        'invoiceItems',
        'invoiceNo',
        'date',
        'gst',
        'paymentType',
        'stateOfSupply',
        'taxType',
        'selectedCustomer',
        'partyTaxes',
        'received'
      ]

      keysToRemove.forEach(key => localStorage.removeItem(key))
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  return null
}

export default ClearLocalStorageOnLeave
