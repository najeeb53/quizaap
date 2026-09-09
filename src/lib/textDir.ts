// Auto-detects Arabic script so the embedded Arabic font + larger size apply automatically to
// any Arabic question, answer, or category name — no per-item flag needed in the data.
const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function containsArabic(text: string | null | undefined): boolean {
  return !!text && ARABIC_RANGE.test(text);
}

/** Returns "font-arabic text-right" when the text contains Arabic script, else "". Spread into a
 * template className string, e.g. `className={`text-lg ${arabicClass(question.text)}`}`.
 * text-right makes sure Arabic lines — including ones nested inside a container that forces
 * text-left, like the sequence-reveal <ol> — align to the right regardless of their parent. */
export function arabicClass(text: string | null | undefined): string {
  return containsArabic(text) ? 'font-arabic text-right' : '';
}

/** Returns "rtl" when the text contains Arabic script, else "ltr". Use as the `dir` attribute
 * on the element (or an ancestor) so numbering/punctuation order and bullet placement flip
 * correctly too, e.g. `<li dir={arabicDir(text)}>`. className alone only handles alignment. */
export function arabicDir(text: string | null | undefined): 'rtl' | 'ltr' {
  return containsArabic(text) ? 'rtl' : 'ltr';
}
