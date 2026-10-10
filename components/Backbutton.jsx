'use client'
import { useRouter } from 'next/navigation';
import React from 'react'
import { ArrowLeft } from 'lucide-react';

const Backbutton = () => {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.back()}
      className="btn-icon"
      aria-label="Go back"
      title="Go back"
    >
      <ArrowLeft className="h-5 w-5" />
    </button>
  )
}

export default Backbutton
