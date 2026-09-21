import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJobLabel, jobLabel } from '../src/util/jobLabel.js';

test('prefixes a raw JobTread name once', () => {
  assert.equal(formatJobLabel('12056', 'Wildhorse Village Condo'), '12056 · Wildhorse Village Condo');
});

test('does not prefix when the name already starts with the number', () => {
  assert.equal(formatJobLabel('12056', '12056 · Wildhorse Village Condo'), '12056 · Wildhorse Village Condo');
  assert.equal(formatJobLabel('12056', '12056 - Wildhorse Village Condo'), '12056 - Wildhorse Village Condo');
  assert.equal(formatJobLabel('12056', '12056 Wildhorse Village Condo'), '12056 Wildhorse Village Condo');
});

test('jobLabel uses the composed name from bootstrap without doubling', () => {
  assert.equal(jobLabel({
    number: '12056',
    name: '12056 · Wildhorse Village Condo',
  }), '12056 · Wildhorse Village Condo');
});

test('falls back to name or number when the other is missing', () => {
  assert.equal(formatJobLabel('', 'Maplewood Kitchen Remodel'), 'Maplewood Kitchen Remodel');
  assert.equal(formatJobLabel('12056', ''), '12056');
  assert.equal(jobLabel(null), '');
});
