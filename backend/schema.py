from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional
from datetime import datetime

class ItemSchema(BaseModel):
    name: str
    quantity: float
    cost: float
    discount: float
    total: float
    description: Optional[str] = None
    hsn: Optional[str] = None
    gstRate: Optional[float] = None
    taxableAmount: Optional[float] = None

class PartyTaxSchema(BaseModel):
    name: str
    rate: Optional[float] = None
    Amount: Optional[float] = None
    total: float

class CustomerSchema(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[EmailStr] = None
    custId: Optional[str] = None

class HSNTotalSchema(BaseModel):
    hsn: str
    amount: float

class NameOnlySchema(BaseModel):
    name: Optional[str] = None

class InvoiceSchema(BaseModel):
    # Required Fields
    invoiceNo: int
    date: datetime
    customer: CustomerSchema
    totalAmount: float
    finalAmount: float
    received: float
    balanceDue: float
    type: str="Purchase"
    
    againstInvoiceNo: Optional[int] = None
    hsnTotals: List[HSNTotalSchema] = []
    paymentType: Optional[str] = None
    stateOfSupply: Optional[str] = None
    taxType: Optional[str] = None
    gst: Optional[float] = None
    
    dispatchfrom: Optional[NameOnlySchema] = None
    billedTo: Optional[NameOnlySchema] = None
    
    items: List[ItemSchema] = []
    partyTaxes: List[PartyTaxSchema] = []
    
    transport: Optional[str] = None
    grNo: Optional[str] = None
    grDate: Optional[datetime] = None
    orderDate: Optional[datetime] = None
    pvtMark: Optional[str] = None
    caseDetails: Optional[str] = None
    freight: Optional[str] = None
    weight: Optional[float] = None
    orderNo: Optional[int] = None
    ewayBillNo: Optional[str] = None
    ewayBillDate: Optional[datetime] = None
    
    return_status: bool = Field(default=False, alias="return")

    class Config:
        populate_by_name = True  # Allows using 'return' in JSON while using 'return_status' in Python