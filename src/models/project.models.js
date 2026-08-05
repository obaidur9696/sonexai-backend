import mongoose, { Schema } from "mongoose";

const projectSchema = new Schema({
    corporate: {
        type: String,
        required: true,
        unique: true
    },
    corporate_name: String,

    webrtc: [{
        number: String,
        provider: {
            type: String,
            default: "webRTC"
        },
        timerConfig: {
            enabled: { type: Boolean, default: true },
            maxDurationMinutes: {
                authenticated: { type: Number, default: 15 },
                anonymous: { type: Number, default: 5 }
            },
            warningRemainingMinutes: { type: Number, default: 3 },
            dangerRemainingMinutes: { type: Number, default: 1 }
        }
    }],

    // New fields added
    discussionDepth: {
        type: String,
        enum: ['concise', 'balanced', 'comprehensive'],
        default: 'balanced'
    },

    sensitivityPresets: [{
        value: { type: Number, required: true },
        label: { type: String, required: true }
    }],

    sensitivityRange: {
        min: { type: Number, default: 0.0 },
        max: { type: Number, default: 1.0 },
        step: { type: Number, default: 0.05 },
        default: { type: Number, default: 0.7 }
    },

    languages: [{
        value: { type: String, required: true },
        label: { type: String, required: true },
        countryCode: { type: String, required: true }
    }],

    topics: [{
        value: { type: String, required: true },
        label: { type: String, required: true }
    }],
    
    voiceAccents: [{
        value: { type: String, required: true },
        label: { type: String, required: true }
    }]

}, {
    timestamps: true,
    strict: false   // ✅ Allows adding any field later without error
});

export const Project = mongoose.model("Project", projectSchema);