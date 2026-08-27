const toTokenCount = (value) => {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) && parsedValue >= 0
        ? Math.floor(parsedValue)
        : null;
};

/**
 * Convert OpenAI usage payloads into the session tokenUsage schema.
 *
 * Chat Completions REST responses use prompt_tokens/completion_tokens, while
 * Realtime response.done events use input_tokens/output_tokens.
 *
 * @param {Object|null|undefined} usage
 * @returns {{input_tokens: number, output_tokens: number, total_tokens: number}|null}
 */
export function normalizeOpenAITokenUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    const inputTokens = toTokenCount(usage.input_tokens ?? usage.prompt_tokens);
    const outputTokens = toTokenCount(usage.output_tokens ?? usage.completion_tokens);
    const totalTokens = toTokenCount(usage.total_tokens);

    if (inputTokens === null && outputTokens === null && totalTokens === null) {
        return null;
    }

    return {
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
        total_tokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0)
    };
}
