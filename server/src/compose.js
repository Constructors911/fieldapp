// Daily-log composer: turns the crew's plain-text notes into a clean
// bullet-point log via Claude Haiku (ANTHROPIC_API_KEY), with a deterministic
// fallback so logs never depend on the model being reachable.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

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

/** Deterministic formatting — also the shape we ask Haiku to produce. */
export function fallbackCompose({ done, needed, notes, concerns, complete, photoTags, tasksCompleted }) {
  const sections = [
    concerns ? '⚠️ CONCERNS FLAGGED' : '',
    complete ? '✅ WORK COMPLETE' : '',
    done || notes ? `✅ Completed:\n${bullets(done || notes)}` : '',
    tasksCompleted?.length ? `☑ Tasks checked off:\n${tasksCompleted.map((t) => `• ${t}`).join('\n')}` : '',
    needed ? `🔲 Still needed:\n${bullets(needed)}` : '',
    photoLine(photoTags),
  ];
  return sections.filter(Boolean).join('\n\n');
}

export async function composeLogNotes(input, env = process.env) {
  const fallback = fallbackCompose(input);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback;

  const raw = JSON.stringify({
    what_got_done: input.done || input.notes || '',
    still_needed: input.needed || '',
    concerns_flagged: Boolean(input.concerns),
    work_complete: Boolean(input.complete),
    tasks_checked_off: input.tasksCompleted || [],
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
          'Output format (skip any empty section, no preamble, no code fences):',
          '⚠️ CONCERNS FLAGGED   (only if concerns_flagged)',
          '✅ WORK COMPLETE   (only if work_complete)',
          '✅ Completed:',
          '• one short bullet per distinct item',
          '☑ Tasks checked off:',
          '• task name   (only if tasks_checked_off is non-empty; copy names verbatim)',
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
    // Sanity: the model must not shrink the log to nothing.
    return text && text.length >= 10 ? text : fallback;
  } catch {
    return fallback;
  }
}
