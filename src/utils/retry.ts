import { logger } from "./logger";

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { label: string; retries?: number; delayMs?: number } = { label: "operation" }
): Promise<T> {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 500;
  let lastError: any;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      logger.warn(`${options.label} failed (attempt ${attempt}/${retries})`, { error: (error as any)?.message });
      if (attempt < retries) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
