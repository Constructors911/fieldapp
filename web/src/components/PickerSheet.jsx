import React, { useState, useEffect } from 'react';
import Sheet from './Sheet.jsx';
import EmptyState from './EmptyState.jsx';
import './components.css';

// PickerSheet: bottom-sheet list picker.
// Props:
//   open (bool), title (string), onClose (fn)
//   options: [{ id, label, sub? }]  — sub is a smaller secondary line
//   onSelect: (option) => void
//   emptyText?: message when options is empty
// A search box appears automatically when the list is long (>8 options),
// matching against label and sub (job number, name, address, cost code...).
export default function PickerSheet({ open, title, onClose, options = [], onSelect, emptyText = 'Nothing to pick' }) {
  const [query, setQuery] = useState('');

  // Fresh search every time the sheet opens.
  useEffect(() => { if (open) setQuery(''); }, [open]);

  const searchable = options.length > 8;
  const q = query.trim().toLowerCase();
  const visible = !searchable || !q
    ? options
    : options.filter((opt) =>
      `${opt.label} ${opt.sub ?? ''}`.toLowerCase().includes(q));

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {searchable && (
        <input
          type="search"
          className="c-input c-picker-search"
          placeholder="Search…"
          value={query}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {options.length === 0 ? (
        <EmptyState title={emptyText} />
      ) : visible.length === 0 ? (
        <EmptyState title={`No matches for “${query.trim()}”`} />
      ) : (
        visible.map((opt) => (
          <button key={opt.id} type="button" className="c-option" onClick={() => onSelect(opt)}>
            {opt.label}
            {opt.sub && <span className="c-option-sub">{opt.sub}</span>}
          </button>
        ))
      )}
    </Sheet>
  );
}
