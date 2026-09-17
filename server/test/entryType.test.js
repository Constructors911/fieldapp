import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTimeEntryType } from '../src/util/entryType.js';

test('uses the requested type when the user has it', () => {
  assert.equal(pickTimeEntryType('Overtime', ['Regular', 'Overtime']), 'Overtime');
  assert.equal(pickTimeEntryType('overtime', ['Regular', 'Overtime']), 'Overtime');
});

test('falls back to Regular when stored Standard is not on the user', () => {
  assert.equal(pickTimeEntryType('Standard', ['Regular', 'Overtime']), 'Regular');
  assert.equal(pickTimeEntryType('', ['Regular', 'Overtime']), 'Regular');
  assert.equal(pickTimeEntryType(undefined, ['Regular', 'Overtime']), 'Regular');
});

test('keeps Standard when that is actually one of their types', () => {
  assert.equal(pickTimeEntryType('Standard', ['Standard', 'Overtime']), 'Standard');
});

test('uses the first allowed type when no preferred name matches', () => {
  assert.equal(pickTimeEntryType('Standard', ['Shop Time', 'Travel']), 'Shop Time');
});

test('returns null when the user has no types', () => {
  assert.equal(pickTimeEntryType('Standard', []), null);
  assert.equal(pickTimeEntryType('Standard', undefined), null);
});
