import { normalizeOpenAITokenUsage } from './normalizeOpenAITokenUsage.js';

const OPENAI_MODEL = 'gpt-4o-mini';

export function isEnglishLanguage(language) {
    const normalizedLanguage = String(language || '').trim().toLowerCase();
    return normalizedLanguage === 'en' ||
        normalizedLanguage === 'english' ||
        normalizedLanguage.startsWith('en-');
}

/**
 * Transliterate a user's name and selected topic into the target language script.
 * English preferences are returned unchanged without making an OpenAI request.
 *
 * @param {Object} params
 * @param {string} params.name
 * @param {string} params.topic
 * @param {string} params.language
 * @param {string} [params.apiKey]
 * @param {Object} [params.logger]
 * @returns {Promise<{name: string, topic: string, tokenUsage: Object|null}>}
 */
export async function transliterateText({
    name,
    topic,
    language,
    apiKey = process.env.OPENAI_API_KEY,
    logger
}) {
    if (isEnglishLanguage(language)) {
        return { name, topic, tokenUsage: null };
    }

    try {
        const systemPrompt = `You are a transliteration expert. Convert the given English text into the target language script.

RULES:
1. DO NOT translate the meaning — keep the exact same words/phrases.
2. ONLY convert the script/writing system to the target language.
3. For names: Write the name as it would be written in the target language script.
4. For topics: Write the topic as it would be written in the target language script.
5. Return ONLY valid JSON with "name" and "topic" fields.

Example:
Input: name="Safi Rahman", topic="Photography", language="ur"
Output: {"name":"صفی رحمان","topic":"فوٹوگرافی"}

Return ONLY JSON, no other text.`;

        const userPrompt = `Convert these to ${language} script:
Name: ${name}
Topic: ${topic}`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.1,
                response_format: { type: 'json_object' }
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = await response.json();
        const result = JSON.parse(data.choices[0].message.content);
        const tokenUsage = normalizeOpenAITokenUsage(data.usage);

        return {
            name: result.name || name,
            topic: result.topic || topic,
            tokenUsage
        };
    } catch (error) {
        logger?.error('[Transliteration] Failed:', error.message);
        return { name, topic, tokenUsage: null };
    }
}
