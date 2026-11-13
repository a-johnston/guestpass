import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithin, imageTokens, classifyFile, looksLikeText, pickImageMime, formatBytes, MAX_IMAGE_PIXELS, IMAGE_QUALITY } from '../js/media.js';

test('formatBytes', () => {
  assert.deepEqual([950, 55_000, 1_900_000].map(formatBytes), ['950 B', '54 KB', '1.8 MB']);
});

test('limits from the spec', () => {
  assert.equal(MAX_IMAGE_PIXELS, 1024 * 1024);
  assert.equal(IMAGE_QUALITY, 0.25);
});

test('fitWithin caps pixels and never upscales', () => {
  assert.deepEqual(fitWithin(4000, 3000), { width: 1182, height: 886 });
  assert.deepEqual(fitWithin(640, 480), { width: 640, height: 480 });
  assert.deepEqual(fitWithin(10_000_000, 1), { width: 3238172, height: 1 }, 'a side never rounds down to 0');
});

test('imageTokens follows 32 px tiles within 8..4096', () => {
  assert.equal(imageTokens(128, 128), 16);
  assert.equal(imageTokens(1182, 886), 37 * 28);
  assert.equal(imageTokens(10, 10), 8);
  assert.equal(imageTokens(4000, 4000), 4096);
});

test('classifyFile', () => {
  const caps = { vision: true, documents: true };
  assert.deepEqual(classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: 9 }, caps), { kind: 'image' });
  assert.deepEqual(classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: 9 }, { ...caps, vision: false }), { error: "This model can't see images." });
  assert.deepEqual(classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: 9 }, { ...caps, vision: null }), { kind: 'image' });
  assert.deepEqual(classifyFile({ name: 'logo.svg', type: 'image/svg+xml', size: 9 }, caps), { kind: 'text' });
  assert.deepEqual(classifyFile({ name: 'clip.mp4', type: 'video/mp4', size: 9 }, caps), { error: "Video isn't supported yet." });
  assert.deepEqual(classifyFile({ name: 'clip.MOV', type: '', size: 9 }, caps), { error: "Video isn't supported yet." });
  assert.deepEqual(classifyFile({ name: 'p.pdf', type: 'application/pdf', size: 9 }, caps), { kind: 'document' });
  assert.deepEqual(classifyFile({ name: 'p.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 }, caps), { error: "Files over 10 MB aren't supported." });
  assert.deepEqual(classifyFile({ name: 'p.pdf', type: 'application/pdf', size: 9 }, { ...caps, documents: false }), { error: "This server can't read PDF or Office files." });
  assert.deepEqual(classifyFile({ name: 'deck.pptx', type: '', size: 9 }, caps), { kind: 'document' });
  assert.deepEqual(classifyFile({ name: 'x.ts', type: 'video/mp2t', size: 9 }, caps), { kind: 'text' }, '.ts is TypeScript, not video');
  assert.deepEqual(classifyFile({ name: 'notes.md', type: 'text/markdown', size: 9 }, caps), { kind: 'text' });
});

test('classifyFile rejects oversized would-be text files by size, before anything is read', () => {
  const huge = { name: 'disk.iso', type: 'application/x-iso9660-image', size: 4 * 1024 ** 3 };
  assert.deepEqual(classifyFile(huge, { vision: true, documents: true }), { error: "Files over 10 MB aren't supported." });
  assert.deepEqual(classifyFile({ name: 'log.txt', type: 'text/plain', size: 200 * 1024 }, { vision: true, documents: false }),
    { error: "Text files over 100 KB can't be attached to this server." });
  assert.deepEqual(classifyFile({ name: 'log.txt', type: 'text/plain', size: 200 * 1024 }, { vision: true, documents: true }), { kind: 'text' });
});

test('looksLikeText', () => {
  assert.equal(looksLikeText(new TextEncoder().encode('héllo')), true);
  assert.equal(looksLikeText(new Uint8Array([0x68, 0x00, 0x69])), false);
  assert.equal(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41])), false);
});

test('pickImageMime', () => {
  assert.equal(pickImageMime({ basalt: true, canWebp: true }), 'image/webp');
  assert.equal(pickImageMime({ basalt: true, canWebp: false }), 'image/jpeg');
  assert.equal(pickImageMime({ basalt: false, canWebp: true }), 'image/jpeg');
});
