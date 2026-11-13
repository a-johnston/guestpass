import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFrom } from '../js/api.js';

test('vision from the model entry wins over /props', () => {
  const caps = capabilitiesFrom({ inputModalities: ['text'] }, { modalities: { vision: true } });
  assert.equal(caps.vision, false);
});

test('vision falls back to /props modalities, else unknown', () => {
  assert.equal(capabilitiesFrom({ inputModalities: null }, { modalities: { vision: true } }).vision, true);
  assert.equal(capabilitiesFrom({ inputModalities: null }, null).vision, null);
});

test('documents and basalt come from props.basalt', () => {
  const caps = capabilitiesFrom({}, { basalt: { version: '0.3.3', capabilities: ['answer_now', 'documents'] } });
  assert.deepEqual([caps.documents, caps.basalt], [true, true]);
  assert.deepEqual([capabilitiesFrom({}, {}).documents, capabilitiesFrom({}, {}).basalt], [false, false]);
});

test('context length: model entry, then props n_ctx', () => {
  assert.equal(capabilitiesFrom({ contextLength: 4096 }, { default_generation_settings: { n_ctx: 8192 } }).contextLength, 4096);
  assert.equal(capabilitiesFrom({ contextLength: null }, { default_generation_settings: { n_ctx: 8192 } }).contextLength, 8192);
});
