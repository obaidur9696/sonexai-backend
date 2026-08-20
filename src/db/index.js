import mongoose from "mongoose";
import logger from '../utils/Logger.js';

const connectDB = async () => {
    try {
        const connectionInstance = await mongoose.connect(process.env.MONGODB_URL)
         console.log(`✅ MongoDB connected successfully!`);
       
        logger?.info(`[Database] MongoDB connected successfully to ${connectionInstance.connection.host}`);
        logger?.debug(`[Database] Connection details:`, {
            host: connectionInstance.connection.host,
            port: connectionInstance.connection.port,
            name: connectionInstance.connection.name
        });
        
    } catch (error) {
        logger?.error('[Database] MongoDB connection failed:', {
            error: error.message,
            stack: error.stack
        });
        console.log("❌ Service temporarily unavailable. Please try again later.");
        process.exit(1);
    }
}

export default connectDB;