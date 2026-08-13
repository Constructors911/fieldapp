export const DELAY_TYPES = ['Weather', 'Materials', 'Labor', 'Inspection', 'Access/Site', 'Other'];

export function emptyLogCapture() {
  return {
    materials: false,
    delays: false,
    delayType: '',
    safetyConcerns: false,
    safetyConcernsText: '',
    safetyIncident: false,
    safetyIncidentText: '',
    workConcerns: false,
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

export function validateLogCapture(c) {
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
