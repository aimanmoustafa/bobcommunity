import { logger } from "./logger";

interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  label?: string;
}

/**
 * Retries an async function with exponential backoff.
 * Used for Anthropic and Slack API calls that can fail transiently.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { retries = 3, baseDelayMs = 500, label = "operation" } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Don't retry on 4xx client errors (bad request, auth, etc.) except 429
      const status = error?.status || error?.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        logger.warn(`${label} failed with non-retryable status ${status}`, {
          message: error?.message,
        });
        throw error;
      }

      if (attempt === retries) break;

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200;
      logger.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${Math.round(delay)}ms`, {
        error: error?.message,
      });
      await sleep(delay);
    }
  }

  logger.error(`${label} failed after ${retries + 1} attempts`, lastError);
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
