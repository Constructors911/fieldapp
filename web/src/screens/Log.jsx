import React, { useState, useEffect, useCallback } from 'react';
import { getLogs, createLog, getFileTags, getCompanyCamStatus } from '../api.js';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import PickerSheet from '../components/PickerSheet.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import PhotoAttach, { requiredTagError, preparePhotos } from '../components/PhotoAttach.jsx';
import { todayISO, parseISODate, fmtMonthDay } from '../lib/dates.js';
import '../lib/screens.css';

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
  // Photos: manual {key, file, url, tagId} | CompanyCam {key, fileId, url, tagId, cc: true}
  const [photos, setPhotos] = useState([]);
  const [hasConcerns, setHasConcerns] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null); // {type: 'ok'|'queued'|'err', text}

  // --- photo tags (JobTread's org file tags) + CompanyCam availability ---
  const [tags, setTags] = useState([]);
  const [ccAvailable, setCcAvailable] = useState(false);
  useEffect(() => { getFileTags().then((r) => setTags(r.tags || [])).catch(() => {}); }, []);
  useEffect(() => { getCompanyCamStatus().then((r) => setCcAvailable(r.configured)).catch(() => {}); }, []);

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

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    if (!jobId) { setMsg({ type: 'err', text: 'Pick a job first.' }); return; }
    if (!date) { setMsg({ type: 'err', text: 'Pick a date first.' }); return; }
    if (!notes.trim() && photos.length === 0) {
      setMsg({ type: 'err', text: 'Add some notes or a photo before submitting.' });
      return;
    }
    // Checked boxes make their tagged photos mandatory.
    const required = [hasConcerns && 'Concerns', isComplete && 'Completion'].filter(Boolean);
    const tagErr = requiredTagError(photos, tags, required);
    if (tagErr) { setMsg({ type: 'err', text: tagErr }); return; }

    setSubmitting(true);
    setMsg(null);

    const { fileIds, fileTagsMap, skipped } = await preparePhotos(photos);
    if (skipped > 0 && (hasConcerns || isComplete)) {
      // Required photos can't silently vanish into the offline gap.
      setMsg({ type: 'err', text: 'Some photos could not upload — required photos need a connection. Try again when back online.' });
      setSubmitting(false);
      return;
    }

    try {
      // Server composes the final notes (Haiku bullet cleanup with fallback).
      const photoTagCounts = {};
      for (const p of photos) {
        const nm = p.tagId && tags.find((t) => t.id === p.tagId)?.name;
        if (nm) photoTagCounts[nm] = (photoTagCounts[nm] || 0) + 1;
      }
      const res = await createLog({
        jobId,
        date,
        fileIds,
        fileTags: fileTagsMap,
        compose: {
          notes: notes.trim(),
          concerns: hasConcerns,
          complete: isComplete,
          photoTags: photoTagCounts,
        },
      });
      photos.forEach((p) => { if (p.file) URL.revokeObjectURL(p.url); });
      setPhotos([]);
      setNotes('');
      setHasConcerns(false);
      setIsComplete(false);
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

          <div className="c9-field c9-checkrow">
            <label className="c9-check">
              <input type="checkbox" checked={hasConcerns} onChange={(e) => setHasConcerns(e.target.checked)} />
              ⚠️ Concerns to report
            </label>
            <label className="c9-check">
              <input type="checkbox" checked={isComplete} onChange={(e) => setIsComplete(e.target.checked)} />
              ✅ Work complete
            </label>
          </div>
          {(hasConcerns || isComplete) && (
            <p className="c9-check-hint">
              Photos tagged {[hasConcerns && '"Concerns"', isComplete && '"Completion"'].filter(Boolean).join(' and ')} are required.
            </p>
          )}

          <div className="c9-field">
            <span className="c9-label">Photos</span>
            <PhotoAttach
              jobId={jobId}
              photos={photos}
              setPhotos={setPhotos}
              tags={tags}
              ccAvailable={ccAvailable}
              onError={(text) => setMsg({ type: 'err', text })}
            />
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
