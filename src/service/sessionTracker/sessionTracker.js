import { Session } from '../../models/session.models.js';
import { User } from '../../models/user.models.js';
import { Project } from '../../models/project.models.js';
import { v4 as uuidv4 } from 'uuid';


const OPENAI_MODEL = 'gpt-4o-mini';
const MIN_USER_WORDS = 30; // Minimum user words required for analysis

class SessionTracker {
    constructor({ preferences, basePhoneCall, logger }) {
        this.sessionId = uuidv4()
        this.preferences = preferences;
        this.basePhoneCall = basePhoneCall;
        this.logger = logger;
        this.sessionDoc = null; // contain mongoose document of the session
        this.sessionData = {}; // plain json object of the session data
    }


    async initialize() {
        try {
            // Fetch project config
            const project = await Project.findOne({ corporate: "A2plus" });
            // Find the specific WebRTC config by webrtcId
            const webrtcConfig = project?.webrtc?.find(
                config => config.webrtcId === "webrtc_talk"
            );

            const projectConfig = { silencePeriod: webrtcConfig?.silencePeriod };
            const timerConfig = webrtcConfig?.timerConfig || {};

            const minUserWordsForAnalysis = webrtcConfig?.minUserWordsForAnalysis || 30;
            this.sessionData.minUserWordsForAnalysis = minUserWordsForAnalysis;

            const { userId, deviceFingerprint } = this.preferences;
            let sessionType = 'anonymous';
            let validUserId = null;
            let maxDurationSeconds = (timerConfig.maxDurationMinutes?.anonymous || 5) * 60;
            let warningThresholdSeconds = (timerConfig.warningRemainingMinutes?.anonymous || 3) * 60;
            let dangerThresholdSeconds = (timerConfig.dangerRemainingMinutes?.anonymous || 1) * 60;

            // Step 1: Validate userId if present
            if (userId) {
                const user = await User.findById(userId);
                if (!user) {
                    this.logger.warn('Invalid user ID provided in session preferences', { userId });
                    this.basePhoneCall.sendError(this.sessionId, 'Invalid user ID. Please login again.');
                    return null;
                }
                sessionType = 'authenticated';
                validUserId = user._id;
                maxDurationSeconds = (timerConfig.maxDurationMinutes?.authenticated || 15) * 60;
                warningThresholdSeconds = (timerConfig.warningRemainingMinutes?.authenticated || 3) * 60;
                dangerThresholdSeconds = (timerConfig.dangerRemainingMinutes?.authenticated || 1) * 60;
            }
            // Step 2: Anonymous user - check time limit
            else if (deviceFingerprint) {
                const anonymousSessions = await Session.find({
                    deviceFingerprint: deviceFingerprint,
                    sessionType: 'anonymous',
                    status: 'ended'
                });

                let totalTalkTimeSeconds = 0;
                for (const sess of anonymousSessions) {
                    totalTalkTimeSeconds += sess.totalTalkTimeSeconds || 0;
                }

                if (totalTalkTimeSeconds >= maxDurationSeconds) {
                    this.logger.info('Free trial limit reached', { deviceFingerprint, totalTalkTimeSeconds });
                    this.basePhoneCall.sendError(
                        this.sessionId,
                        `Free trial limit reached (${maxDurationSeconds / 60} minutes). Please login to continue.`
                    );
                    return null;
                }
                this.sessionData.remainingTrialSeconds = maxDurationSeconds - totalTalkTimeSeconds;
            }
            // Step 3: No userId and no deviceFingerprint - cannot proceed
            else {
                this.logger.warn('Session initialization failed: No user ID or device fingerprint provided', {
                    userId,
                    deviceFingerprint
                });
                this.basePhoneCall.sendError(
                    this.sessionId,
                    'Unable to start session. Please login to access the service or ensure your device is properly recognized.'
                );
                return null;
            }

            // Step 4: Check if session already exists
            let session = await Session.findOne({ sessionId: this.sessionId });

            // Step 5: Create new session if not exists
            if (!session) {
                session = new Session({
                    sessionId: this.sessionId,
                    sessionType: sessionType,
                    title: this.preferences?.topic || "New Conversation",
                    userId: validUserId,
                    deviceFingerprint: deviceFingerprint || null,
                    status: 'created',
                    endedAt: null,
                    totalTalkTimeSeconds: 0,
                    maxDurationSeconds: maxDurationSeconds,
                    warningThresholdSeconds: warningThresholdSeconds,
                    dangerThresholdSeconds: dangerThresholdSeconds,
                    ...(sessionType === 'anonymous' && {
                        remainingTrialSeconds: this.sessionData.remainingTrialSeconds
                    }),
                    preferences: {
                        language: this.preferences.language,
                        topic: this.preferences.topic,
                        discussionDepth: this.preferences.discussionDepth,
                        voiceAccent: this.preferences.voiceAccent,
                        sensitivity: this.preferences.sensitivity
                    },
                    messages: [],
                    tokenUsage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        total_tokens: 0
                    }
                });
                await session.save();
            }

            this.sessionDoc = session;
            return { session, projectConfig };

        } catch (error) {
            this.logger.error('[SessionTracker] Initialize error', { error: error.message });
            this.basePhoneCall.sendError(this.sessionId, 'Session initialization failed. You can try again.');
            return null;
        }
    }

    async activate() {
        try {
            if (!this.sessionDoc) {
                this.sessionDoc = await Session.findOne({ sessionId: this.sessionId });
            }

            if (this.sessionDoc && this.sessionDoc.status === 'created') {
                this.sessionDoc.status = 'active';
                await this.sessionDoc.save();
                this.logger.info(`[SessionTracker] Session activated: ${this.sessionId}`);
            }
        } catch (error) {
            this.logger.error(`[SessionTracker] Activate error:`, error.message);
        }
    }

    async recordMessage(sender, text) {
        try {
            if (!this.sessionDoc) {
                this.sessionDoc = await Session.findOne({ sessionId: this.sessionId });
            }

            if (this.sessionDoc && this.sessionDoc.status === 'active') {
                this.sessionDoc.messages.push({
                    sender: sender,
                    text: text,
                    timestamp: new Date()
                });
                await this.sessionDoc.save();
                this.logger.debug(`[SessionTracker] Message saved: ${sender} -> ${text}`);
            }
        } catch (error) {
            this.logger.error(`[SessionTracker] Record message error:`, error.message);
        }
    }

    /**
 * Update token usage in session document
 * @param {Object} tokenUsage - { input_tokens, output_tokens, total_tokens }
 */
    async updateTokenUsage(tokenUsage) {
        try {
            if (!this.sessionDoc) {
                this.sessionDoc = await Session.findOne({ sessionId: this.sessionId });
            }

            if (!this.sessionDoc) return;

            // Initialize tokenUsage if not exists
            if (!this.sessionDoc.tokenUsage) {
                this.sessionDoc.tokenUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0
                };
            }

            // Add new token usage to existing
            this.sessionDoc.tokenUsage.input_tokens += tokenUsage.input_tokens || 0;
            this.sessionDoc.tokenUsage.output_tokens += tokenUsage.output_tokens || 0;
            this.sessionDoc.tokenUsage.total_tokens += tokenUsage.total_tokens || 0;

            await this.sessionDoc.save();

            this.logger.info(
                `[SessionTracker] Token usage updated for session ${this.sessionId}: ` +
                `Input: ${tokenUsage.input_tokens || 0}, Output: ${tokenUsage.output_tokens || 0}, Total: ${tokenUsage.total_tokens || 0}`
            );
        } catch (error) {
            this.logger.error(`[SessionTracker] Update token usage error:`, error.message);
        }
    }

    async finalize() {
        try {
            if (!this.sessionDoc) {
                this.sessionDoc = await Session.findOne({ sessionId: this.sessionId });
            }
            if (this.sessionDoc.status === 'ended') {
                this.logger.warn(`Session ${this.sessionId} already ended`);
                return;
            }

            const minUserWords = this.sessionData.minUserWordsForAnalysis || 30;
            const eligibility = await this._shouldAnalyzeConversation(
                this.sessionDoc.messages,
                minUserWords
            );
            this.sessionDoc.totalMessages = eligibility.statistics.totalMessages || 0;
            this.sessionDoc.totalWords = eligibility.statistics.totalWords || 0;

            if (!eligibility.shouldAnalyze) {
                // Save default insights with reason
                this.sessionDoc.insights = {
                    schemaVersion: 1,
                    generatedBy: OPENAI_MODEL,
                    generatedAt: new Date(),
                    analysisStatus: {
                        completed: false,
                        reason: eligibility.reason
                    }
                };
                if (!this.sessionDoc.title || this.sessionDoc.title === 'New Conversation') {
                    this.sessionDoc.title = this.sessionDoc.preferences?.topic || 'New Conversation';
                }
                await this.sessionDoc.save();
                this.logger.info(`[SessionTracker] Session ended without analysis: ${eligibility.reason}`);
            } else {
                // ✅ Generate insights (await)
                await this._generateConversationInsights(this.sessionDoc);
                if (this.sessionDoc.insights?.conversationTitle?.value) {
                    this.sessionDoc.title = this.sessionDoc.insights.conversationTitle.value;
                } else {
                    this.sessionDoc.title = this.sessionDoc.preferences?.topic || 'New Conversation';
                }
                await this.sessionDoc.save();
                this.logger.info(`[SessionTracker] Session ended with insights: ${this.sessionId}`);
            }

            if (this.sessionDoc && this.sessionDoc.status === 'active') {
                this.sessionDoc.status = 'ended';
                this.sessionDoc.endedAt = new Date();

                // Calculate total talk time in seconds
                const startTime = this.sessionDoc.createdAt;
                const endTime = this.sessionDoc.endedAt;
                const sessionTalkTimeSeconds = Math.floor((endTime - startTime) / 1000);
                this.sessionDoc.totalTalkTimeSeconds = sessionTalkTimeSeconds;

                await this.sessionDoc.save();
                this.logger.info(`[SessionTracker] Session finalized: ${this.sessionId}, talk time: ${sessionTalkTimeSeconds}s`);

                // Update user stats if authenticated (userId exists)
                if (this.sessionDoc.userId && this.sessionDoc.sessionType === 'authenticated') {
                    await User.findByIdAndUpdate(
                        this.sessionDoc.userId,
                        {
                            $inc: {
                                totalTalkTimeSeconds: sessionTalkTimeSeconds,
                                totalSessions: 1
                            },
                            $push: {
                                sessions: this.sessionDoc._id
                            }
                        }
                    );
                    this.logger.info(`[SessionTracker] User stats updated for: ${this.sessionDoc.userId}`);
                }
            }
            // Clear in-memory session state
            this.sessionData = null;
            this.sessionDoc = null;
        } catch (error) {
            this.logger.error(`[SessionTracker] Finalize error:`, error.message);
        }
    }

    // Helper method to get session document
    getSessionDoc() {
        return this.sessionDoc;
    }

    //get the time remaining for both anonymous and authenticated users
    getTimerInfo() {
        const elapsed = Math.floor((Date.now() - this.sessionDoc.createdAt) / 1000);

        if (this.sessionDoc.sessionType === 'authenticated') {
            const remaining = this.sessionDoc.maxDurationSeconds - elapsed;
            return {
                remainingSeconds: Math.max(0, remaining),
                maxDurationSeconds: this.sessionDoc.maxDurationSeconds,
                sessionType: 'authenticated',
                isExpired: remaining <= 0
            };
        } else {
            // Anonymous user
            const remaining = this.sessionData.remainingTrialSeconds - elapsed;
            return {
                remainingSeconds: Math.max(0, remaining),
                maxDurationSeconds: this.sessionDoc.maxDurationSeconds,
                sessionType: 'anonymous',
                isExpired: remaining <= 0
            };
        }
    }
    // Helper method to update any field
    async updateField(fieldName, value) {
        try {
            if (this.sessionDoc) {
                this.sessionDoc[fieldName] = value;
                await this.sessionDoc.save();
                this.logger.info(`[SessionTracker] Field updated: ${fieldName} = ${value}`);
                return true;
            }
            return false;
        } catch (error) {
            this.logger.error(`[SessionTracker] Update field error:`, error.message);
            return false;
        }
    }

    // Analyze conversation based on user messages
    async _shouldAnalyzeConversation(messages, minUserWords = 30) {
        let userMessageCount = 0;
        let botMessageCount = 0;
        let userWordCount = 0;
        let botWordCount = 0;

        for (const message of messages) {
            const text = (message.text || "").trim();
            const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

            if (message.sender === "user") {
                userMessageCount++;
                userWordCount += wordCount;
            } else if (message.sender === "bot") {
                botMessageCount++;
                botWordCount += wordCount;
            }
        }

        // 🔍 Get session type from this.sessionDoc
        const sessionType = this.sessionDoc?.sessionType || 'anonymous';

        // 🚫 If anonymous, never analyze
        if (sessionType === 'anonymous') {
            return {
                shouldAnalyze: false,
                reason: 'Analysis is only available for authenticated users. Please login to get conversation insights.',
                thresholds: {
                    minimumUserWords: minUserWords
                },
                statistics: {
                    totalMessages: messages.length,
                    userMessages: userMessageCount,
                    botMessages: botMessageCount,
                    userWords: userWordCount,
                    botWords: botWordCount,
                    totalWords: userWordCount + botWordCount
                }
            };
        }

        // ✅ Authenticated user - check word count
        const shouldAnalyze = userWordCount >= minUserWords;

        return {
            shouldAnalyze: shouldAnalyze,
            reason: shouldAnalyze
                ? null
                : `Insufficient user conversation. Minimum ${minUserWords} user words required but we have ${userWordCount} words only.`,
            thresholds: {
                minimumUserWords: minUserWords
            },
            statistics: {
                totalMessages: messages.length,
                userMessages: userMessageCount,
                botMessages: botMessageCount,
                userWords: userWordCount,
                botWords: botWordCount,
                totalWords: userWordCount + botWordCount
            }
        };
    }

    async _generateConversationInsights(sessionDoc) {
        try {
            const messages = [...sessionDoc.messages].sort(
                (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
            );

            const isAssistantMessage = (sender) =>
                ['assistant', 'bot', 'ai'].includes(String(sender).toLowerCase());

            const conversationData = {
                preferredLanguage: sessionDoc.preferences?.language || 'en',
                selectedTopic: sessionDoc.preferences?.topic || 'General',
                conversation: messages.map((m) => ({
                    speaker: m.sender,
                    timestamp: m.timestamp,
                    text: m.text
                })),
                userMessages: messages
                    .filter((m) => !isAssistantMessage(m.sender))
                    .map((m) => m.text)
                    .filter(Boolean),
                assistantMessages: messages
                    .filter((m) => isAssistantMessage(m.sender))
                    .map((m) => m.text)
                    .filter(Boolean)
            };

            const systemPrompt = `You are an expert conversation coach who creates a polished session report.

Return ONLY valid JSON that exactly matches the required schema below.

STRICT SCHEMA RULES:
1. Never rename, remove, add, or restructure any field.
2. Never return Markdown, explanations, comments, or text outside the JSON object.
3. Keep score fields as JSON integers from 0 to 100.
4. Keep status fields as JSON booleans.
5. If a field does not have enough evidence, use:
   - status: false
   - value: null
   - score: null
   - level: null
   - feedback: "Insufficient conversation data."
   - items: []
6. Never guess, invent, exaggerate, or use information not present in the messages.

==================================================
LANGUAGE OUTPUT RULES — HIGHEST PRIORITY
==================================================

The preferred language provided in the input is the mandatory report language.

Every generated TEXT value must be written only in that preferred language, including:
- conversationTitle.value
- summary.value
- communicationSkill.level
- communicationSkill.feedback
- engagement.level
- engagement.feedback
- grammar.level
- grammar.feedback
- strengths.items
- improvements.items
- assistantPerformance.level
- assistantPerformance.feedback
- overallConversation.level
- overallConversation.feedback

Examples:
- If preferred language is "ur", every generated text field must be in Urdu.
- If preferred language is "hi", every generated text field must be in Hindi.
- If preferred language is "en", every generated text field must be in English.

Never generate an English title for an Urdu or Hindi report.
Never mix English, Urdu, Hindi, or any other language in generated text.
Do not use English level labels such as "Excellent", "Good", "Average", "Fair", or "Poor" unless English is the preferred language.

Use natural, professional level labels in the preferred language:
- Urdu: "بہترین", "اچھا", "اوسط", "قابلِ بہتری", "کمزور"
- Hindi: "उत्कृष्ट", "अच्छा", "औसत", "सुधार योग्य", "कमज़ोर"
- English: "Excellent", "Good", "Average", "Fair", "Poor"

Scores must remain JSON numbers because the schema requires integers. The application UI can format numeric digits according to the selected language.

==================================================
LANGUAGE DETECTION RULES
==================================================

Analyze language detection from USER messages only.

- languages.primary must contain the ISO language code of the language most used by the user, such as "ur", "en", or "hi".
- languages.detected must include every additional language meaningfully used by the user.
- Do not include the primary language again inside detected.
- Meaningful use includes a complete sentence, question, clause, or clear multi-word phrase in another language.
- Do not ignore English merely because the user's primary language is Urdu or Hindi.
- If the user speaks Urdu and also asks complete questions in English, use:
  - primary: "ur"
  - detected: ["en"]
- If the user uses Urdu, Hindi, and English meaningfully, include both non-primary languages in detected.
- Do not detect a language only from names, cricket terms, single borrowed words, or assistant messages.
- The preferred language controls report output. Language detection does not change the report language.

==================================================
USER-ONLY ANALYSIS RULES
==================================================

All user-facing fields must evaluate ONLY the USER'S messages:
- conversationTitle
- summary
- languages
- communicationSkill
- engagement
- grammar
- strengths
- improvements
- overallConversation

Assistant messages may be used only to understand context. They must never influence a user-facing score, feedback, strength, improvement, or summary.

Only assistantPerformance evaluates the assistant. It is an internal developer field and must never affect the user-facing analysis.

Evaluate the user fairly using only demonstrated communication:
- clarity of ideas and questions
- relevant participation
- ability to explain opinions or experiences
- grammar and readability
- detail when detail was appropriate
- progress shown during the session

Do not penalize:
- informal speaking style
- minor transcription errors
- short responses when a short response was reasonable
- code-switching between languages
- accent, dialect, or natural spoken-language phrasing

==================================================
USER-FACING WRITING STYLE
==================================================

Write feedback that feels warm, polished, respectful, and professional.

- Speak directly to the user naturally.
- Make each feedback statement specific to what the user actually said.
- Use encouraging, clear, and constructive language.
- Improvements must be practical and respectful.
- Do not use robotic, generic, harsh, awkward, or template-like wording.
- Do not say "the user", "the assistant", "the bot", "AI", or "based on this conversation" in user-facing fields.
- Do not praise or criticize the assistant in any user-facing field.
- Do not create weaknesses merely to fill the improvements list.

==================================================
FIELD REQUIREMENTS
==================================================

conversationTitle:
- Describe the topic discussed by the user.
- Minimum 3 words, maximum 8 words.
- Must be in the preferred language.

summary:
- Summarize only the user's ideas, questions, opinions, interests, or experiences.
- Do not summarize the assistant's advice or answers.
- Write 50 to 60 words only when sufficient user content exists.
- Must be in the preferred language.

communicationSkill:
- Evaluate how clearly the user expressed thoughts, questions, and ideas.
- Consider clarity, relevance, and understandable expression.

engagement:
- Evaluate the user's participation only.
- Consider relevant questions, opinions, examples, and continued involvement.

grammar:
- Evaluate grammar, sentence construction, and readability in user messages only.
- Be kind and practical.
- Do not over-penalize informal speech or transcription issues.

strengths:
- Include 1 to 3 strengths demonstrated by the user.
- Every item must be evidence-based.
- Each item must be a concise, polished statement.

improvements:
- Include 1 to 3 improvements only when genuinely supported by the user's messages.
- Give useful next-step advice, such as adding context, organizing a question, or explaining an idea more fully.
- Never use insulting or discouraging wording.

overallConversation:
- Evaluate the user's overall participation and communication only.
- It is not a score for the assistant or the complete combined conversation.

assistantPerformance:
- Evaluate only the assistant for internal developer use.
- Consider topic relevance, natural responses, appropriate redirection, and helpfulness.
- Do not judge factual correctness.
- This feedback must still be written in the preferred language.

==================================================
TEXT LIMITS
==================================================

- conversationTitle: maximum 5-8 words
- summary: 50 to 60 words
- each feedback field: maximum 25 words
- each strength: maximum 12 words
- each improvement: maximum 12 words

==================================================
SCORING
==================================================

All scores must be integers from 0 to 100.

Use these score ranges, but translate the level label into the preferred language:
- 90 to 100: Excellent
- 75 to 89: Good
- 60 to 74: Average
- 40 to 59: Fair
- 0 to 39: Poor

Return this exact JSON schema:
{
    "conversationTitle": {
        "status": true,
        "value": null
    },
    "summary": {
        "status": true,
        "value": null
    },
    "languages": {
        "status": true,
        "primary": null,
        "detected": []
    },
    "communicationSkill": {
        "status": true,
        "score": null,
        "level": null,
        "feedback": null
    },
    "engagement": {
        "status": true,
        "score": null,
        "level": null,
        "feedback": null
    },
    "grammar": {
        "status": true,
        "score": null,
        "level": null,
        "feedback": null
    },
    "strengths": {
        "status": true,
        "items": []
    },
    "improvements": {
        "status": true,
        "items": []
    },
    "assistantPerformance": {
        "status": true,
        "score": null,
        "level": null,
        "feedback": null
    },
    "overallConversation": {
        "status": true,
        "score": null,
        "level": null,
        "feedback": null
    }
}`;

            const userPrompt = `Analyze this session.

Preferred Language: ${conversationData.preferredLanguage}
Selected Topic: ${conversationData.selectedTopic}

USER MESSAGES — use these as the ONLY source for all user-facing insights:
${conversationData.userMessages.length
                    ? conversationData.userMessages.map((text, index) => `${index + 1}. ${text}`).join('\n')
                    : 'No user messages available.'
                }

ASSISTANT MESSAGES — use ONLY for assistantPerformance:
${conversationData.assistantMessages.length
                    ? conversationData.assistantMessages.map((text, index) => `${index + 1}. ${text}`).join('\n')
                    : 'No assistant messages available.'}`;

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: OPENAI_MODEL,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.2,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            // ✅ Save token usage (function already exists)
            await this.updateTokenUsage({
                input_tokens: data.usage?.prompt_tokens || 0,
                output_tokens: data.usage?.completion_tokens || 0,
                total_tokens: data.usage?.total_tokens || 0
            });

            const rawInsights = JSON.parse(data.choices[0].message.content);

            sessionDoc.insights = {
                schemaVersion: 1,
                generatedBy: OPENAI_MODEL,
                generatedAt: new Date(),
                analysisStatus: {
                    completed: true,
                    reason: null
                },
                ...rawInsights
            };

            this.logger.info(
                `[SessionTracker] Insights generated for session: ${sessionDoc.sessionId}`
            );
        } catch (error) {
            this.logger.error(
                '[SessionTracker] Insights generation failed:',
                error.message
            );

            sessionDoc.insights = {
                schemaVersion: 1,
                generatedBy: OPENAI_MODEL,
                generatedAt: new Date(),
                analysisStatus: {
                    completed: false,
                    reason: `Analysis failed: ${error.message}`
                }
            };
        }
    }
}

export default SessionTracker;