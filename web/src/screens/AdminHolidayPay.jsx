import React, { useState } from 'react';
import { todayISO } from '../lib/dates.js';

function defaultWorkDate(from, to) {
  const today = todayISO();
  if (from && to && today >= from && today <= to) return today;
  return from || today;
}

export default function AdminHolidayPay({
  adminFetch,
  userId,
  userName,
  periodFrom,
  periodTo,
  onCancel,
  onSaved,
}) {
  const [workDate, setWorkDate] = useState(() => defaultWorkDate(periodFrom, periodTo));
  const [hours, setHours] = useState('8');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!userId) {
      setErr('This crew member is not linked to JobTread, so holiday pay cannot be added here');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await adminFetch('/api/admin/punches', {
        method: 'POST',
        body: {
          userId,
          entryKind: 'holiday',
          workDate,
          hours: Number(hours),
          notes: notes.trim() || undefined,
        },
      });
      onSaved?.(r.punch);
    } catch (ex) {
      setErr(ex.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-hours-add no-print">
      <p className="adm-hours-addkicker">Holiday pay · {userName}</p>
      <p className="adm-crew-note">
        This shows on their timesheet when they approve hours. It does not clock them in,
        does not count toward overtime, and is not pushed to a JobTread job.
      </p>
      {err && <p className="adm-hours-adderr" role="alert">{err}</p>}
      <form className="adm-addform" onSubmit={submit}>
        <label>
          Date
          <input type="date" required value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </label>
        <label>
          Hours
          <input type="number" required min="0.25" max="24" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
        <label className="adm-addform-wide">
          Note (optional)
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Holiday name" />
        </label>
        <div className="adm-addform-actions">
          <button type="submit" className="c-btn" disabled={busy || !userId}>{busy ? 'Saving…' : 'Save holiday pay'}</button>
          <button type="button" className="c-btn c-btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
