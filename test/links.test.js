import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLinks } from '../src/links.js';

test('links are pulled out of pasted text, cleaned and de-duplicated', () => {
  const text = `check https://www.tiktok.com/@a/video/1, and
https://youtube.com/shorts/xyz). https://www.tiktok.com/@a/video/1
not a link: www.example.com`;
  assert.deepEqual(parseLinks(text), ['https://www.tiktok.com/@a/video/1', 'https://youtube.com/shorts/xyz']);
  assert.deepEqual(parseLinks(['https://a.b/c', 'https://a.b/c']), ['https://a.b/c']);
  assert.deepEqual(parseLinks(''), []);
});
