// context/SaleOptionContext.js
'use client'
import React, { createContext, useContext, useEffect, useState } from 'react';

const SaleOptionContext = createContext();

export const SaleOptionProvider = ({ children }) => {
  const [options, setOptions] = useState({
    description: false,
    shipped: false,
    dispatch: false,
     calculateByPack: false,
      rollStationary: false, 
    usePriceList: true,
  });

  useEffect(() => {
    const storedOptions = localStorage.getItem('saleOptions');
    if (storedOptions) {
      // Merge so options added since this browser last saved keep their default
      setOptions((prev) => ({ ...prev, ...JSON.parse(storedOptions) }));
    }
  }, []);

  // Save to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('saleOptions', JSON.stringify(options));
  }, [options]);

  return (
    <SaleOptionContext.Provider value={{ options, setOptions }}>
      {children}
    </SaleOptionContext.Provider>
  );
};

export const useSaleOptions = () => useContext(SaleOptionContext);
