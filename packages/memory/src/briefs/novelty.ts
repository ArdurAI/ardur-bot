function normalize(text: string): string {
  return text
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Skip only recognizable conversation or assertions already present in the brief. */
export function hasNewBriefFacts(current: string, evidence: string[]): boolean {
  const known = ` ${normalize(current)} `;
  return evidence.some((text) =>
    text.split(/\n+|(?<=[.!?。！？])\s+/u).some((line) => {
      const value = normalize(line);
      if (!value) return false;
      if (
        /^(?:ok(?:ay)?|thanks?(?: you)?(?: very much)?|thank you|hello|hi|great|got it|understood|you re welcome|you are welcome|no problem|sounds good|all right)[ !.]*$/.test(
          value,
        )
      )
        return false;
      // Information requests alone add no assertion; their replies are checked separately.
      if (
        /^(?:what|when|where|who|how much|how many)\b/i.test(line.trim()) &&
        /[?？]\s*$/.test(line)
      )
        return false;
      // Preserve word order and short values, including dates and negation. A bag of words
      // would incorrectly equate "A follows B" with "B follows A", or omit a changed number.
      return !known.includes(` ${value} `);
    }),
  );
}
