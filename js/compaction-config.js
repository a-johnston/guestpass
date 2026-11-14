// Shared fixed limits and weights. Pure: item extraction, compaction and recall use one source.
export const COMPACTION = Object.freeze({
  highMark: 0.6, minFree: 0.1, lowMark: 1 / 3, limitMark: 0.9, nominalWindow: 131072,
  weights: Object.freeze({ reasoning: 8000, plan: 4000, text: 4000, read: 3000, edit: 3000, page: 10000, other: 2000, recall: 3000, stubs: 4000, notes: 1500 }),
  planTokens: 2000, planHead: 1000, planTail: 3000, userCap: 4000, noteChars: 200,
  stubWords: 30, recallChars: 16000, searchHits: 20,
  directoryTokens: 64, recallLabelChars: 512, searchPatternChars: 2000,
});
