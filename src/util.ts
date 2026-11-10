export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Lets a loop sleep until it is poked, timed out, or aborted. */
export class Wake {
  private poked = false;
  private release: (() => void) | null = null;

  poke(): void {
    this.poked = true;
    this.release?.();
  }

  /** Resolves true if poked, false on timeout or abort. */
  async wait(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.poked && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          this.release = null;
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
        this.release = done;
      });
    }
    const was = this.poked;
    this.poked = false;
    return was;
  }
}
