import React, { useEffect } from 'react';
import './components.css';

// Sheet: bottom modal. Renders nothing when open=false.
// Props: open (bool), title (string), onClose (fn), children.
// Closes on overlay tap, X button, or Escape.
export default function Sheet({ open, title, onClose, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // lock background scroll on mobile
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="c-sheet-overlay" onClick={onClose}>
      <div className="c-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="c-sheet-head">
          <h2 className="c-sheet-title">{title}</h2>
          <button type="button" className="c-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="c-sheet-body">{children}</div>
      </div>
    </div>
  );
}
