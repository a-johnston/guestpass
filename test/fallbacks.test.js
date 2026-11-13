import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackFor } from '../js/fallbacks.js';

const allOn = () => true;
const err = (status, message) => Object.assign(new Error(message), { status });
const IMAGES = { images: true, toolImages: false, files: false };
const TOOL_IMAGES = { images: true, toolImages: true, files: false };
const FILES = { images: false, toolImages: false, files: true };
const NONE = { images: false, toolImages: false, files: false };

test('media rejections switch off the matching feature', () => {
  assert.equal(fallbackFor(err(400, 'image input is not supported by this model'), IMAGES, allOn)?.key, 'vision');
  assert.equal(fallbackFor(err(400, 'tool message content must be a string'), TOOL_IMAGES, allOn)?.key, 'toolImages');
  assert.equal(fallbackFor(err(400, 'unsupported content part type: file'), FILES, allOn)?.key, 'documents');
});

test('a media fallback needs the request to have carried that media', () => {
  assert.equal(fallbackFor(err(400, 'image input is not supported'), NONE, allOn), null);
});

test('proxy error pages never switch media off', () => {
  const page = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>502 Bad Gateway</title></head><body>image</body></html>';
  assert.equal(fallbackFor(err(502, page), { images: true, toolImages: true, files: true }, allOn), null);
  assert.equal(fallbackFor(err(400, page), { images: true, toolImages: true, files: true }, allOn), null);
});

test('server errors and context overflows never switch media off', () => {
  assert.equal(fallbackFor(err(500, 'CUDA out of memory while encoding the image'), IMAGES, allOn), null);
  assert.equal(fallbackFor(err(400, 'the request (140000 tokens with images) exceeds the context size 131072'), IMAGES, allOn), null);
  assert.equal(fallbackFor(err(413, 'request entity too large'), FILES, allOn), null);
});

test('existing fallbacks still match as before', () => {
  assert.equal(fallbackFor(err(500, 'tools param requires --jinja flag'), NONE, allOn)?.key, 'toolsSupported');
  assert.equal(fallbackFor(err(400, 'unsupported field: reasoning_content'), NONE, allOn)?.key, 'sendReasoning');
  assert.equal(fallbackFor(err(400, 'unknown field stream_options'), NONE, allOn)?.key, 'requestUsage');
});

test('a feature already off is skipped', () => {
  assert.equal(fallbackFor(err(400, 'image input is not supported'), IMAGES, (f) => f.key !== 'vision'), null);
});

test('network errors (no status) never fall back', () => {
  assert.equal(fallbackFor(new Error('image'), IMAGES, allOn), null);
});
