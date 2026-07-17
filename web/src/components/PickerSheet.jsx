import React from 'react';
import Sheet from './Sheet.jsx';
import EmptyState from './EmptyState.jsx';
import './components.css';

// PickerSheet: bottom-sheet list picker.
// Props:
//   open (bool), title (string), onClose (fn)
//   options: [{ id, label, sub? }]  — sub is a smaller secondary line
//   onSelect: (option) => void
//   emptyText?: message when options is empty
export default function PickerSheet({ open, title, onClose, options = [], onSelect, emptyText = 'Nothing to pick' }) {
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {options.length === 0 ? (
        <EmptyState title={emptyText} />
      ) : (
        options.map((opt) => (
          <button key={opt.id} type="button" className="c-option" onClick={() => onSelect(opt)}>
            {opt.label}
            {opt.sub && <span className="c-option-sub">{opt.sub}</span>}
          </button>
        ))
      )}
    </Sheet>
  );
}
