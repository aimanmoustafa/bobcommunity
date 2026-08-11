import { logger } from "./logger";

/**
 * Token-bucket rate limiter. Queues calls and releases them
 * at a controlled rate so bursts of Discord messages don't
 * slam the OpenAI API and trigger 429s.
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;

  constructor(maxTokens: number, refillIntervalMs: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillIntervalMs = refillIntervalMs;

    setInterval(() => this.refill(), refillIntervalMs);
  }

  private refill(): void {
    this.tokens = this.maxTokens;
    this.drain();
  }

  private drain(): void {
    while (this.tokens > 0 && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.tokens--;
        next();
      }
    }
  }

  async acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    if (this.queue.length > 50) {
      logger.warn("Rate limiter queue is large, dropping oldest request", {
        queueSize: this.queue.length,
      });
      this.queue.shift();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
}

// Shared limiter: max 20 OpenAI calls per 10 seconds (tune per your OpenAI tier)
export const openaiRateLimiter = new RateLimiter(20, 10_000);
