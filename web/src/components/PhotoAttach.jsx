import React, { useState, useRef } from 'react';
import Sheet from './Sheet.jsx';
import Spinner from './Spinner.jsx';
import { getCompanyCamPhotos, importCompanyCamPhotos, uploadFile } from '../api.js';
import './components.css';
import '../lib/screens.css'; // c9-* photo strip + CC grid styles

// Shared photo attach strip: camera/gallery + CompanyCam pull + per-photo
// JobTread tag selects. Used by the Log form and the clock-out mini-log.
// Photo shape: manual {key, file, url, tagId} | CompanyCam {key, fileId, url, tagId, cc}

let nextPhotoKey = 1;

/** Find a tag id by name (case-insensitive). */
export function tagIdByName(tags, name) {
  return tags.find((t) => t.name.toLowerCase() === String(name).toLowerCase())?.id ?? null;
}

/**
 * Checkbox enforcement: each checked requirement needs >=1 photo carrying
 * that tag. Returns an error string or null.
 */
export function requiredTagError(photos, tags, { concerns, complete }) {
  const checks = [
    concerns && { name: 'Concerns', id: tagIdByName(tags, 'Concerns') },
    complete && { name: 'Completion', id: tagIdByName(tags, 'Completion') },
  ].filter(Boolean);
  for (const c of checks) {
    if (!c.id) continue; // tag renamed/removed in JT — don't hard-block the crew
    if (!photos.some((p) => p.tagId === c.id)) {
      return `Add at least one photo tagged "${c.name}" (photos are required when it's checked).`;
    }
  }
  return null;
}

/**
 * Upload manual photos (CC imports already have a fileId). Returns
 * {fileIds, fileTagsMap, skipped} — skipped counts photos that couldn't
 * upload (offline / failure).
 */
export async function preparePhotos(photos) {
  const fileIds = [];
  const fileTagsMap = {};
  let skipped = 0;
  for (const p of photos) {
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
  return { fileIds, fileTagsMap, skipped };
}

export default function PhotoAttach({ jobId, photos, setPhotos, tags, ccAvailable, onError }) {
  const fileInputRef = useRef(null);
  const [ccOpen, setCcOpen] = useState(false);
  const [ccPhotos, setCcPhotos] = useState(undefined);
  const [ccProject, setCcProject] = useState(null);
  const [ccMine, setCcMine] = useState(false);
  const [ccSelected, setCcSelected] = useState(() => new Set());
  const [ccBusy, setCcBusy] = useState(false);

  function addPhotos(e) {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      setPhotos((list) => [
        ...list,
        ...files.map((file) => ({ key: nextPhotoKey++, file, url: URL.createObjectURL(file), tagId: null }))
      ]);
    }
    e.target.value = '';
  }

  function removePhoto(key) {
    setPhotos((list) => {
      const p = list.find((x) => x.key === key);
      if (p?.file) URL.revokeObjectURL(p.url);
      return list.filter((x) => x.key !== key);
    });
  }

  function setPhotoTag(key, tagId) {
    setPhotos((list) => list.map((p) => (p.key === key ? { ...p, tagId: tagId || null } : p)));
  }

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
      onError?.(e.message || 'Could not load CompanyCam photos.');
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
      onError?.(e.message || 'CompanyCam import failed.');
    } finally {
      setCcBusy(false);
    }
  }

  return (
    <>
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

      {/* CompanyCam photo picker */}
      <Sheet open={ccOpen} title={`CompanyCam — ${ccProject?.name || ''}`} onClose={() => setCcOpen(false)}>
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
    </>
  );
}
