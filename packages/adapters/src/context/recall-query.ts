import { recallTokens } from "@ardurbot/memory/node/recall-index";

const STOP_WORDS = new Set(
  "the a an and or but is are was were be been do does did have has had i we you it this that these those what which who when where how why please about for from with can could would should tell me our your in on of to at as my any asked reply just".split(
    " ",
  ),
);

/** The gate and retrieval must agree on which words carry search intent. */
export function recallQueryWords(text: string): string[] {
  return [
    ...new Set(recallTokens(text).filter((word) => word.length >= 3 && !STOP_WORDS.has(word))),
  ];
}
