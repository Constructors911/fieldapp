import React, { useState, useEffect, useCallback } from 'react';
import { getMyLogs, createLog, getFileTags, getCompanyCamStatus } from '../api.js';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import PickerSheet from '../components/PickerSheet.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import PhotoAttach, { preparePhotos } from '../components/PhotoAttach.jsx';
import { todayISO, parseISODate, fmtMonthDay, fmtDayShort } from '../lib/dates.js';
import '../components/screens.css';

function weatherChip(w) {
  if (!w) return null;
  const temps = [w.minTemp, w.maxTemp].filter((t) => t !== undefined && t !== null);
  const range = temps.length === 2 ? `${w.minTemp}°–${w.maxTemp}°` : temps.length === 1 ? `${temps[0]}°` : '';
  return (
    <span className="c-log-weather" title="Weather (from JobTread)">
      ⛅ {w.condition}{range ? ` · ${range}` : ''}
    </span>
  );
}

const fmtLogDate = (s) => {
  const d = parseISODate(s);
  return d ? `${fmtDayShort(d)} ${fmtMonthDay(d)}` : s;
};

// ---- New-log form (the '+' view) ------------------------------------------
function LogForm({ boot, tags, ccAvailable, onDone, onCancel }) {
  const jobs = boot?.jobs || [];
  const [jobId, setJobId] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState([]);
  const [hasConcerns, setHasConcerns] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [photoReminderShown, setPhotoReminderShown] = useState(false);
  const [msg, setMsg] = useState(null); // errors stay here; success reports via onDone

  const job = jobs.find((j) => j.id === jobId) || null;

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    if (!jobId) { setMsg({ type: 'err', text: 'Pick a job first.' }); return; }
    if (!date) { setMsg({ type: 'err', text: 'Pick a date first.' }); return; }
    if (!notes.trim() && photos.length === 0) {
      setMsg({ type: 'err', text: 'Add some notes or a photo before submitting.' });
      return;
    }
    // Photos aren't mandatory — but remind once before an all-text log goes out.
    if (photos.length === 0 && !photoReminderShown) {
      setPhotoReminderShown(true);
      setMsg({ type: 'queued', text: '📸 Don’t forget relevant photos — Before, During, After, Concerns. Add them now, or tap "Save log" to submit without.' });
      return;
    }

    setSubmitting(true);
    setMsg(null);

    const { fileIds, fileTagsMap, skipped } = await preparePhotos(photos);

    try {
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
      const photoNote = skipped > 0
        ? ` ${skipped} photo${skipped > 1 ? 's' : ''} skipped — photos need a connection, re-attach once you're back online.`
        : '';
      onDone(res.queued
        ? { type: 'queued', text: `Log saved offline — it will sync automatically.${photoNote}` }
        : { type: 'ok', text: `Log submitted.${photoNote}` });
    } catch (err) {
      setMsg({ type: 'err', text: err.message || 'Could not submit log.' });
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Card
        title="New daily log"
        action={<button type="button" className="c-btn c-btn-ghost c-btn-small" onClick={onCancel}>✕ Cancel</button>}
      >
        <form onSubmit={submit}>
          <div className="c-field">
            <label className="c-label" htmlFor="log-job">Job</label>
            <button
              id="log-job"
              type="button"
              className="c-input c-jobbtn"
              onClick={() => setPickerOpen(true)}
              aria-haspopup="dialog"
            >
              {job ? (
                <span className="c-jobbtn-text">
                  <span className="c-jobbtn-name">{job.name}</span>
                  {job.location ? <span className="c-jobbtn-sub">{job.location}</span> : null}
                </span>
              ) : (
                <span className="c-jobbtn-placeholder">Select a job…</span>
              )}
              <span aria-hidden="true">▾</span>
            </button>
          </div>

          <div className="c-field">
            <label className="c-label" htmlFor="log-date">Date</label>
            <input
              id="log-date"
              className="c-input"
              type="date"
              value={date}
              max={todayISO()}
              onChange={(e) => { setDate(e.target.value); setMsg(null); }}
            />
          </div>

          <div className="c-field">
            <label className="c-label" htmlFor="log-notes">Notes</label>
            <textarea
              id="log-notes"
              className="c-textarea"
              placeholder="What happened on site today?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="c-field c-checkrow">
            <label className="c-check">
              <input type="checkbox" checked={hasConcerns} onChange={(e) => setHasConcerns(e.target.checked)} />
              ⚠️ Concerns to report
            </label>
            <label className="c-check">
              <input type="checkbox" checked={isComplete} onChange={(e) => setIsComplete(e.target.checked)} />
              ✅ Work complete
            </label>
          </div>
          {(hasConcerns || isComplete) && (
            <p className="c-check-hint">
              Remember photos tagged {[hasConcerns && '"Concerns"', isComplete && '"Completion"'].filter(Boolean).join(' and ')}.
            </p>
          )}

          <div className="c-field">
            <span className="c-label">Photos</span>
            <PhotoAttach
              jobId={jobId}
              photos={photos}
              setPhotos={setPhotos}
              tags={tags}
              ccAvailable={ccAvailable}
              onError={(text) => setMsg({ type: 'err', text })}
            />
          </div>

          {msg && <div className={`c-msg c-msg-${msg.type}`} role="status">{msg.text}</div>}

          <button type="submit" className="c-btn c-btn-primary" disabled={submitting || !jobId}>
            {submitting ? 'Submitting…' : (photoReminderShown && photos.length === 0 ? 'Save log' : 'Submit log')}
          </button>
        </form>
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

// ---- Log tab: the user's daily-log feed ------------------------------------
export default function Log({ boot }) {
  const jobs = boot?.jobs || [];
  const [mode, setMode] = useState('list'); // 'list' | 'new'

  const [tags, setTags] = useState([]);
  const [ccAvailable, setCcAvailable] = useState(false);
  useEffect(() => { getFileTags().then((r) => setTags(r.tags || [])).catch(() => {}); }, []);
  useEffect(() => { getCompanyCamStatus().then((r) => setCcAvailable(r.configured)).catch(() => {}); }, []);

  const [logs, setLogs] = useState(undefined); // undefined = loading, null = error
  const [logsErr, setLogsErr] = useState(null);
  const [msg, setMsg] = useState(null); // post-submit confirmation
  const [search, setSearch] = useState('');
  const [jobFilter, setJobFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [jobPickerOpen, setJobPickerOpen] = useState(false);

  const load = useCallback(() => {
    setLogs(undefined);
    setLogsErr(null);
    getMyLogs({ jobId: jobFilter || undefined, date: dateFilter || undefined })
      .then((r) => setLogs(r.logs || []))
      .catch((e) => { setLogsErr(e.message); setLogs(null); });
  }, [jobFilter, dateFilter]);

  useEffect(() => { if (mode === 'list') load(); }, [mode, load]);

  if (mode === 'new') {
    return (
      <LogForm
        boot={boot}
        tags={tags}
        ccAvailable={ccAvailable}
        onCancel={() => setMode('list')}
        onDone={(m) => { setMsg(m); setMode('list'); }}
      />
    );
  }

  const q = search.trim().toLowerCase();
  const visible = (logs || []).filter((l) =>
    !q || `${l.jobName} ${l.notes ?? ''}`.toLowerCase().includes(q));
  const jobFilterName = jobs.find((j) => j.id === jobFilter)?.name;

  return (
    <div>
      <div className="c-feed-toolbar">
        <h2 className="c-feed-title">My daily logs</h2>
        <button type="button" className="c-btn c-btn-primary c-btn-add" onClick={() => { setMsg(null); setMode('new'); }}>
          ＋ New log
        </button>
      </div>

      <div className="c-feed-filters">
        <input
          type="search"
          className="c-input c-feed-search"
          placeholder="Search notes or jobs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className={jobFilter ? 'c-cc-filter active' : 'c-cc-filter'}
          onClick={() => setJobPickerOpen(true)}
        >
          {jobFilterName ? jobFilterName.slice(0, 22) : 'All jobs'}
        </button>
        <input
          type="date"
          className="c-input c-feed-date"
          value={dateFilter}
          max={todayISO()}
          onChange={(e) => setDateFilter(e.target.value)}
        />
        {(jobFilter || dateFilter || search) && (
          <button
            type="button"
            className="c-cc-filter"
            onClick={() => { setJobFilter(''); setDateFilter(''); setSearch(''); }}
          >
            Clear
          </button>
        )}
      </div>

      {msg && <div className={`c-msg c-msg-${msg.type}`} role="status">{msg.text}</div>}

      {logs === undefined && <Spinner label="Loading your logs…" />}
      {logs === null && <ErrorBanner message={logsErr} onRetry={load} />}
      {Array.isArray(logs) && visible.length === 0 && (
        <Card>
          <EmptyState
            icon="📋"
            title={q || jobFilter || dateFilter ? 'No logs match' : 'No logs yet'}
            hint={q || jobFilter || dateFilter ? 'Try clearing the filters.' : 'Tap ＋ New log to write your first daily log.'}
          />
        </Card>
      )}
      {Array.isArray(logs) && visible.map((l) => (
        <Card key={l.id}>
          <div className="c-log-meta">
            <span className="c-log-job">{l.jobName}</span>
            <span className="c-log-date">{fmtLogDate(l.date)}</span>
          </div>
          <div className="c-log-meta">
            {weatherChip(l.weather)}
          </div>
          {l.notes && <p className="c-log-notes">{l.notes}</p>}
          {l.files?.length > 0 && (
            <div className="c-log-photos">
              {l.files.map((f) => (
                <img key={f.id} src={f.url} alt={f.name || 'log photo'} loading="lazy" />
              ))}
            </div>
          )}
        </Card>
      ))}

      <PickerSheet
        open={jobPickerOpen}
        title="Filter by job"
        onClose={() => setJobPickerOpen(false)}
        options={[
          { id: '', label: 'All jobs' },
          ...jobs.map((j) => ({ id: j.id, label: j.name, sub: j.location })),
        ]}
        onSelect={(opt) => { setJobFilter(opt.id); setJobPickerOpen(false); }}
        emptyText="No jobs available."
      />
    </div>
  );
}
