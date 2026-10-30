// Synthetic 2x2 RGBA fixtures: three alpha=0 pixels, and a last pixel with alpha=0/1/255.
// Lossless VP8L and lossy VP8X+ALPH. No device, app, or screenshot data.
export const webpImages = [
  { name: "lossless-empty", alpha: 0, data: "UklGRioAAABXRUJQVlA4TB0AAAAvAUAAEB8gEEjeHzqN+RcQFPwfXUTwA27AENH/EAA=" },
  { name: "lossless-faint", alpha: 1, data: "UklGRiwAAABXRUJQVlA4TB8AAAAvAUAAEB8gEEjeHzqN+RcQFPwf3QREYA/iBgwR/Q8BAA==" },
  { name: "lossless-visible", alpha: 255, data: "UklGRiwAAABXRUJQVlA4TB8AAAAvAUAAEB8gEEjeHzqN+RcQFPwf3fxHYA/iBgwR/Q8BAA==" },
  { name: "lossy-empty", alpha: 0, data: "UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAAAAAAABWUDggLAAAAJABAJ0BKgIAAgACADQlpAAC50+MwAD+8pPtZ2mx/4a//n3AMMH8AYOGSAAA" },
  { name: "lossy-faint", alpha: 1, data: "UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAAAAAAQBWUDggLAAAAJABAJ0BKgIAAgACADQlpAAC50+MwAD+8pPtZ2mx/4a//n3AMMH8AYOGSAAA" },
  { name: "lossy-visible", alpha: 255, data: "UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAAAAA/wBWUDggLAAAAJABAJ0BKgIAAgACADQlpAAC50+MwAD+8pPtZ2mx/4a//n3AMMH8AYOGSAAA" },
];
