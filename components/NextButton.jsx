'use client'
import { useRouter } from 'next/navigation';
import React from 'react';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';

const NextButton = () => {
  const router = useRouter();

  return (
    <button onClick={() => router.next()}>
      <ArrowForwardIcon sx={{ fontSize: '40px' }} />
    </button>
  );
};

export default NextButton;
