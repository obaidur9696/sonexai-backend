import '../src/config/env.js';

import mongoose from 'mongoose';

try {
    await mongoose.connect(process.env.MONGODB_URL);

    const users = mongoose.connection.collection('users');
    const result = await users.updateMany(
        { sessions: { $exists: true } },
        { $unset: { sessions: '' } }
    );

    console.log(`Removed the legacy sessions array from ${result.modifiedCount} user(s).`);
} finally {
    await mongoose.disconnect();
}
