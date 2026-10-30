/** Current TextPaint base font, not per-span/per-glyph fallback or a font file. */
export type ViewFontResult = {
  ref: string;
  capturedAtMillis: number;
  source: "jdwp";
  basis: "text-paint";
  familyName: string | null;
  familyNameStatus: "system-family" | "not-exposed" | "unsupported";
  weight: number | null;
  style: number | null;
  usesDefaultTypeface: boolean;
};
