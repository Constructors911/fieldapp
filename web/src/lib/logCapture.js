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

export function captureDisplayRows(c) {
  if (!c) return [];
  const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : null);
  const rows = [];
  const materials = yn(c.materials);
  if (materials) rows.push(['Materials', materials]);
  const delays = yn(c.delays);
  if (delays) rows.push(['Delays', c.delays && c.delayType ? c.delayType : delays]);
  const safetyC = yn(c.safetyConcerns);
  if (safetyC) {
    rows.push(['Safety concerns', safetyC]);
    if (c.safetyConcerns && String(c.safetyConcernsText || '').trim()) {
      rows.push(['Safety concerns detail', c.safetyConcernsText.trim()]);
    }
  }
  const safetyI = yn(c.safetyIncident);
  if (safetyI) {
    rows.push(['Safety incident', safetyI]);
    if (c.safetyIncident && String(c.safetyIncidentText || '').trim()) {
      rows.push(['Safety incident detail', c.safetyIncidentText.trim()]);
    }
  }
  const work = yn(c.workConcerns);
  if (work) {
    rows.push(['Work concerns', work]);
    if (c.workConcerns && String(c.workConcernsText || '').trim()) {
      rows.push(['Work concerns detail', c.workConcernsText.trim()]);
    }
  }
  const complete = yn(c.complete);
  if (complete) rows.push(['Work complete', complete]);
  return rows;
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
