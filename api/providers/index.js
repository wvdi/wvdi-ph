/**
 * AI Provider Factory with Automatic Fallback
 * Supports: gemini, ollama, openai
 * Priority order configurable via AI_PROVIDER_PRIORITY env var
 */

import { createOllamaProvider } from './ollama.js';
import { createGeminiProvider } from './gemini.js';
import { createMiniMaxProvider } from './minimax.js';

// Provider registry
const providers = {
  minimax: createMiniMaxProvider,
  gemini: createGeminiProvider,
  ollama: createOllamaProvider,
};

// Default priority order (MiniMax first, Gemini fallback)
const DEFAULT_PRIORITY = 'minimax,gemini';

/**
 * Get priority order from env or default
 */
function getPriorityOrder() {
  const priority = process.env.AI_PROVIDER_PRIORITY || DEFAULT_PRIORITY;
  return priority.split(',').map(p => p.trim()).filter(p => providers[p]);
}

/**
 * Get a provider with automatic fallback support
 * @returns {Object} Provider with chat() and healthCheck() methods
 */
export function getProvider() {
  const priorityOrder = getPriorityOrder();

  return {
    name: 'fallback',
    priorityOrder,

    /**
     * Chat with automatic fallback between providers
     */
    async chat(params) {
      const errors = [];

      for (const providerName of priorityOrder) {
        try {
          const provider = providers[providerName]();
          const response = await provider.chat(params);

          // Success - return response with provider info
          return {
            content: response,
            provider: providerName,
            model: provider.model,
          };
        } catch (error) {
          console.log(`Provider ${providerName} failed: ${error.message}`);
          errors.push({ provider: providerName, error: error.message });

          // Continue to next provider
          continue;
        }
      }

      // All providers failed
      throw new Error(`All providers failed: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`);
    },

    /**
     * Health check - returns first available provider
     */
    async healthCheck() {
      for (const providerName of priorityOrder) {
        try {
          const provider = providers[providerName]();
          const result = await provider.healthCheck();

          if (result.available) {
            return {
              available: true,
              provider: providerName,
              model: result.model,
              fallbackOrder: priorityOrder,
            };
          }
        } catch (error) {
          continue;
        }
      }

      return {
        available: false,
        fallbackOrder: priorityOrder,
        error: 'No providers available',
      };
    },
  };
}

/**
 * Check if AI backend is available
 * @returns {Promise<{available: boolean, provider: string, error?: string}>}
 */
export async function checkHealth() {
  try {
    const provider = getProvider();
    const result = await provider.healthCheck();
    return {
      available: result.available,
      provider: result.provider || 'none',
      model: result.model || null,
      fallbackOrder: result.fallbackOrder,
    };
  } catch (error) {
    return {
      available: false,
      provider: 'none',
      error: error.message,
    };
  }
}
