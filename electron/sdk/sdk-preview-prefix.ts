/** Request-local optional preview I/O; never authorizes the final capture. */
export class SdkPreviewPrefix {
  static readonly limit = 12_000_001;
  private validatedBytes = 0;
  readonly metrics = { reads: 0, bytes: 0, skipped: 0, readMs: 0, parseMs: 0 };

  get capped() { return this.validatedBytes >= SdkPreviewPrefix.limit; }

  shouldRead(): boolean {
    // head cannot reveal more records once its fixed byte cap was reached.
    // Final full-file reading and SHA/identity checks remain separate.
    if (this.capped) {
      this.metrics.skipped++;
      return false;
    }
    return true;
  }

  accept(data: Buffer, nonce: string, parse: () => unknown): void {
    if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from(nonce, "hex"))) return;
    // Only a successfully parsed, nonce-bound prefix can suppress another read.
    parse();
    this.validatedBytes = data.length;
  }
}
