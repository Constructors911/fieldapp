import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getLogs, createLog, uploadFile } from '../api.js';
import Card from '../components/Card.jsx';
import PickerSheet from '../components/PickerSheet.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { todayISO, parseISODate, fmtMonthDay } from '../lib/dates.js';
import '../lib/screens.css';

let nextPhotoKey = 1;

function weatherChip(w) {
  if (!w) return null;
  const temps = [w.minTemp, w.maxTemp].filter((t) => t !== undefined && t !== null);
  const range = temps.length === 2 ? `${w.minTemp}°–${w.maxTemp}°` : temps.length === 1 ? `${temps[0]}°` : '';
  return (
    <span className="c9-log-weather" title="Weather (from JobTread)">
      ⛅ {w.condition}{range ? ` · ${range}` : ''}
    </span>
  );
}

export default function Log({ boot }) {
  const jobs = boot?.jobs || [];

  // --- form state ---
  const [jobId, setJobId] = useState(jobs[0]?.id || '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState([]); // [{key, file, url}]
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null); // {type: 'ok'|'queued'|'err', text}
  const fileInputRef = useRef(null);

  // --- existing logs ---
  const [logs, setLogs] = useState(undefined); // undefined = loading, null = error
  const [logsErr, setLogsErr] = useState(null);

  const job = jobs.find((j) => j.id === jobId) || null;

  const loadLogs = useCallback(() => {
    if (!date) { setLogs([]); return; }
    setLogs(undefined);
    setLogsErr(null);
    getLogs(date, jobId || undefined)
      .then((r) => setLogs(r.logs || []))
      .catch((e) => { setLogsErr(e.message); setLogs(null); });
  }, [date, jobId]);

  useEffect(loadLogs, [loadLogs]);

  // Revoke any outstanding object URLs on unmount.
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  function addPhotos(e) {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      setPhotos((list) => [
        ...list,
        ...files.map((file) => ({ key: nextPhotoKey++, file, url: URL.createObjectURL(file) }))
      ]);
    }
    e.target.value = ''; // allow re-picking the same file
  }

  function removePhoto(key) {
    setPhotos((list) => {
      const p = list.find((x) => x.key === key);
      if (p) URL.revokeObjectURL(p.url);
      return list.filter((x) => x.key !== key);
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    if (!jobId) { setMsg({ type: 'err', text: 'Pick a job first.' }); return; }
    if (!date) { setMsg({ type: 'err', text: 'Pick a date first.' }); return; }
    if (!notes.trim() && photos.length === 0) {
      setMsg({ type: 'err', text: 'Add some notes or a photo before submitting.' });
      return;
    }
    setSubmitting(true);
    setMsg(null);

    // Upload photos first. Photos need connectivity — if we are offline (or an
    // upload dies mid-way), skip the rest and still queue the log itself.
    const fileIds = [];
    let skipped = 0;
    for (let i = 0; i < photos.length; i++) {
      if (navigator.onLine === false) { skipped = photos.length - i; break; }
      try {
        const up = await uploadFile(photos[i].file);
        fileIds.push(up.fileId);
      } catch {
        skipped = photos.length - i;
        break;
      }
    }

    try {
      const res = await createLog({ jobId, date, notes: notes.trim(), fileIds });
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      setPhotos([]);
      setNotes('');
      const photoNote = skipped > 0
        ? ` ${skipped} photo${skipped > 1 ? 's' : ''} skipped — photos need a connection, re-attach once you're back online.`
        : '';
      if (res.queued) {
        setMsg({ type: 'queued', text: `Log saved offline — it will sync automatically.${photoNote}` });
      } else {
        setMsg({ type: 'ok', text: `Log submitted.${photoNote}` });
        loadLogs();
      }
    } catch (err) {
      setMsg({ type: 'err', text: err.message || 'Could not submit log.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Card title="Daily log">
        <form onSubmit={submit}>
          <div className="c9-field">
            <label className="c9-label" htmlFor="log-job">Job</label>
            <button
              id="log-job"
              type="button"
              className="c9-input c9-jobbtn"
              onClick={() => setPickerOpen(true)}
              aria-haspopup="dialog"
            >
              {job ? (
                <span className="c9-jobbtn-text">
                  <span className="c9-jobbtn-name">{job.name}</span>
                  {job.location ? <span className="c9-jobbtn-sub">{job.location}</span> : null}
                </span>
              ) : (
                <span className="c9-jobbtn-placeholder">Select a job…</span>
              )}
              <span aria-hidden="true">▾</span>
            </button>
          </div>

          <div className="c9-field">
            <label className="c9-label" htmlFor="log-date">Date</label>
            <input
              id="log-date"
              className="c9-input"
              type="date"
              value={date}
              max={todayISO()}
              onChange={(e) => { setDate(e.target.value); setMsg(null); }}
            />
          </div>

          <div className="c9-field">
            <label className="c9-label" htmlFor="log-notes">Notes</label>
            <textarea
              id="log-notes"
              className="c9-textarea"
              placeholder="What happened on site today?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="c9-field">
            <span className="c9-label">Photos</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={addPhotos}
              style={{ display: 'none' }}
              aria-hidden="true"
              tabIndex={-1}
            />
            <button type="button" className="c9-btn c9-btn-ghost" onClick={() => fileInputRef.current?.click()}>
              📷 Add photos
            </button>
            {photos.length > 0 && (
              <div className="c9-thumbs">
                {photos.map((p) => (
                  <div key={p.key} className="c9-thumb">
                    <img src={p.url} alt={p.file.name || 'attached photo'} />
                    <button
                      type="button"
                      className="c9-thumb-x"
                      aria-label={`Remove ${p.file.name || 'photo'}`}
                      onClick={() => removePhoto(p.key)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {msg && <div className={`c9-msg c9-msg-${msg.type}`} role="status">{msg.text}</div>}

          <button type="submit" className="c9-btn c9-btn-primary" disabled={submitting || !jobId}>
            {submitting ? 'Submitting…' : 'Submit log'}
          </button>
        </form>
      </Card>

      <Card title={`Logs · ${date ? fmtMonthDay(parseISODate(date)) : '—'}`}>
        {logs === undefined && <Spinner label="Loading logs…" />}
        {logs === null && <ErrorBanner message={logsErr} onRetry={loadLogs} />}
        {Array.isArray(logs) && logs.length === 0 && (
          <EmptyState icon="📋" title="No logs yet" hint="Logs you submit for this job and date show up here." />
        )}
        {Array.isArray(logs) && logs.map((l) => (
          <div key={l.id} className="c9-log-item">
            <div className="c9-log-meta">
              <span className="c9-log-job">{l.jobName}</span>
              {weatherChip(l.weather)}
            </div>
            {l.notes && <p className="c9-log-notes">{l.notes}</p>}
            {l.files?.length > 0 && (
              <div className="c9-log-photos">
                {l.files.map((f) => (
                  <img key={f.id} src={f.url} alt={f.name || 'log photo'} loading="lazy" />
                ))}
              </div>
            )}
          </div>
        ))}
      </Card>

      <PickerSheet
        open={pickerOpen}
        title="Select job"
        onClose={() => setPickerOpen(false)}
        options={jobs.map((j) => ({ id: j.id, label: j.name, sub: j.location }))}
        onSelect={(opt) => { setJobId(opt.id); setMsg(null); setPickerOpen(false); }}
        emptyText="No jobs available."
      />
    </div>
  );
}
