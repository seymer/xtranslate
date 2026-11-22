const test = require('node:test');
const assert = require('node:assert/strict');

const enData = {
  run: { w: 'run', p: 'rʌn', t: 'v. 跑；经营 n. 奔跑', f: 812 },
  category: { w: 'category', p: 'ˈkætəɡəri', t: 'n. 类别；种类', f: 4200 },
  walk: { w: 'walk', p: 'wɔːk', t: 'v. 走；步行', f: 1500 },
};

global.chrome = {
  runtime: { getURL: (path) => 'chrome-extension://test/' + path },
};
global.fetch = async () => ({
  ok: true,
  json: async () => enData,
});

const dict = require('../dictionary.js');

test('lookup English word directly', async () => {
  const entry = await dict.lookup('run');
  assert.equal(entry.t.includes('跑'), true);
});

test('lookup falls back to a simple lemma', async () => {
  assert.equal((await dict.lookup('running')).w, 'run');
  assert.equal((await dict.lookup('categories')).w, 'category');
  assert.equal((await dict.lookup('walks')).w, 'walk');
});

test('format is compact: headword, translation and frequency on consecutive lines', () => {
  const text = dict.format(enData.run);
  assert.deepEqual(text.split('\n'), [
    'run  /rʌn/',
    'v. 跑；经营 n. 奔跑',
    '词频 812',
  ]);
});
