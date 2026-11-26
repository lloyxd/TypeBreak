import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePracticeText,
  parsePracticeSeconds,
  PRACTICE_DURATIONS,
  DEFAULT_PRACTICE_SECONDS,
  WORDS,
} from '../web/core/words.js';

describe('generatePracticeText', () => {
  test('joins the requested number of words', () => {
    const text = generatePracticeText({ wordCount: 12, random: () => 0 });
    assert.equal(text.split(' ').length, 12);
  });

  test('only uses the frozen bank', () => {
    const text = generatePracticeText({ wordCount: 40, random: () => 0.5 });
    for (const word of text.split(' ')) {
      assert.equal(WORDS.includes(word), true, word);
    }
  });

  test('refuses an empty drill', () => {
    assert.throws(() => generatePracticeText({ wordCount: 0 }));
  });
});

describe('parsePracticeSeconds', () => {
  test('accepts the advertised durations', () => {
    for (const value of PRACTICE_DURATIONS) {
      assert.equal(parsePracticeSeconds(String(value)), value);
    }
  });

  test('falls back when the query is junk', () => {
    assert.equal(parsePracticeSeconds('99'), DEFAULT_PRACTICE_SECONDS);
    assert.equal(parsePracticeSeconds(null), DEFAULT_PRACTICE_SECONDS);
  });
});
