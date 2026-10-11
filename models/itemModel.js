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
   // === The reorder level, for the dashboard's low-stock alerts ===
   //
   // OPTIONAL, and with no default on purpose. An item that has never had
   // one set is left out of the "below minimum" alert rather than compared
   // against an invented number: a wholesaler's minimum for steel plate is
   // not a shop's for washers, and a made-up default would fill the alert
   // list with items nobody asked about. Such an item is still reported when
   // its stock has run out or gone negative, which needs no threshold.
   //
   // Declared here because Mongoose strict mode drops what is not -- and a
   // dropped threshold is an alert that silently never fires.
   minQuantity:{
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