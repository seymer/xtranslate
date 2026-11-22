const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseKeyword, chooseKeywords, splitByKeywords, isCJK } = require('../keyword-mask.js');

test('chooseKeyword skips stopwords and picks a content word', () => {
  assert.equal(chooseKeyword('This app helps you learn languages faster.'), 'languages');
  assert.equal(chooseKeyword('A cat sat on the mat.'), 'cat');
});

test('chooseKeyword works for Chinese text', () => {
  assert.equal(chooseKeyword('这个功能很好用。'), '功能');
  assert.equal(isCJK('这个功能'), true);
  assert.equal(isCJK('hello'), false);
});

test('chooseKeywords picks one keyword per sentence', () => {
  assert.deepEqual(chooseKeywords('The cat sat. The dog ran.'), ['cat', 'dog']);
  assert.deepEqual(chooseKeywords('我喜欢学习。今天天气很好。'), ['喜欢', '天气']);
});

test('chooseKeywords ignores URLs and mentions', () => {
  assert.deepEqual(chooseKeywords('https://example.com/foo'), []);
  assert.deepEqual(chooseKeywords('@user'), []);
  assert.deepEqual(chooseKeywords('See https://example.com/foo for details.'), ['details']);
});

test('splitByKeywords marks matches case-insensitively', () => {
  const parts = splitByKeywords('Learning languages is fun. Learning daily.', ['learning', 'fun']);
  assert.deepEqual(
    parts.filter((part) => part.match).map((part) => part.text),
    ['Learning', 'fun', 'Learning'],
  );
});

test('splitByKeywords handles regex special characters safely', () => {
  const parts = splitByKeywords('Use C++ and .NET here.', ['C++', '.NET']);
  assert.deepEqual(
    parts.filter((part) => part.match).map((part) => part.text),
    ['C++', '.NET'],
  );
});
