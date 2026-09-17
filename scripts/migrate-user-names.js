import '../src/config/env.js';

import mongoose from 'mongoose';

const missingNameFilter = {
    $or: [
        { name: { $exists: false } },
        { name: null },
        { name: '' },
        { name: /^\s+$/ }
    ]
};

const legacyName = {
    $trim: {
        input: {
            $concat: [
                { $ifNull: ['$firstName', ''] },
                ' ',
                { $ifNull: ['$lastName', ''] }
            ]
        }
    }
};

try {
    await mongoose.connect(process.env.MONGODB_URL);
    const users = mongoose.connection.collection('users');

    const migrated = await users.updateMany(
        {
            $and: [
                missingNameFilter,
                {
                    $or: [
                        { firstName: { $exists: true } },
                        { lastName: { $exists: true } }
                    ]
                }
            ]
        },
        [{ $set: { name: legacyName } }]
    );

    const removedLegacyFields = await users.updateMany(
        {
            $and: [
                { name: { $regex: /\S/ } },
                {
                    $or: [
                        { firstName: { $exists: true } },
                        { lastName: { $exists: true } }
                    ]
                }
            ]
        },
        { $unset: { firstName: '', lastName: '' } }
    );

    const unresolved = await users.countDocuments(missingNameFilter);

    console.log(`Migrated ${migrated.modifiedCount} user name(s).`);
    console.log(`Removed legacy name fields from ${removedLegacyFields.modifiedCount} user(s).`);
    if (unresolved > 0) {
        console.warn(`${unresolved} user(s) still have no usable name and retain their legacy fields for manual review.`);
    }
} finally {
    await mongoose.disconnect();
}
