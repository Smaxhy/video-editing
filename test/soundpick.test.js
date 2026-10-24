import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trackFromText } from '../src/soundpick.js';

const tracks = [
  { id: 'a', name: 'My Summer Song.m4a', createdAt: 1, heard: '117 BPM · high energy · genre: pop / house · mood: happy, energetic' },
  { id: 'b', name: 'dark-phonk-drift (sound).m4a', createdAt: 5, heard: '140 BPM · high energy · genre: phonk · mood: aggressive, dark' },
  { id: 'c', name: 'Rainy Lofi.mp3', createdAt: 3, heard: '80 BPM · low energy · genre: lo-fi · mood: calm' },
];

test('finds the sound the user names, describes or means', () => {
  assert.equal(trackFromText('put my summer song under this vid', tracks).id, 'a');
  assert.equal(trackFromText('Use "Rainy Lofi" and cut to it', tracks).id, 'c');
  assert.equal(trackFromText('add the phonk drift sound', tracks).id, 'b');
  assert.equal(trackFromText('add the sound i imported last', tracks).id, 'b');
  assert.equal(trackFromText('something calm music please', tracks).id, 'c');
  assert.equal(trackFromText('make the captions bigger', tracks), null);
  assert.equal(trackFromText('', tracks), null);
  assert.equal(trackFromText('use my summer song', []), null);
});
