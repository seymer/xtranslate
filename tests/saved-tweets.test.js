const test = require('node:test');
const assert = require('node:assert/strict');
const savedTweets = require('../saved-tweets.js');

test('saving the same tweet does not create duplicates or reset review progress', () => {
  const original = {
    id: '123',
    text: 'Original text',
    savedAt: new Date(2026, 10, 20, 9).getTime(),
    reviewedOn: '2026-11-20',
    reviewCount: 2,
  };

  const result = savedTweets.upsert([original], {
    id: '123',
    text: 'Updated text',
    savedAt: new Date(2026, 10, 21, 9).getTime(),
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'Updated text');
  assert.equal(result[0].savedAt, original.savedAt);
  assert.equal(result[0].reviewedOn, original.reviewedOn);
  assert.equal(result[0].reviewCount, 2);
});

test('toggling a saved tweet removes it and reports the unsaved state', () => {
  const tweet = { id: '123', text: 'A tweet', savedAt: 1234 };
  const saved = savedTweets.toggle([], tweet);
  const removed = savedTweets.toggle(saved.items, tweet);

  assert.equal(saved.saved, true);
  assert.equal(saved.items.length, 1);
  assert.equal(removed.saved, false);
  assert.deepEqual(removed.items, []);
});

test('storage context invalidation is reported instead of escaping the safe reader', () => {
  const invalidation = new Error('Extension context invalidated.');
  let reportedError = null;
  let callbackCalled = false;

  const started = savedTweets.safeStorageGet({
    get() { throw invalidation; },
  }, { savedTweets: [] }, () => { callbackCalled = true; }, (error) => {
    reportedError = error;
  });

  assert.equal(started, false);
  assert.equal(callbackCalled, false);
  assert.equal(reportedError, invalidation);
});

test('a saved tweet is due until reviewed on the current local day', () => {
  const now = new Date(2026, 10, 20, 12).getTime();
  const items = [
    { id: '1', savedAt: now, reviewedOn: '2026-11-20' },
    { id: '2', savedAt: now, reviewedOn: '2026-11-19' },
  ];

  assert.deepEqual(savedTweets.dueToday(items, now).map((item) => item.id), ['2']);
});

test('marking reviewed increments progress and removes the tweet from today queue', () => {
  const now = new Date(2026, 10, 20, 12).getTime();
  const items = [{ id: '1', savedAt: now, reviewCount: 2 }];

  const result = savedTweets.markReviewed(items, '1', now);

  assert.equal(result[0].reviewCount, 3);
  assert.equal(result[0].reviewedOn, '2026-11-20');
  assert.deepEqual(savedTweets.dueToday(result, now), []);
});

test('marking the same tweet reviewed twice in one day does not inflate progress', () => {
  const now = new Date(2026, 10, 20, 12).getTime();
  const items = [{ id: '1', reviewedOn: '2026-11-20', reviewCount: 3 }];

  const result = savedTweets.markReviewed(items, '1', now);

  assert.equal(result[0].reviewCount, 3);
});

test('removing a saved tweet leaves all other tweets intact', () => {
  assert.deepEqual(
    savedTweets.remove([{ id: '1' }, { id: '2' }], '1'),
    [{ id: '2' }],
  );
});

test('corrupted stored data is treated as an empty list instead of crashing', () => {
  const now = new Date(2026, 10, 20, 12).getTime();
  const tweet = { id: '1', text: 'Tweet', savedAt: now };

  assert.equal(savedTweets.dueToday(null, now).length, 0);
  assert.deepEqual(savedTweets.markReviewed(undefined, '1', now), []);
  assert.deepEqual(savedTweets.remove(null, '1'), []);
  assert.deepEqual(savedTweets.upsert(undefined, tweet), [
    { ...tweet, reviewCount: 0, reviewedOn: null, lastReviewedAt: null },
  ]);
  assert.equal(savedTweets.toggle(null, tweet).saved, true);
});
