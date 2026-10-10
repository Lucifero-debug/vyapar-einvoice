import mongoose from 'mongoose'

const totalSaleSchema = new mongoose.Schema({
    value: {
        type: Number,
        required: true,
        default: 0,
    },
        customer: {
      name: { type: String, required: true },
      phone: { type: String },
      email: { type: String },
        }
})

export default mongoose.models.TotalSale || mongoose.model('TotalSale', totalSaleSchema);
