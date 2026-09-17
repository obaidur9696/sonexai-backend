import { Session } from '../../models/session.models.js';
import { User } from '../../models/user.models.js';
import { Project } from '../../models/project.models.js';
import { v4 as uuidv4 } from 'uuid';
import { isEnglishLanguage, transliterateText } from '../../utils/transliterateText.js';
import { normalizeOpenAITokenUsage } from '../../utils/normalizeOpenAITokenUsage.js';


const OPENAI_MODEL = 'gpt-4o-mini';
const MIN_USER_WORDS = 30; // Minimum user words required for analysis

function isAnyTopicSelection(topic) {
    return String(topic || '').trim().toLowerCase() === 'any topic';
}

 class SessionTracker {
    constructor({ preferences, basePhoneCall, clientId, logger }) {
        this.clientId = clientId;
        this.sessionId = uuidv4()
        this.preferences = preferences;
        this.basePhoneCall = basePhoneCall;
        this.logger = logger;
        this.sessionDoc = null; // contain mongoose document of the session
        this.sessionData = {}; // plain json object of the session data
        this._sessionWriteQueue = Promise.resolve();
    }

    _enqueueSessionWrite(operation) {
        const queuedOperation = this._sessionWriteQueue.then(operation);

        // Keep the queue usable after a failed write while returning the original
        // rejection to the caller that initiated it.
        this._sessionWriteQueue = queuedOperation.catch(() => undefined);

        return queuedOperation;
    }

    async initialize() {
        try {
            // Fetch project config
            const project = await Project.findOne({ corporate: "A2plus" });
            // Find the specific WebRTC config by webrtcId
            const webrtcConfig = project?.webrtc?.find(
                config => config.webrtcId === "webrtc_talk"
            );

            const projectConfig = {
                silencePeriod: webrtcConfig?.silencePeriod,
                noAnswerTimeoutSeconds: webrtcConfig?.noAnswerTimeoutSeconds
            };
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
                    this.basePhoneCall.sendError(this.clientId, 'Invalid user ID. Please login again.');
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
                        this.clientId,
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
                    this.clientId,
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
                        name: this.preferences.name,
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

                await this._applyTransliteratedPreferences(session);
            }

            this.sessionDoc = session;
            return { session, projectConfig };

        } catch (error) {
            this.logger.error('[SessionTracker] Initialize error', { error: error.message });
            this.basePhoneCall.sendError(this.clientId, 'Session initialization failed. You can try again.');
            return null;
        }
    }

    async activate() {
        return this._enqueueSessionWrite(async () => {
            try {
                if (!this.sessionDoc) {
                    this.sessionDoc = await Session.findOne({ sessionId: this.sessionId });
                }

                if (this.sessionDoc && this.sessionDoc.status === 'created') {
                    this.sessionDoc.status = 'active';
                    await this.sessionDoc.save();
                    this.logger.info(`[SessionTracker] Session activated: ${this.sessionId}`);
                }

                if (this.sessionDoc?.status === 'active') {
                    return this._getActiveSessionPayload();
                }

                return null;
            } catch (error) {
                this.logger.error(`[SessionTracker] Activate error:`, error.message);
                return null;
            }
        });
    }

    async _applyTransliteratedPreferences(session) {
        const language = this.preferences?.language || 'en';
        const fullName = typeof this.preferences?.name === 'string' && this.preferences.name.trim()
            ? this.preferences.name.trim()
            : 'User';
        const topic = this.preferences?.topic || 'general conversation';
        const isAnyTopic = isAnyTopicSelection(topic);
        const titleTopic = isAnyTopic ? 'New Conversation' : topic;
        if (isEnglishLanguage(language)) {
            if (isAnyTopic) {
                session.title = titleTopic;
                await session.save();
            }
            return;
        }

        const translated = await transliterateText({
            name: fullName,
            topic: titleTopic,
            language,
            logger: this.logger
        });

        this.preferences.name = translated.name;
        session.preferences.name = translated.name;
        session.title = translated.topic;

        // "Any Topic" is a control value for FullDuplex, not a display topic.
        // Keep it unchanged in preferences while saving the translated
        // "New Conversation" title. All other topics keep the existing behavior.
        if (!isAnyTopic) {
            this.preferences.topic = translated.topic;
            session.preferences.topic = translated.topic;
        }

        if (translated.tokenUsage) {
            session.tokenUsage.input_tokens += translated.tokenUsage.input_tokens;
            session.tokenUsage.output_tokens += translated.tokenUsage.output_tokens;
            session.tokenUsage.total_tokens += translated.tokenUsage.total_tokens;
            this.logger.info('[SessionTracker] Transliteration token usage:', translated.tokenUsage);
        }

        await session.save();
        this.logger.info(
            `[SessionTracker] Preferences transliterated for session ${this.sessionId}: ` +
            `topic="${translated.topic}", name="${translated.name}"`
        );
    }

    _getActiveSessionPayload() {
        const preferences = this.sessionDoc.preferences || {};

        return {
            sessionId: this.sessionDoc.sessionId,
            status: this.sessionDoc.status,
            createdAt: this.sessionDoc.createdAt,
            topic: this.sessionDoc.title || 'New Conversation',
            name: preferences.name || this.preferences?.name || 'User',
            preferences
        };
    }

    async recordMessage(sender, text) {
        return this._enqueueSessionWrite(async () => {
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
        });
    }

    /**
 * Update token usage in session document
 * @param {Object} tokenUsage - { input_tokens, output_tokens, total_tokens }
 */
    async updateTokenUsage(tokenUsage) {
        const normalizedTokenUsage = normalizeOpenAITokenUsage(tokenUsage);
        if (!normalizedTokenUsage) {
            this.logger.warn(`[SessionTracker] Token usage skipped for session ${this.sessionId}: invalid usage payload`);
            return;
        }

        try {
            await this._enqueueSessionWrite(() => this._persistTokenUsage(normalizedTokenUsage));
            this.logger.info(
                `[SessionTracker] Token usage updated for session ${this.sessionId}: ` +
                `Input: ${normalizedTokenUsage.input_tokens}, Output: ${normalizedTokenUsage.output_tokens}, Total: ${normalizedTokenUsage.total_tokens}`
            );
        } catch (error) {
            this.logger.error(`[SessionTracker] Update token usage error:`, error.message);
        }
    }

    async _persistTokenUsage(tokenUsage) {
        const normalizedTokenUsage = normalizeOpenAITokenUsage(tokenUsage);
        if (!normalizedTokenUsage) return false;

        if (!this.sessionDoc) {
            this.sessionDoc = await Session.findOne({ sessionId: this.sessionId });
        }

        if (!this.sessionDoc) return false;

        // Initialize tokenUsage if not exists
        if (!this.sessionDoc.tokenUsage) {
            this.sessionDoc.tokenUsage = {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0
            };
        }

        // Add new token usage to existing
        this.sessionDoc.tokenUsage.input_tokens += normalizedTokenUsage.input_tokens;
        this.sessionDoc.tokenUsage.output_tokens += normalizedTokenUsage.output_tokens;
        this.sessionDoc.tokenUsage.total_tokens += normalizedTokenUsage.total_tokens;

        await this.sessionDoc.save();
        return true;
    }

    async finalize() {
        return this._enqueueSessionWrite(async () => {
            try {
                if (!this.sessionDoc) {
                    this.sessionDoc = await Session.findOne({ sessionId: this.sessionId });
                }
                if (!this.sessionDoc) return;
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
                        this.sessionDoc.title = 'New Conversation';
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
        });
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
   - feedback: a short equivalent of "Insufficient conversation data" in the preferred language
   - items: []
6. Never guess, invent, exaggerate, or use information not present in the messages.

==================================================
LANGUAGE OUTPUT RULES — HIGHEST PRIORITY
==================================================

Use preferredLanguage from the input as the mandatory language for every generated analysis value. It is the configured session language and must not be overridden by the languages detected in user messages.

Treat preferredLanguage as an absolute output-language lock. It is authoritative whether supplied as a language name or a language code. Never choose the report language from the language of the transcript, the selected topic, assistant messages, or languages.primary/languages.detected.

Every generated human-readable TEXT value must be written only in preferredLanguage, including:
- conversationTitle.value
- summary.value
- scoreRanges.level
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

For every preferredLanguage value, every generated text field must use that same language. When preferredLanguage is not English, do not return English words, English labels, or English sentences in any generated analysis field. This remains mandatory even when the user spoke English or multiple languages during the session; express the analysis in preferredLanguage instead.

Do not mix languages in generated text. Every scoreRanges.level and every other level is a human-readable text field and must always be written in preferredLanguage.

Every level value must be the preferredLanguage translation of exactly one of these five fixed rating categories: Excellent, Good, Average, Fair, or Poor. These English category names are semantic references for selecting the rating only; never output their English text unless preferredLanguage is English. Never use descriptive phrases such as "strong performance", "adequate performance", or "needs improvement" as a level value.

Before returning JSON, validate every generated human-readable field against preferredLanguage. If preferredLanguage is not English, replace any English wording with its natural equivalent in preferredLanguage. Do not hardcode a language-specific mapping; dynamically use the correct equivalent for the supplied preferredLanguage.

scoreRanges is the single source of truth for level values in this report. First generate its five level strings in preferredLanguage, then reuse those exact strings for every scored field. A level in communicationSkill, engagement, grammar, assistantPerformance, or overallConversation must exactly equal one scoreRanges.level value; do not use a synonym, variation, English fallback, or a different translation of the same category.

Scores and ISO language codes must remain JSON numbers and codes because the schema requires them. The numeric score is language-neutral; all human-readable descriptive text, labels, feedback, strengths, and improvements must follow preferredLanguage.

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
- Language detection is independent from report generation. Determine languages.primary and languages.detected only from user messages, but never use them to override preferredLanguage for generated analysis content.

==================================================
TOPIC AND EVIDENCE RULES
==================================================

Determine the actual topic from what the USER discussed. The selected topic is context only; it is never proof that the user discussed that topic.

- If the conversation follows the selected topic, analyze that topic.
- If the user meaningfully changes or narrows the topic, analyze the topic actually discussed.
- Every title, summary, score, strength, improvement, and feedback statement must be grounded in the user's real statements and be relevant to that actual topic.
- Do not produce generic coaching, praise, criticism, or recommendations that could apply to an unrelated conversation.
- Do not infer knowledge, opinions, experiences, or weaknesses from the selected topic, assistant messages, or missing user content.

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
- relevant participation in the actual topic discussed
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
- Keep every strength, improvement, and feedback statement relevant to the actual topic discussed and the user's demonstrated communication in that topic.
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
- Describe only the actual topic discussed by the user, not merely the selected topic.
- Minimum 3 words, maximum 8 words.
- Must be in preferredLanguage.

summary:
- Summarize only the user's ideas, questions, opinions, interests, or experiences.
- Do not summarize the assistant's advice or answers.
- Write 50 to 60 words only when sufficient user content exists.
- Must focus on the actual topic discussed and be in preferredLanguage.

communicationSkill:
- Evaluate how clearly the user expressed thoughts, questions, and ideas.
- Consider clarity, relevance to the actual topic, and understandable expression.
- Base feedback on specific demonstrated communication, not generic speaking advice.

engagement:
- Evaluate the user's participation only.
- Consider relevant questions, opinions, examples, and continued involvement in the actual topic.

grammar:
- Evaluate grammar, sentence construction, and readability in user messages only.
- Be kind and practical.
- Do not over-penalize informal speech or transcription issues.
- Assess only errors actually visible in the user's language; do not infer grammar problems from topic knowledge or brevity.

strengths:
- Include 1 to 3 strengths demonstrated by the user.
- Every item must be evidence-based and relevant to the actual topic and conversation.
- Each item must be a concise, polished statement.

improvements:
- Include 1 to 3 improvements only when genuinely supported by the user's messages.
- Give useful next-step advice that addresses a demonstrated weakness in this topic and conversation, such as adding relevant context, organizing a question, or explaining an idea more fully.
- Never use insulting or discouraging wording.
- If no topic-relevant improvement is supported by the messages, return an empty items array rather than inventing one.

overallConversation:
- Evaluate the user's overall participation and communication only.
- It is not a score for the assistant or the complete combined conversation.
- Keep the evaluation tied to the actual topic and demonstrated user contribution.

assistantPerformance:
- Evaluate only the assistant for internal developer use.
- Consider relevance to the actual topic, natural responses, appropriate redirection, and helpfulness.
- Do not judge factual correctness.
- This feedback must still be written in preferredLanguage.

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

All score values must be JSON integers from 0 to 100. Assess communicationSkill, engagement, grammar, and overallConversation separately and strictly from the user's demonstrated performance in the actual messages.

Be completely truthful. Do not default to 70–80, inflate scores to be encouraging, or give the same score to every field. If the user's demonstrated performance in a skill is poor, assign the genuinely low score it deserves; for performance around 20%, use a score around 20. If the demonstrated performance is excellent, assign a score in the excellent range. If evidence is insufficient, return the schema's insufficient-evidence values instead of an arbitrary score.

Use these exact score-to-level mappings for every level field:
- 90 to 100: the preferredLanguage translation of "Excellent" only.
- 75 to 89: the preferredLanguage translation of "Good" only.
- 60 to 74: the preferredLanguage translation of "Average" only.
- 40 to 59: the preferredLanguage translation of "Fair" only.
- 0 to 39: the preferredLanguage translation of "Poor" only.

scoreRanges must always contain exactly these five objects, in this exact order, with no additional objects:
- { "level": preferredLanguage equivalent of "Excellent", "minScore": 90, "maxScore": 100 }
- { "level": preferredLanguage equivalent of "Good", "minScore": 75, "maxScore": 89 }
- { "level": preferredLanguage equivalent of "Average", "minScore": 60, "maxScore": 74 }
- { "level": preferredLanguage equivalent of "Fair", "minScore": 40, "maxScore": 59 }
- { "level": preferredLanguage equivalent of "Poor", "minScore": 0, "maxScore": 39 }

For every scored field with a numeric score, use the exact matching scoreRanges.level string. Never use a synonym, a different translation, an English fallback, an explanation, or a performance phrase as a level. If a scored field has insufficient evidence, keep its score and level null as required by the schema; scoreRanges must still contain all five localized range objects.

The level must match the numeric score range exactly. Return only the concise preferredLanguage equivalent of the assigned rating category in a level field—never English text when preferredLanguage is another language, and never an alternative wording, explanation, or performance phrase. Put specific details only in the feedback field, written in preferredLanguage.

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
    "scoreRanges": [
        {
            "level": null,
            "minScore": 90,
            "maxScore": 100
        },
        {
            "level": null,
            "minScore": 75,
            "maxScore": 89
        },
        {
            "level": null,
            "minScore": 60,
            "maxScore": 74
        },
        {
            "level": null,
            "minScore": 40,
            "maxScore": 59
        },
        {
            "level": null,
            "minScore": 0,
            "maxScore": 39
        }
    ],
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

            const userPrompt = `Analyze this session using the actual topic and the user's actual messages as the sole evidence for user-facing analysis.

Preferred Language (mandatory for all generated analysis content): ${conversationData.preferredLanguage}
Selected Topic (context only; do not assume it was discussed): ${conversationData.selectedTopic}

USER MESSAGES — use these as the ONLY source for all user-facing insights:
${conversationData.userMessages.length
                    ? conversationData.userMessages.map((text, index) => `${index + 1}. ${text}`).join('\n')
                    : 'No user messages available.'
                }

ASSISTANT MESSAGES — use ONLY for assistantPerformance:
${conversationData.assistantMessages.length
                    ? conversationData.assistantMessages.map((text, index) => `${index + 1}. ${text}`).join('\n')
                    : 'No assistant messages available.'}

FINAL OUTPUT LANGUAGE LOCK: Generate every human-readable analysis value only in the configured preferredLanguage: ${conversationData.preferredLanguage}. This includes conversationTitle.value, summary.value, every scoreRanges.level, every skill level, every feedback value, strengths.items, improvements.items, assistantPerformance, and overallConversation. Do not use the language of the messages or the detected languages to choose these values. If preferredLanguage is not English, no generated English label, feedback, summary, title, strength, or improvement may be returned.`;

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
            // This method runs inside finalize's write queue, so write directly
            // instead of enqueueing behind the in-progress finalization.
            const tokenUsage = normalizeOpenAITokenUsage(data.usage);

            if (tokenUsage) {
                try {
                    await this._persistTokenUsage(tokenUsage);
                    this.logger.info(
                        `[SessionTracker] Analysis token usage updated for session ${this.sessionId}: ` +
                        `Input: ${tokenUsage.input_tokens}, Output: ${tokenUsage.output_tokens}, Total: ${tokenUsage.total_tokens}`
                    );
                } catch (error) {
                    this.logger.error(`[SessionTracker] Analysis token usage error:`, error.message);
                }
            } else {
                this.logger.warn(`[SessionTracker] No token usage returned for analysis session ${this.sessionId}`);
            }

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
