import mongoose, { Schema } from "mongoose";

const sessionSchema = new Schema(
    {
        sessionId: {
            type: String,
            required: true,
            unique: true
        },
        sessionType: {
            type: String,
            enum: ['anonymous', 'authenticated'],
            required: true
        },
        title: {
            type: String,
            default: 'New Conversation'
        },
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        deviceFingerprint: {
            type: String,
            default: null
        },
        status: {
            type: String,
            enum: ['created', 'active', 'ended', 'expired'],
            default: 'created'
        },
        endedAt: {
            type: Date
        },
        totalTalkTimeSeconds: {
            type: Number,
            default: 0
        },
        preferences: {
            language: String,
            topic: String,
            name: String,
            conversationDepth: {
                type: String,
                enum: ['concise', 'balanced', 'comprehensive']
            },
            voiceAccent: String,
            sensitivity: Number
        },
        messages: [{
            sender: {
                type: String,
                enum: ['user', 'bot']
            },
            text: String,
            timestamp: {
                type: Date,
                default: Date.now
            }
        }],
        // In session.models.js
        tokenUsage: {
            input_tokens: { type: Number, default: 0 },
            output_tokens: { type: Number, default: 0 },
            total_tokens: { type: Number, default: 0 }
        },
        // Add to session.models.js
        insights: {
            schemaVersion: { type: Number, default: 1 },
            generatedBy: { type: String, default: 'gpt-4o-mini' },
            generatedAt: { type: Date },

            analysisStatus: {
                completed: { type: Boolean, default: false },
                reason: { type: String }
            },

            conversationTitle: {
                status: { type: Boolean, default: false },
                value: { type: String }
            },

            summary: {
                status: { type: Boolean, default: false },
                value: { type: String }
            },

            languages: {
                status: { type: Boolean, default: false },
                primary: { type: String },
                detected: { type: [String] }
            },

            scoreRanges: [{
                level: { type: String },
                minScore: { type: Number },
                maxScore: { type: Number }
            }],

            communicationSkill: {
                status: { type: Boolean, default: false },
                score: { type: Number },
                level: { type: String },
                feedback: { type: String }
            },

            engagement: {
                status: { type: Boolean, default: false },
                score: { type: Number },
                level: { type: String },
                feedback: { type: String }
            },

            grammar: {
                status: { type: Boolean, default: false },
                score: { type: Number },
                level: { type: String },
                feedback: { type: String }
            },

            strengths: {
                status: { type: Boolean, default: false },
                items: { type: [String] }
            },

            improvements: {
                status: { type: Boolean, default: false },
                items: { type: [String] }
            },

            assistantPerformance: {
                status: { type: Boolean, default: false },
                score: { type: Number },
                level: { type: String },
                feedback: { type: String }
            },

            overallConversation: {
                status: { type: Boolean, default: false },
                score: { type: Number },
                level: { type: String },
                feedback: { type: String }
            }
        },
        totalMessages: {
            type: Number,
            default: 0
        },
        totalWords: {
            type: Number,
            default: 0
        }
    },
    {
        timestamps: true,
        strict: false   // ✅ Allows adding any field later without error
    }
);

// A user's session history is owned by this collection. This supports the
// authenticated-session list without storing an ever-growing copy of IDs on
// the User document.
sessionSchema.index({ userId: 1, sessionType: 1, status: 1, createdAt: -1 });

export const Session = mongoose.model("Session", sessionSchema);
