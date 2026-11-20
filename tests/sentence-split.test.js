const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSentences, splitParagraphs, mergePunctuationParas, isPureUrl } = require('../sentence-split.js');

test('splits CJK sentences on ！？。', () => {
  assert.deepEqual(splitSentences('你好。世界！你好吗？我没事。'), ['你好。', '世界！', '你好吗？', '我没事。']);
});

test('splits Latin sentences on . ! ? followed by whitespace/word boundary', () => {
  assert.deepEqual(splitSentences('Hello world. Bye now. Done!')
    .map((s) => s.trim()), ['Hello world.', 'Bye now.', 'Done!']);
});

test('protects URLs from splitting', () => {
  const sents = splitSentences('See https://x.com/a/b. Then end.');
  assert.ok(sents.some((s) => s.includes('https://x.com/a/b')));
});

test('protects decimal points inside numbers', () => {
  const sents = splitSentences('The value is 3.14. It is close.');
  assert.ok(!sents.some((s) => s.startsWith('14.')));
});

test('splitParagraphs splits on newlines and mergePunctuationParas merges punctuation tails', () => {
  assert.deepEqual(splitParagraphs('a\n\nb'), ['a', 'b']);
  assert.deepEqual(splitParagraphs('a\n\n   \nb'), ['a', 'b']);
  assert.deepEqual(mergePunctuationParas(['a', '！', 'b']), ['a！', 'b']);
  assert.deepEqual(mergePunctuationParas(['！']), ['！']);
});

test('isPureUrl detects standalone URLs', () => {
  assert.equal(isPureUrl('https://x.com'), true);
  assert.equal(isPureUrl('hi there'), false);
});
