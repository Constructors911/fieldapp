export const DELAY_TYPES = ['Weather', 'Materials', 'Labor', 'Inspection', 'Access/Site', 'Other'];

const YES_NO = [
  ['materials', 'whether materials were picked up or delivered'],
  ['delays', 'whether there were delays'],
  ['safetyConcerns', 'whether there were safety concerns'],
  ['safetyIncident', 'whether there was a safety incident'],
  ['workConcerns', 'whether there were work concerns'],
];

export function emptyLogCapture() {
  return {
    materials: null,
    delays: null,
    delayType: '',
    safetyConcerns: null,
    safetyConcernsText: '',
    safetyIncident: null,
    safetyIncidentText: '',
    workConcerns: null,
    workConcernsText: '',
    complete: false,
  };
}

/** Fields sent in compose alongside done/needed/notes. */
export function captureToCompose(c) {
  return {
    materials: Boolean(c.materials),
    delays: Boolean(c.delays),
    delayType: c.delays ? (c.delayType || '') : '',
    safetyConcerns: Boolean(c.safetyConcerns),
    safetyConcernsText: c.safetyConcerns ? (c.safetyConcernsText || '') : '',
    safetyIncident: Boolean(c.safetyIncident),
    safetyIncidentText: c.safetyIncident ? (c.safetyIncidentText || '') : '',
    workConcerns: Boolean(c.workConcerns),
    workConcernsText: c.workConcerns ? (c.workConcernsText || '') : '',
    complete: Boolean(c.complete),
  };
}

export function photosHaveTag(photos, tags, name) {
  const needle = String(name).toLowerCase();
  return photos.some((p) => {
    const nm = p.tagId && tags.find((t) => t.id === p.tagId)?.name;
    if (!nm) return false;
    const n = String(nm).toLowerCase();
    return n === needle || n.startsWith(`${needle} `) || n.startsWith(`${needle}-`);
  });
}

export function captureHasContent(c) {
  return Boolean(
    c.materials
    || c.complete
    || (c.delays && c.delayType)
    || String(c.safetyConcernsText || '').trim()
    || String(c.safetyIncidentText || '').trim()
    || String(c.workConcernsText || '').trim()
  );
}

export function validateLogCapture(c) {
  for (const [key, label] of YES_NO) {
    if (c[key] !== true && c[key] !== false) return `Answer ${label}.`;
  }
  if (c.delays && !c.delayType) return 'Pick a delay type.';
  if (c.safetyConcerns && !String(c.safetyConcernsText || '').trim()) {
    return 'Describe the safety concern.';
  }
  if (c.safetyIncident && !String(c.safetyIncidentText || '').trim()) {
    return 'Describe the safety incident.';
  }
  if (c.workConcerns && !String(c.workConcernsText || '').trim()) {
    return 'Describe the work concern.';
  }
  return null;
}
