// Daily-log composer: turns the crew's plain-text notes into a clean
// bullet-point log via Claude Haiku (ANTHROPIC_API_KEY), with a deterministic
// fallback so logs never depend on the model being reachable.
// Safety text is NEVER sent to the model — appended verbatim after polish.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

export const DELAY_TYPES = ['Weather', 'Materials', 'Labor', 'Inspection', 'Access/Site', 'Other'];

function bullets(text) {
  return String(text || '')
    .split(/\n+|(?:^|\s)[;•·]\s*/)
    .map((s) => s.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)
    .map((s) => `• ${s.charAt(0).toUpperCase()}${s.slice(1)}`)
    .join('\n');
}

function photoLine(photoTags = {}) {
  const parts = Object.entries(photoTags)
    .filter(([, n]) => n > 0)
    .map(([tag, n]) => `${n} ${tag}`);
  return parts.length ? `📷 Photos: ${parts.join(' · ')}` : '';
}

/** Safety copy is verbatim — no spelling/grammar pass. */
export function safetySections(input) {
  const blocks = [];
  const incident = String(input.safetyIncidentText || '').trim();
  const concern = String(input.safetyConcernsText || '').trim();
  if (input.safetyIncident && incident) blocks.push(`🚨 Safety incident:\n${incident}`);
  if (input.safetyConcerns && concern) blocks.push(`🦺 Safety concerns:\n${concern}`);
  return blocks.join('\n\n');
}

function opsSections(input) {
  const blocks = [];
  if (input.workConcerns && String(input.workConcernsText || '').trim()) {
    blocks.push(`⚠️ Work concerns:\n${bullets(input.workConcernsText)}`);
  }
  if (input.delays && input.delayType) blocks.push(`⏱ Delay: ${input.delayType}`);
  if (input.materials) blocks.push('📦 Materials received');
  return blocks.join('\n\n');
}

/** Capture sections we always keep out of Haiku and stamp ourselves. */
export function captureBlocks(input) {
  return [
    safetySections(input),
    opsSections(input),
    input.complete ? '✅ WORK COMPLETE' : '',
  ].filter(Boolean).join('\n\n');
}

/** Rebuild the Yes/No capture object from a stored compose payload. */
export function captureFromRaw(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = ['materials', 'delays', 'safetyConcerns', 'safetyIncident', 'workConcerns', 'complete'];
  if (!keys.some((k) => typeof raw[k] === 'boolean')) return null;
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    materials: raw.materials,
    delays: raw.delays,
    delayType: str(raw.delayType),
    safetyConcerns: raw.safetyConcerns,
    safetyConcernsText: str(raw.safetyConcernsText),
    safetyIncident: raw.safetyIncident,
    safetyIncidentText: str(raw.safetyIncidentText),
    workConcerns: raw.workConcerns,
    workConcernsText: str(raw.workConcernsText),
    complete: raw.complete,
    done: str(raw.done),
    needed: str(raw.needed),
    notes: str(raw.notes),
  };
}

/** Deterministic formatting — also the shape we ask Haiku to produce. */
export function fallbackCompose(input) {
  const {
    done, needed, notes, photoTags, tasksCompleted, tasksRemaining,
  } = input;
  const sections = [
    captureBlocks(input),
    done || notes ? `✅ Completed:\n${bullets(done || notes)}` : '',
    tasksCompleted?.length ? `☑ Tasks checked off:\n${tasksCompleted.map((t) => `• ${t}`).join('\n')}` : '',
    tasksRemaining?.length ? `◻ Tasks still open:\n${tasksRemaining.map((t) => `• ${t}`).join('\n')}` : '',
    needed ? `🔲 Still needed:\n${bullets(needed)}` : '',
    photoLine(photoTags),
  ];
  return sections.filter(Boolean).join('\n\n');
}

export async function composeLogNotes(input, env = process.env) {
  const fallback = fallbackCompose(input);
  const apiKey = env.ANTHROPIC_API_KEY;
  const stamped = captureBlocks(input);
  if (!apiKey) return fallback;

  const raw = JSON.stringify({
    what_got_done: input.done || input.notes || '',
    still_needed: input.needed || '',
    tasks_checked_off: input.tasksCompleted || [],
    tasks_still_open: input.tasksRemaining || [],
    photos_attached: input.photoTags || {},
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: [
          'You rewrite construction crew daily-log notes into a clean, scannable log for the office.',
          'Rules: keep EVERY fact; never invent, embellish, or omit anything the crew wrote; fix spelling and grammar; keep trade jargon as-is.',
          'Do not mention safety, delays, materials, work concerns, or work-complete — those are appended separately.',
          'Output format (skip any empty section, no preamble, no code fences):',
          '✅ Completed:',
          '• one short bullet per distinct item',
          '☑ Tasks checked off:',
          '• task name   (only if tasks_checked_off is non-empty; copy names verbatim)',
          '◻ Tasks still open:',
          '• task name   (only if tasks_still_open is non-empty; copy names verbatim)',
          '🔲 Still needed:',
          '• one short bullet per distinct item',
          '📷 Photos: N Tag · N Tag   (only if photos_attached is non-empty)',
        ].join('\n'),
        messages: [{ role: 'user', content: raw }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return fallback;
    const data = await res.json();
    const text = data?.content?.find((c) => c.type === 'text')?.text?.trim();
    if (!text || text.length < 10) return fallback;
    return [stamped, text].filter(Boolean).join('\n\n');
  } catch {
    return fallback;
  }
}
