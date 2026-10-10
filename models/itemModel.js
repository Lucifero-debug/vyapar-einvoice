import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";
import { UQC_DEFAULT } from "../lib/uqc.mjs";
import { type } from "os";


const itemSchema = new mongoose.Schema({
    name:{
        type:String,
        required:[true,"Please provide a username"],
    },
    hsn:{
        type:String,
        required:[true,"Please provide a Hsn code"],
    },
    short:{
        type:String
    },
   group:{
    type:String,
   }, 
   mrp:{
    type:Number,
   }, 
   cost:{
    type:Number,
   }, 
   unit:{
    type:String,
   }, 
   salePrice:{
    type:Number,
   }, 
   discount:{
    type:Number,
   }, 
   weight:{
    type:Number,
   }, 
   itemType:{
    type:String,
   }, 
   purchasePrice:{
    type:Number
   },
   gst:{
    type:Number
   },
   openingQuantity:{
    type:Number
   },
   lastQuantity:{
    type:Number
   },
   // === E-invoicing ===
   //
   // `unit` above is free text -- what the shop calls it, and what the stock
   // report prints. `uqc` is the code the IRP accepts, which is a different
   // thing and deliberately not guessed from it: see lib/uqc.mjs. OTH is a
   // real code meaning "others", so the default is always valid.
   uqc:{
    type:String,
    default:UQC_DEFAULT,
    trim:true,
    uppercase:true,
   },
   // Becomes IsServc "Y" or "N" on each e-invoice line.
   isService:{
    type:Boolean,
    default:false,
   }
})


// Same reasoning as custModel: joined by name everywhere, kept non-unique
// until existing data is known to be clean. `item-add` refuses duplicates.
itemSchema.index({ name: 1 });
itemSchema.index({ hsn: 1 });

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
itemSchema.plugin(tenantPlugin);

const Item= mongoose.models.items || mongoose.model("items",itemSchema)

export default Item