'use client'
import React from 'react';
import { RotateCw } from 'lucide-react';

const ReloadButton = () => {
  return (
    <button
      type="button"
      onClick={() => location.reload()}
      className="btn-icon"
      aria-label="Reload page"
      title="Reload page"
    >
      <RotateCw className="h-[18px] w-[18px]" />
    </button>
  );
};

export default ReloadButton;
