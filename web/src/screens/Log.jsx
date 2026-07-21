import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  getLogs, createLog, uploadFile, getFileTags,
  getCompanyCamStatus, getCompanyCamPhotos, importCompanyCamPhotos
} from '../api.js';
import Card from '../components/Card.jsx';
import Sheet from '../components/Sheet.jsx';
import Spinner from '../components/Spinner.jsx';
import PickerSheet from '../components/PickerSheet.jsx';
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
  // Photos: manual {key, file, url, tagId} | CompanyCam {key, fileId, url, tagId, cc: true}
  const [photos, setPhotos] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null); // {type: 'ok'|'queued'|'err', text}
  const fileInputRef = useRef(null);

  // --- photo tags (JobTread's org file tags) ---
  const [tags, setTags] = useState([]);
  useEffect(() => { getFileTags().then((r) => setTags(r.tags || [])).catch(() => {}); }, []);

  // --- CompanyCam ---
  const [ccAvailable, setCcAvailable] = useState(false);
  const [ccOpen, setCcOpen] = useState(false);
  const [ccPhotos, setCcPhotos] = useState(undefined); // undefined = loading
  const [ccProject, setCcProject] = useState(null);
  const [ccMine, setCcMine] = useState(false);
  const [ccSelected, setCcSelected] = useState(() => new Set());
  const [ccBusy, setCcBusy] = useState(false);
  useEffect(() => { getCompanyCamStatus().then((r) => setCcAvailable(r.configured)).catch(() => {}); }, []);

  async function openCompanyCam(mine = ccMine) {
    setCcOpen(true);
    setCcPhotos(undefined);
    setCcSelected(new Set());
    setCcMine(mine);
    try {
      const r = await getCompanyCamPhotos(jobId, { mine });
      setCcProject(r.project);
      setCcPhotos(r.photos || []);
    } catch (e) {
      setCcPhotos([]);
      setMsg({ type: 'err', text: e.message || 'Could not load CompanyCam photos.' });
    }
  }

  async function importSelected() {
    if (ccBusy || ccSelected.size === 0) return;
    setCcBusy(true);
    try {
      const r = await importCompanyCamPhotos([...ccSelected]);
      setPhotos((list) => [
        ...list,
        ...r.files.map((f) => ({ key: nextPhotoKey++, fileId: f.fileId, url: f.url, tagId: null, cc: true }))
      ]);
      setCcOpen(false);
    } catch (e) {
      setMsg({ type: 'err', text: e.message || 'CompanyCam import failed.' });
    } finally {
      setCcBusy(false);
    }
  }

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
        ...files.map((file) => ({ key: nextPhotoKey++, file, url: URL.createObjectURL(file), tagId: null }))
      ]);
    }
    e.target.value = ''; // allow re-picking the same file
  }

  function removePhoto(key) {
    setPhotos((list) => {
      const p = list.find((x) => x.key === key);
      if (p?.file) URL.revokeObjectURL(p.url); // CC imports use remote URLs
      return list.filter((x) => x.key !== key);
    });
  }

  function setPhotoTag(key, tagId) {
    setPhotos((list) => list.map((p) => (p.key === key ? { ...p, tagId: tagId || null } : p)));
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

    // Upload photos first (CompanyCam imports already have a fileId). Photos
    // need connectivity — if we are offline (or an upload dies mid-way), skip
    // the rest and still queue the log itself.
    const fileIds = [];
    const fileTagsMap = {};
    let skipped = 0;
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      let fid = p.fileId;
      if (!fid) {
        if (navigator.onLine === false) { skipped += 1; continue; }
        try {
          const up = await uploadFile(p.file);
          fid = up.fileId;
        } catch {
          skipped += 1;
          continue;
        }
      }
      fileIds.push(fid);
      if (p.tagId) fileTagsMap[fid] = [p.tagId];
    }

    try {
      const res = await createLog({ jobId, date, notes: notes.trim(), fileIds, fileTags: fileTagsMap });
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
            <div className="c9-photo-btns">
              <button type="button" className="c9-btn c9-btn-ghost" onClick={() => fileInputRef.current?.click()}>
                📷 Add photos
              </button>
              {ccAvailable && (
                <button type="button" className="c9-btn c9-btn-ghost" disabled={!jobId} onClick={() => openCompanyCam()}>
                  🗂 Pull from CompanyCam
                </button>
              )}
            </div>
            {photos.length > 0 && (
              <div className="c9-thumbs">
                {photos.map((p) => (
                  <div key={p.key} className="c9-thumb-wrap">
                    <div className="c9-thumb">
                      <img src={p.url} alt={p.file?.name || 'attached photo'} />
                      {p.cc && <span className="c9-thumb-cc" title="From CompanyCam">CC</span>}
                      <button
                        type="button"
                        className="c9-thumb-x"
                        aria-label={`Remove ${p.file?.name || 'photo'}`}
                        onClick={() => removePhoto(p.key)}
                      >
                        ✕
                      </button>
                    </div>
                    <select
                      className="c9-tag-select"
                      value={p.tagId ?? ''}
                      aria-label="Photo tag"
                      onChange={(e) => setPhotoTag(p.key, e.target.value)}
                    >
                      <option value="">no tag</option>
                      {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
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

      {/* CompanyCam photo picker */}
      <Sheet open={ccOpen} title={`CompanyCam — ${ccProject?.name || job?.name || ''}`} onClose={() => setCcOpen(false)}>
        <div className="c9-cc-toolbar">
          <button
            type="button"
            className={ccMine ? 'c9-cc-filter' : 'c9-cc-filter active'}
            onClick={() => openCompanyCam(false)}
          >
            All photos
          </button>
          <button
            type="button"
            className={ccMine ? 'c9-cc-filter active' : 'c9-cc-filter'}
            onClick={() => openCompanyCam(true)}
          >
            Mine
          </button>
        </div>
        {ccPhotos === undefined && <Spinner label="Loading photos…" />}
        {Array.isArray(ccPhotos) && ccPhotos.length === 0 && (
          <p className="c9-empty">
            {ccProject ? 'No photos on this CompanyCam project yet.' : 'No CompanyCam project matches this job.'}
          </p>
        )}
        {Array.isArray(ccPhotos) && ccPhotos.length > 0 && (
          <div className="c9-cc-grid">
            {ccPhotos.map((p) => (
              <button
                key={p.id}
                type="button"
                className={ccSelected.has(p.id) ? 'c9-cc-photo selected' : 'c9-cc-photo'}
                onClick={() => setCcSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(p.id)) next.delete(p.id); else if (next.size < 10) next.add(p.id);
                  return next;
                })}
              >
                <img src={p.thumbnail || p.web} alt={`CompanyCam ${p.creatorName || ''}`} loading="lazy" />
                {ccSelected.has(p.id) && <span className="c9-cc-check">✓</span>}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="c9-btn c9-btn-primary"
          style={{ marginTop: 12 }}
          disabled={ccBusy || ccSelected.size === 0}
          onClick={importSelected}
        >
          {ccBusy ? 'Importing…' : `Import ${ccSelected.size || ''} photo${ccSelected.size === 1 ? '' : 's'}`}
        </button>
      </Sheet>
    </div>
  );
}
