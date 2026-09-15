import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

export default function AdminCrew({ adminFetch }) {
  const [employees, setEmployees] = useState(undefined);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await adminFetch('/api/admin/employees');
      setEmployees(r.employees || []);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
      setEmployees([]);
    }
  }, [adminFetch]);

  useEffect(() => { load(); }, [load]);

  async function resetPin(emp) {
    const who = emp.name || emp.email;
    if (!window.confirm(`Reset PIN for ${who}?\n\nTheir current PIN stops working. They use First time here with the same email and choose a new PIN.`)) {
      return;
    }
    setBusyId(emp.id);
    setErr(null);
    try {
      const r = await adminFetch(`/api/admin/employees/${emp.id}/reset-pin`, { method: 'POST' });
      setEmployees((list) => (list || []).map((e) => (e.id === emp.id ? r.employee : e)));
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <ErrorBanner message={err} onDismiss={() => setErr(null)} />
      <p className="adm-crew-note">
        Reset PIN unlocks their existing account. They keep the same email — do not create a second account.
      </p>
      {employees === undefined && <Spinner label="Loading crew…" />}
      {Array.isArray(employees) && employees.length === 0 && (
        <Card><EmptyState icon="👥" title="No registered crew yet" /></Card>
      )}
      {Array.isArray(employees) && employees.length > 0 && (
        <div className="adm-crew-list">
          {employees.map((e) => (
            <div className="adm-crew-row" key={e.id}>
              <div className="adm-crew-info">
                <div className="adm-strong">{e.name || e.email}</div>
                <div className="adm-crew-meta">{e.email}</div>
                {e.pinResetPending && (
                  <span className="adm-badge adm-badge-pending">Waiting for new PIN</span>
                )}
              </div>
              <button
                type="button"
                className="c-btn c-btn-small"
                disabled={busyId === e.id}
                onClick={() => resetPin(e)}
              >
                {busyId === e.id ? 'Resetting…' : e.pinResetPending ? 'Reset again' : 'Reset PIN'}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
