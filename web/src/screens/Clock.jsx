import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getCurrentEntry, getTimeEntries, getActivities, getJobCostItems, clockIn, clockOut } from '../api.js';
import Card from '../components/Card.jsx';
import Sheet from '../components/Sheet.jsx';
import PickerSheet from '../components/PickerSheet.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import '../components/screens.css';

// ---- helpers ----
function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtMins(mins) {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function fmtElapsed(startedAt, now) {
  const s = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// Best-effort GPS: resolves {lat,lng} or null. Never rejects, never blocks past 6s.
function getGps() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), 6000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
    );
  });
}

export default function Clock({ boot }) {
  const jobs = boot?.jobs || [];

  const [current, setCurrent] = useState(undefined); // undefined = loading, null = clocked out
  const [entries, setEntries] = useState([]);
  const [loadErr, setLoadErr] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Clock-in flow state
  const [step, setStep] = useState(null); // null | 'job' | 'activity' | 'note' | 'out'
  const [selJob, setSelJob] = useState(null);
  const [selActivity, setSelActivity] = useState(null);
  const [selCostItem, setSelCostItem] = useState(null); // budget item => auto-approves
  const [activities, setActivities] = useState(null); // standard catalog, null = loading
  const [budgetItems, setBudgetItems] = useState(null); // this job's labor items, null = loading
  const [note, setNote] = useState('');
  const [breakMin, setBreakMin] = useState('');
  const gpsPromise = useRef(null);
  const budgetCache = useRef(new Map()); // jobId -> items

  function loadPickerOptions(jobId) {
    if (!activities?.length) {
      getActivities()
        .then((r) => setActivities(r.activities || []))
        .catch(() => setActivities([]));
    }
    const cached = budgetCache.current.get(jobId);
    if (cached) { setBudgetItems(cached); return; }
    setBudgetItems(null);
    getJobCostItems(jobId)
      .then((r) => {
        const items = r.costItems || [];
        budgetCache.current.set(jobId, items);
        setBudgetItems(items);
      })
      .catch(() => setBudgetItems([])); // budget list is a bonus — the catalog still works
  }

  const load = useCallback(async () => {
    try {
      const { from, to } = todayRange();
      const [cur, ent] = await Promise.all([
        getCurrentEntry(),
        getTimeEntries(from, to)
      ]);
      setCurrent(cur.entry);
      setEntries(ent.entries || []);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e.message || 'Could not load time data');
      setCurrent((c) => (c === undefined ? null : c));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live elapsed ticker while clocked in
  useEffect(() => {
    if (!current) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [current]);

  function resetFlow() {
    setStep(null);
    setSelJob(null);
    setSelActivity(null);
    setSelCostItem(null);
    setNote('');
    setBreakMin('');
  }

  function startClockIn() {
    setActionErr(null);
    gpsPromise.current = getGps(); // warm up GPS while the user picks
    setStep('job');
  }

  async function submitClockIn() {
    if (busy || !selJob || !selActivity) return;
    setBusy(true);
    setActionErr(null);
    const at = new Date().toISOString(); // tap time — survives the offline queue
    try {
      const coordinates = await (gpsPromise.current || getGps());
      const res = await clockIn({
        jobId: selJob.id,
        activity: selActivity,
        costItemId: selCostItem?.id || undefined,
        notes: note.trim() || undefined,
        coordinates: coordinates || undefined,
        at
      });
      if (res.queued) {
        // Optimistic local entry while offline
        setCurrent({
          id: `local-${Date.now()}`,
          jobId: selJob.id,
          jobName: selJob.name,
          activity: selActivity,
          costItemName: selActivity,
          startedAt: at,
          endedAt: null,
          minutes: 0,
          notes: note.trim(),
          coordinates,
          _queued: true
        });
        setNotice('Clock-in saved offline — it will sync when you reconnect.');
      } else {
        setCurrent(res.data.entry);
        setNotice(null);
        load();
      }
      resetFlow();
    } catch (e) {
      // Covers 409 (already clocked in): re-sync with the server.
      setActionErr(e.message || 'Clock in failed');
      resetFlow();
      load();
    } finally {
      setBusy(false);
    }
  }

  async function submitClockOut() {
    if (busy || !current) return;
    setBusy(true);
    setActionErr(null);
    const prev = current;
    const at = new Date().toISOString(); // tap time — survives the offline queue
    try {
      const coordinates = await getGps();
      const breakMinutes = parseInt(breakMin, 10);
      const res = await clockOut({
        breakMinutes: Number.isFinite(breakMinutes) && breakMinutes > 0 ? breakMinutes : undefined,
        coordinates: coordinates || undefined,
        at
      });
      if (res.queued) {
        const endedAt = at;
        const gross = (new Date(endedAt) - new Date(prev.startedAt)) / 60000;
        const mins = Math.max(0, Math.round(gross - (Number.isFinite(breakMinutes) ? breakMinutes : 0)));
        setEntries((list) => [...list, { ...prev, endedAt, minutes: mins, _queued: true }]);
        setNotice('Clock-out saved offline — it will sync when you reconnect.');
      } else {
        setNotice(null);
        load();
      }
      setCurrent(null);
      resetFlow();
    } catch (e) {
      // Covers 409 (no open entry): re-sync with the server.
      setActionErr(e.message || 'Clock out failed');
      resetFlow();
      load();
    } finally {
      setBusy(false);
    }
  }

  if (current === undefined && !loadErr) return <Spinner label="Loading your day…" />;

  const completed = entries.filter((e) => e.endedAt);
  const runningMins = current ? Math.max(0, (now - new Date(current.startedAt).getTime()) / 60000) : 0;
  const totalMins = completed.reduce((sum, e) => sum + (e.minutes || 0), 0) + runningMins;

  // Picker: this job's budget labor items first (auto-approve), then the
  // standard Employee Labor catalog (manager maps those later).
  const activityOptions = [
    ...(budgetItems || []).map((ci) => ({
      id: `ci:${ci.id}`,
      label: ci.name,
      sub: `✓ In budget — auto-approves${ci.costCode ? ` · ${ci.costCode}` : ''}`,
      _ci: ci,
    })),
    ...(activities || []).map((a) => ({ id: `act:${a}`, label: a, sub: 'Standard labor' })),
  ];
  const pickerLoading = budgetItems === null && activities === null;

  return (
    <div>
      <ErrorBanner message={loadErr} onRetry={load} />
      <ErrorBanner message={actionErr} onDismiss={() => setActionErr(null)} />
      {notice && <p className="clk-notice">{notice}</p>}

      <Card>
        <div className="clk-status">
          {current ? (
            <>
              <p className="clk-state-label in">Clocked in{current._queued ? ' · offline' : ''}</p>
              <p className="clk-elapsed">{fmtElapsed(current.startedAt, now)}</p>
              <p className="clk-jobline">{current.jobName}</p>
              <p className="clk-subline">
                {current.costItemName} · since {fmtTime(current.startedAt)}
              </p>
              <button
                type="button"
                className="c-btn c-btn-big c-btn-block c-btn-red"
                disabled={busy}
                onClick={() => { setActionErr(null); setStep('out'); }}
              >
                Clock Out
              </button>
            </>
          ) : (
            <>
              <p className="clk-state-label">Clocked out</p>
              <p className="clk-subline">Ready when you are.</p>
              <button
                type="button"
                className="c-btn c-btn-big c-btn-block c-btn-green"
                disabled={busy}
                onClick={startClockIn}
              >
                Clock In
              </button>
            </>
          )}
        </div>
      </Card>

      <Card title="Today's entries">
        {completed.length === 0 && !current ? (
          <EmptyState icon="⏱" title="No time yet today" hint="Tap Clock In to start tracking." />
        ) : (
          <>
            {completed.map((e) => (
              <div className="clk-entry" key={e.id}>
                <div className="clk-entry-main">
                  <p className="clk-entry-job">{e.jobName}</p>
                  <p className="clk-entry-meta">
                    {e.costItemName} · {fmtTime(e.startedAt)} – {fmtTime(e.endedAt)}
                    {e._queued && <span className="c-pill c-pill-orange" style={{ marginLeft: 6 }}>offline</span>}
                  </p>
                </div>
                <span className="clk-entry-mins">{fmtMins(e.minutes)}</span>
              </div>
            ))}
            {current && (
              <div className="clk-entry" key="running">
                <div className="clk-entry-main">
                  <p className="clk-entry-job">{current.jobName}</p>
                  <p className="clk-entry-meta">{current.costItemName} · {fmtTime(current.startedAt)} – now</p>
                </div>
                <span className="clk-entry-mins">{fmtMins(runningMins)}</span>
              </div>
            )}
            <div className="clk-total">
              <span>Total today</span>
              <span>{fmtMins(totalMins)}</span>
            </div>
          </>
        )}
      </Card>

      {/* Step 1: pick job */}
      <PickerSheet
        open={step === 'job'}
        title="Pick a job"
        onClose={resetFlow}
        options={jobs.map((j) => ({ id: j.id, label: j.name, sub: j.location, _job: j }))}
        onSelect={(opt) => { setSelJob(opt._job); setStep('activity'); loadPickerOptions(opt._job.id); }}
        emptyText="No jobs available"
      />

      {/* Step 2: budget labor items (auto-approve) + standard labor catalog */}
      <PickerSheet
        open={step === 'activity'}
        title={`What are you doing? — ${selJob?.name || ''}`}
        onClose={resetFlow}
        options={activityOptions}
        onSelect={(opt) => {
          setSelActivity(opt._ci ? opt._ci.name : opt.label);
          setSelCostItem(opt._ci || null);
          setStep('note');
        }}
        emptyText={pickerLoading ? 'Loading…' : 'No labor items configured'}
      />

      {/* Step 3: optional note + confirm */}
      <Sheet open={step === 'note'} title="Ready to clock in" onClose={resetFlow}>
        <div className="clk-review">
          <p><strong>{selJob?.name}</strong></p>
          <p className="muted">
            {selActivity}
            {selCostItem && <span className="c-pill c-pill-orange" style={{ marginLeft: 6 }}>auto-approves</span>}
          </p>
        </div>
        <label className="c-label" htmlFor="clk-note">Note (optional)</label>
        <textarea
          id="clk-note"
          className="c-input"
          rows={2}
          placeholder="What are you working on?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="clk-gps">Location is attached automatically if allowed — never required.</p>
        <button
          type="button"
          className="c-btn c-btn-big c-btn-block c-btn-green"
          style={{ marginTop: 12 }}
          disabled={busy}
          onClick={submitClockIn}
        >
          {busy && <Spinner inline size={18} />}
          {busy ? 'Clocking in…' : 'Clock In'}
        </button>
      </Sheet>

      {/* Clock-out confirm sheet */}
      <Sheet open={step === 'out'} title="Clock out?" onClose={resetFlow}>
        {current && (
          <div className="clk-review">
            <p><strong>{current.jobName}</strong></p>
            <p className="muted">
              {current.costItemName} · started {fmtTime(current.startedAt)} · {fmtMins(runningMins)} so far
            </p>
          </div>
        )}
        <label className="c-label" htmlFor="clk-break">Break minutes (optional)</label>
        <input
          id="clk-break"
          className="c-input"
          type="number"
          inputMode="numeric"
          min="0"
          step="5"
          placeholder="0"
          value={breakMin}
          onChange={(e) => setBreakMin(e.target.value)}
        />
        <button
          type="button"
          className="c-btn c-btn-big c-btn-block c-btn-red"
          style={{ marginTop: 12 }}
          disabled={busy}
          onClick={submitClockOut}
        >
          {busy && <Spinner inline size={18} />}
          {busy ? 'Clocking out…' : 'Confirm Clock Out'}
        </button>
        <button
          type="button"
          className="c-btn c-btn-block c-btn-ghost"
          style={{ marginTop: 8 }}
          disabled={busy}
          onClick={resetFlow}
        >
          Keep working
        </button>
      </Sheet>
    </div>
  );
}
