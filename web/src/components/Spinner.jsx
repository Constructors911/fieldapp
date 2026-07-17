import React from 'react';
import './components.css';

// Spinner: loading indicator.
// Props: label? (string shown beside spinner), size? (px, default 22), inline? (no padding wrapper).
export default function Spinner({ label, size = 22, inline = false }) {
  const dot = <span className="c-spinner" style={{ width: size, height: size }} aria-hidden="true" />;
  if (inline) return dot;
  return (
    <div className="c-spinner-wrap" role="status" aria-live="polite">
      {dot}
      <span>{label || 'Loading…'}</span>
    </div>
  );
}
