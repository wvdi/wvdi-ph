/**
 * MiniMax AI Provider
 * Uses MiniMax M2.7-highspeed model via OpenAI-compatible API
 */

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7-highspeed';
const MINIMAX_API_URL = 'https://api.minimaxi.chat/v1';

/**
 * Create MiniMax provider instance
 */
export function createMiniMaxProvider() {
  return {
    name: 'minimax',
    model: MINIMAX_MODEL,

    async chat({ systemPrompt, messages, temperature = 0.7, maxTokens = 800, jsonMode = false }) {
      if (!MINIMAX_API_KEY) {
        throw new Error('MINIMAX_API_KEY is not configured');
      }

      const chatMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        })),
      ];

      const requestBody = {
        model: MINIMAX_MODEL,
        messages: chatMessages,
        temperature,
        max_tokens: maxTokens,
      };

      if (jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      const response = await fetch(`${MINIMAX_API_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();

      if (!data.choices || !data.choices[0]?.message?.content) {
        throw new Error('Invalid response format from MiniMax');
      }

      return data.choices[0].message.content.trim();
    },

    async healthCheck() {
      if (!MINIMAX_API_KEY) {
        return { available: false, error: 'MINIMAX_API_KEY not configured' };
      }

      try {
        const response = await fetch(`${MINIMAX_API_URL}/models`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${MINIMAX_API_KEY}` },
          signal: AbortSignal.timeout(5000),
        });

        return {
          available: response.ok,
          model: MINIMAX_MODEL,
        };
      } catch (error) {
        return { available: false, error: error.message };
      }
    },
  };
}
