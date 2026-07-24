import React, { useEffect, useRef, useState, useCallback } from 'react';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { loadGoogleMaps, PIN_COLORS } from '../lib/googleMaps.js';

function fmtWhen(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function pinTitle(p) {
  if (p.kind === 'out') return `${p.userName} · Clock-out`;
  if (p.kind === 'in') return `${p.userName} · Clock-in`;
  if (p.source === 'wake') return `${p.userName} · Last seen`;
  return `${p.userName} · Clocked in`;
}

function pinBody(p) {
  const whenLabel = p.source === 'wake' ? 'Last seen' : 'At';
  return `${p.jobName}<br>${p.activity || ''}<br>${whenLabel}: ${fmtWhen(p.at)}`;
}

/**
 * Admin-only crew map. Pins are punch GPS (open by default; toggle for
 * today's in + out). Geofence circles only for jobs in the current view.
 */
export default function AdminMap({ adminFetch }) {
  const [view, setView] = useState('open'); // 'open' | 'today'
  const [pins, setPins] = useState(undefined); // undefined loading
  const [fences, setFences] = useState([]);
  const [withoutGps, setWithoutGps] = useState(0);
  const [err, setErr] = useState(null);
  const [mapsKey, setMapsKey] = useState(undefined); // undefined loading, null missing
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const circlesRef = useRef([]);
  const infoRef = useRef(null);
  const [paintTick, setPaintTick] = useState(0);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await adminFetch('/api/admin/map/config');
      setMapsKey(cfg.mapsApiKey || null);
    } catch (e) {
      setErr(e.message);
      setMapsKey(null);
    }
  }, [adminFetch]);

  const loadPins = useCallback(async () => {
    setPins(undefined);
    setErr(null);
    try {
      const data = await adminFetch(`/api/admin/map/pins?view=${view}`);
      setPins(data.pins || []);
      setFences(data.fences || []);
      setWithoutGps(data.withoutGps || 0);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
      setPins([]);
      setFences([]);
    }
  }, [adminFetch, view]);

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadPins(); }, [loadPins]);

  // Init map once we have a key + container.
  useEffect(() => {
    if (!mapsKey || !mapEl.current || mapRef.current) return undefined;
    let cancelled = false;
    loadGoogleMaps(mapsKey)
      .then((maps) => {
        if (cancelled || !mapEl.current) return;
        mapRef.current = new maps.Map(mapEl.current, {
          center: { lat: 30.2672, lng: -97.7431 }, // Austin fallback
          zoom: 11,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
        });
        infoRef.current = new maps.InfoWindow();
        setPaintTick((n) => n + 1);
      })
      .catch((e) => setErr(e.message));
    return () => { cancelled = true; };
  }, [mapsKey]);

  // Paint markers + fence circles whenever data or map changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps || !Array.isArray(pins)) return;

    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    circlesRef.current.forEach((c) => c.setMap(null));
    circlesRef.current = [];

    const bounds = new window.google.maps.LatLngBounds();
    let hasBounds = false;

    for (const f of fences) {
      const circle = new window.google.maps.Circle({
        map,
        center: { lat: f.lat, lng: f.lng },
        radius: f.radiusM || 250,
        strokeColor: '#0f2740',
        strokeOpacity: 0.7,
        strokeWeight: 2,
        fillColor: '#0f2740',
        fillOpacity: 0.08,
      });
      circlesRef.current.push(circle);
      bounds.extend({ lat: f.lat, lng: f.lng });
      hasBounds = true;
    }

    for (const p of pins) {
      const color = PIN_COLORS[p.kind] || PIN_COLORS.in;
      const marker = new window.google.maps.Marker({
        map,
        position: { lat: p.lat, lng: p.lng },
        title: pinTitle(p),
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: p.kind === 'open' ? 10 : 8,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      marker.addListener('click', () => {
        infoRef.current.setContent(
          `<div class="adm-map-iw"><strong>${pinTitle(p)}</strong><div>${pinBody(p)}</div></div>`
        );
        infoRef.current.open({ map, anchor: marker });
      });
      markersRef.current.push(marker);
      bounds.extend({ lat: p.lat, lng: p.lng });
      hasBounds = true;
    }

    if (!hasBounds) return;
    if (pins.length === 1 && fences.length === 0) {
      map.setCenter({ lat: pins[0].lat, lng: pins[0].lng });
      map.setZoom(14);
    } else {
      map.fitBounds(bounds, 48);
    }
  }, [pins, fences, paintTick]);

  const showCanvas = Array.isArray(pins) && (pins.length > 0 || fences.length > 0);

  if (mapsKey === undefined) return <Spinner label="Loading map…" />;

  if (mapsKey === null) {
    return (
      <div className="adm-map-setup">
        <EmptyState
          icon="🗺"
          title="Google Maps API key not configured"
          hint="Set GOOGLE_MAPS_API_KEY on the server. See docs/GOOGLE_MAPS.md for Cloud Console steps."
        />
      </div>
    );
  }

  return (
    <div className="adm-map">
      <div className="adm-map-toolbar">
        <div className="adm-map-toggle" role="group" aria-label="Map view">
          <button
            type="button"
            className={view === 'open' ? 'adm-map-tog active' : 'adm-map-tog'}
            onClick={() => setView('open')}
          >
            Clocked in now
          </button>
          <button
            type="button"
            className={view === 'today' ? 'adm-map-tog active' : 'adm-map-tog'}
            onClick={() => setView('today')}
          >
            Today&apos;s in &amp; outs
          </button>
        </div>
        <div className="adm-map-legend" aria-hidden="true">
          <span><i style={{ background: PIN_COLORS.open }} /> Open / last seen</span>
          <span><i style={{ background: PIN_COLORS.in }} /> In</span>
          <span><i style={{ background: PIN_COLORS.out }} /> Out</span>
        </div>
        <button type="button" className="tdy-refresh" onClick={loadPins} title="Refresh">↻</button>
      </div>

      <ErrorBanner message={err} onDismiss={() => setErr(null)} />

      {pins === undefined && <Spinner label="Loading locations…" />}

      {Array.isArray(pins) && pins.length === 0 && fences.length === 0 && (
        <EmptyState
          icon="📍"
          title={view === 'open' ? 'No open punches with GPS' : 'No punch locations today'}
          hint={withoutGps > 0
            ? `${withoutGps} punch${withoutGps === 1 ? '' : 'es'} without GPS (crew may have denied location).`
            : 'Crew GPS is captured at clock-in/out when the device allows it.'}
        />
      )}

      <div
        ref={mapEl}
        className="adm-map-canvas"
        style={{ display: showCanvas ? 'block' : 'none' }}
        role="application"
        aria-label="Crew location map"
      />

      {Array.isArray(pins) && pins.length > 0 && withoutGps > 0 && (
        <p className="adm-map-note">
          Showing {pins.length} pin{pins.length === 1 ? '' : 's'}. {withoutGps} punch{withoutGps === 1 ? '' : 'es'} had no GPS.
        </p>
      )}
    </div>
  );
}
