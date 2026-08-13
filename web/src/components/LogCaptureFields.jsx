import React from 'react';
import { DELAY_TYPES } from '../lib/logCapture.js';

function YesNo({ id, label, value, onChange }) {
  return (
    <div className="c-capture-row">
      <p className="c-label" id={`${id}-label`}>{label}</p>
      <div className="c-yesno" role="group" aria-labelledby={`${id}-label`}>
        <button
          type="button"
          className={value === true ? 'c-yesno-btn on' : 'c-yesno-btn'}
          aria-pressed={value === true}
          onClick={() => onChange(true)}
        >
          Yes
        </button>
        <button
          type="button"
          className={value === false ? 'c-yesno-btn on' : 'c-yesno-btn'}
          aria-pressed={value === false}
          onClick={() => onChange(false)}
        >
          No
        </button>
      </div>
    </div>
  );
}

/** Yes/No capture block shared by the Log form and clock-out sheet. */
export default function LogCaptureFields({ idPrefix, capture, onChange }) {
  const set = (patch) => onChange({ ...capture, ...patch });
  const pid = (name) => `${idPrefix}-${name}`;

  return (
    <div className="c-capture">
      <YesNo
        id={pid('materials')}
        label="Materials pickup or delivery today?"
        value={capture.materials}
        onChange={(materials) => set({ materials })}
      />
      {capture.materials && (
        <p className="c-check-hint">Add pick-ticket photos and tag them Materials if you have them.</p>
      )}

      <YesNo
        id={pid('delays')}
        label="Delays today?"
        value={capture.delays}
        onChange={(delays) => set({ delays, delayType: delays ? capture.delayType : '' })}
      />
      {capture.delays && (
        <div className="c-field">
          <label className="c-label" htmlFor={pid('delay-type')}>What caused the delay?</label>
          <select
            id={pid('delay-type')}
            className="c-input"
            value={capture.delayType}
            onChange={(e) => set({ delayType: e.target.value })}
          >
            <option value="">Select…</option>
            {DELAY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      )}

      <YesNo
        id={pid('safety-concerns')}
        label="Safety concerns?"
        value={capture.safetyConcerns}
        onChange={(safetyConcerns) => set({ safetyConcerns, safetyConcernsText: safetyConcerns ? capture.safetyConcernsText : '' })}
      />
      {capture.safetyConcerns && (
        <div className="c-field">
          <label className="c-label" htmlFor={pid('safety-concerns-text')}>Describe the safety concern</label>
          <textarea
            id={pid('safety-concerns-text')}
            className="c-input"
            rows={3}
            placeholder="What is unsafe, who is affected, what needs to change…"
            value={capture.safetyConcernsText}
            onChange={(e) => set({ safetyConcernsText: e.target.value })}
          />
        </div>
      )}

      <YesNo
        id={pid('safety-incident')}
        label="Safety incident?"
        value={capture.safetyIncident}
        onChange={(safetyIncident) => set({ safetyIncident, safetyIncidentText: safetyIncident ? capture.safetyIncidentText : '' })}
      />
      {capture.safetyIncident && (
        <div className="c-field">
          <label className="c-label" htmlFor={pid('safety-incident-text')}>Describe the safety incident</label>
          <textarea
            id={pid('safety-incident-text')}
            className="c-input"
            rows={3}
            placeholder="What happened, when, who was involved…"
            value={capture.safetyIncidentText}
            onChange={(e) => set({ safetyIncidentText: e.target.value })}
          />
        </div>
      )}

      <YesNo
        id={pid('work-concerns')}
        label="Work concerns? (issues that need a solution — not safety)"
        value={capture.workConcerns}
        onChange={(workConcerns) => set({ workConcerns, workConcernsText: workConcerns ? capture.workConcernsText : '' })}
      />
      {capture.workConcerns && (
        <div className="c-field">
          <label className="c-label" htmlFor={pid('work-concerns-text')}>What needs a solution?</label>
          <textarea
            id={pid('work-concerns-text')}
            className="c-input"
            rows={3}
            placeholder="Scope gap, sequencing, quality, coordination…"
            value={capture.workConcernsText}
            onChange={(e) => set({ workConcernsText: e.target.value })}
          />
        </div>
      )}

      <label className="c-check">
        <input
          type="checkbox"
          checked={capture.complete}
          onChange={(e) => set({ complete: e.target.checked })}
        />
        ✅ Work complete
      </label>
      {capture.complete && (
        <p className="c-check-hint">Remember a photo tagged &quot;Completion&quot; if you have one.</p>
      )}
    </div>
  );
}
