/**
 * Word bank for free Practice.
 *
 * This is not a lesson and never enters the library. The planner still only
 * selects frozen lesson ids; these words exist so the Practice tab can run a
 * Monkeytype-style timed drill without inventing curriculum.
 */

const WORDS = Object.freeze([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
  'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
  'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
  'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',
  'world', 'still', 'own', 'life', 'become', 'here', 'show', 'house', 'both', 'need',
  'try', 'last', 'ask', 'point', 'hand', 'high', 'part', 'place', 'case', 'week',
  'company', 'system', 'each', 'right', 'program', 'turn', 'move', 'start', 'might', 'such',
  'great', 'small', 'every', 'state', 'keep', 'never', 'shall', 'under', 'while', 'next',
  'another', 'between', 'without', 'again', 'against', 'during', 'always', 'something', 'nothing', 'through',
]);

export const PRACTICE_DURATIONS = Object.freeze([15, 30, 60]);
export const DEFAULT_PRACTICE_SECONDS = 30;

/**
 * Build a space-separated line of practice words.
 *
 * Enough words are drawn that a 60-second drill at a high WPM still has
 * leftover text; the timer, not the string length, ends the run.
 */
export function generatePracticeText({ wordCount = 80, random = Math.random } = {}) {
  if (wordCount < 1) throw new Error('Practice text needs at least one word');
  const picked = [];
  let previous = '';
  for (let i = 0; i < wordCount; i += 1) {
    let word = WORDS[Math.floor(random() * WORDS.length)];
    if (word === previous && WORDS.length > 1) {
      word = WORDS[(WORDS.indexOf(word) + 1) % WORDS.length];
    }
    picked.push(word);
    previous = word;
  }
  return picked.join(' ');
}

export function parsePracticeSeconds(value, fallback = DEFAULT_PRACTICE_SECONDS) {
  const n = Number.parseInt(value, 10);
  return PRACTICE_DURATIONS.includes(n) ? n : fallback;
}

export { WORDS };
