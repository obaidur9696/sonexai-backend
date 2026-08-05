import mongoose from "mongoose";

const connectDB = async () => {
    console.log(process.env.MONGODB_URI)
    try {
        const connectionInstance = await mongoose.connect(process.env.MONGODB_URI)
        
        console.log(`✅ MongoDB connected successfully!`);
       
        
    } catch (error) {
        console.log("❌ MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

export default connectDB;