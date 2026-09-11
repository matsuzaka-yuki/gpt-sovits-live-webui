// Deterministic speech cleanup: keep words, numbers and meaningful punctuation.
export function cleanSpeechText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\p{Cs}]/gu, ' ')
    .replace(/[#*0-9]\uFE0F?\u20E3/gu, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u20E3]/gu, ' ')
    .replace(/[*_`~|\\<>^#]+/g, ' ')
    .replace(/([!?.,，。！？、;；:：…])\1+/gu, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([!?.,，。！？、;；:：…])/gu, '$1')
    .trim();
}

export function hasSpeechContent(text) {
  return /[\p{L}\p{N}]/u.test(text);
}
