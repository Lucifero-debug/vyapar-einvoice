import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";
import { type } from "os";


const customerSchema = new mongoose.Schema({
    name:{
        type:String,
    },
    short:{
        type:String
    },
    email:{
        type:String,
    },
   group:{
    type:String,
   }, 
   address:{
    type:String,
   }, 
   city:{
    type:String,
   }, 
   state:{
    type:String,
   }, 
   // A postal code is an identifier, not a quantity -- same reasoning as
   // `phone` below. Indian PINs begin 1-8 so none has been truncated, but
   // arithmetic on it is meaningless and a non-numeric postcode cannot be
   // stored at all while it is a Number.
   pincode:{
    type:String,
    trim:true,
   }, 
   // A phone number is an identifier, not a quantity. Stored as a Number it
   // dropped a leading zero, could not hold "+91", a space, a dash or a second
   // number after a comma, and disagreed with Invoice.customer.phone, which
   // has always been a String.
   phone:{
    type:String,
    trim:true,
   }, 
   stateCode:{
    type:String,
   }, 
   bank:{
    type:String,
   }, 
   pan:{
type:String,
   },
   discount:{
    type:Number,
   }, 
   interest:{
    type:Number,
   }, 
   state:{
    type:String,
   }, 
   aadhar:{
    type:String,
   }, 
   gstIn:{
    type:String,
   }, 
   // Balances are SIGNED: > 0 means Dr (party owes us), < 0 means Cr (we owe
   // the party). The `*Mode` fields are a denormalised cache of that sign for
   // display; they are never an independent input. Always go through
   // lib/balance.js so the two cannot drift apart.
   openingBal:{
    type:Number,
    default:0
   },
   openingMode:{
    type:String
   },
   // SYSTEM-OWNED. The live running balance, maintained by every invoice and
   // voucher posting via lib/balance.mjs. The customer form must never write
   // it: it used to, which meant editing a phone number silently rewrote the
   // balance with whatever the form had loaded.
   lastBal:{
    type:Number,
    default:0
   },
   lastMode:{
    type:String
   },
   // USER-OWNED. Last year's closing balance, kept as reference master data.
   // This is what the form's "Last Year Balance" field edits; it has no effect
   // on the running balance.
   lastYearBal:{
    type:Number,
    default:0
   },
   lastYearMode:{
    type:String
   },
   dealerType:{
    type:String
   },
   discount:{
    type:Number
   }
})


// Parties are looked up by name on every posting, and by group whenever an
// invoice needs its cash or bank account.
//
// NOTE: deliberately NOT unique. Adding a unique index to a collection that
// already holds duplicates fails silently at build time and leaves you
// thinking you are protected. Duplicates are refused in `customer-add` and
// `customer-alter` instead. To make it unique for real: de-duplicate first,
// then change this line to { unique: true }.
customerSchema.index({ name: 1 });
customerSchema.index({ group: 1 });

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
customerSchema.plugin(tenantPlugin);

const Customer= mongoose.models.customers || mongoose.model("customers",customerSchema)

export default Customer