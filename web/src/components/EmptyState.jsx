import React from 'react';
import './components.css';

// EmptyState: friendly "nothing here" block.
// Props: icon? (string/emoji), title (string), hint? (string), action? (node, e.g. a retry button).
export default function EmptyState({ icon, title, hint, action }) {
  return (
    <div className="c-empty">
      {icon && <div className="c-empty-icon" aria-hidden="true">{icon}</div>}
      <p className="c-empty-title">{title}</p>
      {hint && <p className="c-empty-hint">{hint}</p>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
