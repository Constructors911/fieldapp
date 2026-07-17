import React from 'react';
import './components.css';

// Checkbox: 44px touch-target checkbox button (visual box is 24px).
// Props: checked (bool), onChange (fn, called with no args), disabled?, label? (aria-label).
export default function Checkbox({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      className="c-checkbox"
      role="checkbox"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span className={checked ? 'c-checkbox-box checked' : 'c-checkbox-box'}>
        {checked ? '✓' : ''}
      </span>
    </button>
  );
}
