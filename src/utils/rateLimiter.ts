export class RateLimiter {
  private timestamps: number[] = [];
  constructor(private maxCalls: number, private windowMs: number) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxCalls) {
      const oldestCall = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldestCall);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}
