import { normalizeOpenAITokenUsage } from './normalizeOpenAITokenUsage.js';

const OPENAI_MODEL = process.env.OPENAI_TRANSLITERATION_MODEL || 'gpt-5.4';

function getLanguageName(language) {
    const languageCode = String(language || '').trim();

    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(languageCode) || languageCode;
    } catch {
        return languageCode;
    }
}

export function isEnglishLanguage(language) {
    const normalizedLanguage = String(language || '').trim().toLowerCase();
    return normalizedLanguage === 'en' ||
        normalizedLanguage === 'english' ||
        normalizedLanguage.startsWith('en-');
}

/**
 * Localize a selected topic and transliterate a user's name for the target language.
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
        const targetLanguage = getLanguageName(language);
        const systemPrompt = `Localize exactly two fields for the target language.
Target language: ${targetLanguage} (ISO code: ${language}).
Rules:
1. topic must be written in ${targetLanguage}, never another language.
2. name must keep the same person's name and pronunciation. Transliterate it only when ${targetLanguage} uses a different script.
3. If ${targetLanguage} uses Latin script, keep the Latin name spelling unchanged.
4. Return only JSON: {"name":"...","topic":"..."}.`;

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
                    { role: 'user', content: `Name: ${name}\nTopic: ${topic}` }
                ],
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
            name: typeof result.name === 'string' && result.name.trim() ? result.name.trim() : name,
            topic: typeof result.topic === 'string' && result.topic.trim() ? result.topic.trim() : topic,
            tokenUsage
        };
    } catch (error) {
        logger?.error('[Transliteration] Failed:', error.message);
        return { name, topic, tokenUsage: null };
    }
}
