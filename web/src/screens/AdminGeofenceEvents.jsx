import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

const EVENT_LABELS = {
  clock_in_outside: 'Clock-in outside fence',
  clock_out_outside: 'Clock-out outside fence',
  left_geofence: 'Left geofence (still clocked in)',
  returned_to_geofence: 'Returned to geofence',
};

function fmtWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Admin geofence event inbox. Default filter: unreviewed.
 */
export default function AdminGeofenceEvents({ adminFetch }) {
  const [status, setStatus] = useState('unreviewed');
  const [events, setEvents] = useState(undefined);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setEvents(undefined);
    setErr(null);
    try {
      const q = status === 'all' ? '' : `?status=${status}`;
      const data = await adminFetch(`/api/admin/geofence-events${q}`);
      setEvents(data.events || []);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
      setEvents([]);
    }
  }, [adminFetch, status]);

  useEffect(() => { load(); }, [load]);

  async function setEventStatus(id, next) {
    setBusyId(id);
    setErr(null);
    try {
      await adminFetch(`/api/admin/geofence-events/${id}`, {
        method: 'PATCH',
        body: { status: next },
      });
      // Drop from unreviewed list immediately; otherwise refresh.
      if (status === 'unreviewed' && next === 'reviewed') {
        setEvents((list) => (list || []).filter((e) => e.id !== id));
      } else {
        await load();
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="adm-geofence">
      <div className="adm-map-toolbar">
        <div className="adm-map-toggle" role="group" aria-label="Event status">
          {['unreviewed', 'reviewed', 'all'].map((s) => (
            <button
              key={s}
              type="button"
              className={status === s ? 'adm-map-tog active' : 'adm-map-tog'}
              onClick={() => setStatus(s)}
            >
              {s === 'all' ? 'All' : s === 'unreviewed' ? 'Unreviewed' : 'Reviewed'}
            </button>
          ))}
        </div>
        <button type="button" className="tdy-refresh" onClick={load} title="Refresh">↻</button>
      </div>

      <ErrorBanner message={err} onDismiss={() => setErr(null)} />

      {events === undefined && <Spinner label="Loading geofence events…" />}

      {Array.isArray(events) && events.length === 0 && (
        <Card>
          <EmptyState
            icon="✓"
            title={status === 'unreviewed' ? 'No unreviewed events' : 'No geofence events'}
            hint="Clock-in/out and wake pings outside a job fence are logged here silently."
          />
        </Card>
      )}

      {Array.isArray(events) && events.length > 0 && (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Crew</th>
                <th>Job</th>
                <th>Event</th>
                <th>Distance</th>
                <th>Status</th>
                <th>Map</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="adm-times">{fmtWhen(e.recordedAt)}</td>
                  <td className="adm-strong">{e.userName || e.userId}</td>
                  <td className="adm-job">{e.jobName}</td>
                  <td>{EVENT_LABELS[e.type] || e.type}</td>
                  <td className="adm-num">
                    {e.distanceM != null ? `${e.distanceM} m` : '—'}
                    {e.radiusM != null ? <span className="muted"> / {e.radiusM} m</span> : null}
                  </td>
                  <td>
                    <select
                      className="adm-select"
                      style={{ minWidth: 130, maxWidth: 150 }}
                      value={e.status}
                      disabled={busyId === e.id}
                      onChange={(ev) => setEventStatus(e.id, ev.target.value)}
                      aria-label={`Status for ${e.userName}`}
                    >
                      <option value="unreviewed">Unreviewed</option>
                      <option value="reviewed">Reviewed</option>
                    </select>
                  </td>
                  <td className="adm-gps">
                    {e.coordinates && (
                      <a
                        href={`https://maps.google.com/?q=${e.coordinates.lat},${e.coordinates.lng}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        open
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
