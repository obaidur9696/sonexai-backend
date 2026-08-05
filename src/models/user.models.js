import mongoose, { Schema } from "mongoose";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const userSchema = new Schema(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },
        password: {
            type: String,
            required: [true, "Password is required"],
            minlength: 6,
            select: false
        },
        firstName: {
            type: String,
            required: true,
            trim: true
        },
        lastName: {
            type: String,
            required: true,
            trim: true
        },
        gender: {
            type: String,
            enum: ['male', 'female', 'other', 'prefer-not'],
            default: 'prefer-not'
        },
        age: {
            type: Number,
            min: 13,
            max: 100
        },
        refreshToken: {
            type: String,
            select: false
        },
        // Tracking fields
        totalTalkTimeSeconds: {
            type: Number,
            default: 0
        },
        totalSessions: {
            type: Number,
            default: 0
        },
        sessions: [{
            type: Schema.Types.ObjectId,
            ref: 'Session'
        }]
    },
    {
        timestamps: true
    }
);

// Hash password before saving
userSchema.pre("save", async function () {
    if (!this.isModified("password")) return;

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
userSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
};

// Generate access token
userSchema.methods.generateAccessToken = function () {
    const payload = {
        _id: this._id,
        email: this.email,
        firstName: this.firstName,
        lastName: this.lastName
    };

    return jwt.sign(
        payload,
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '15m' }
    );
};

// Generate refresh token
userSchema.methods.generateRefreshToken = function () {
    const payload = {
        _id: this._id
    };

    return jwt.sign(
        payload,
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '7d' }
    );
};

export const User = mongoose.model("User", userSchema);