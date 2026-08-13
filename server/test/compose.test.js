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

test('fallbackCompose stamps delays, materials, and work concerns', () => {
  const notes = fallbackCompose({
    done: 'framed walls',
    materials: true,
    delays: true,
    delayType: 'Weather',
    workConcerns: true,
    workConcernsText: 'need engineer on the beam pocket',
  });
  assert.match(notes, /⏱ Delay: Weather/);
  assert.match(notes, /📦 Materials received/);
  assert.match(notes, /⚠️ Work concerns:/);
  assert.match(notes, /Need engineer on the beam pocket/);
  assert.doesNotMatch(notes, /CONCERNS FLAGGED/);
});

test('safety text is copied verbatim — not bullet-rewritten', () => {
  const raw = 'Foreman slipped on wet OSB. No injury. Ice melt at stair.';
  const notes = fallbackCompose({
    done: 'sheathed east',
    safetyIncident: true,
    safetyIncidentText: raw,
    safetyConcerns: true,
    safetyConcernsText: 'Open stair well, no rail yet.',
  });
  assert.match(notes, /🚨 Safety incident:\nForeman slipped on wet OSB\. No injury\. Ice melt at stair\./);
  assert.match(notes, /🦺 Safety concerns:\nOpen stair well, no rail yet\./);
});
