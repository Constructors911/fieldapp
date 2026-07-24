import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackCompose } from '../src/compose.js';

test('fallbackCompose includes completed and remaining tasks', () => {
  const notes = fallbackCompose({
    done: 'dried in north',
    tasksCompleted: ['Install upper cabinets', 'Order cabinet hardware pulls'],
    tasksRemaining: ['Paint first coat - suites 210-214'],
  });
  assert.match(notes, /☑ Tasks checked off:\n• Install upper cabinets\n• Order cabinet hardware pulls/);
  assert.match(notes, /◻ Tasks still open:\n• Paint first coat - suites 210-214/);
  assert.match(notes, /✅ Completed:\n• Dried in north/);
});
