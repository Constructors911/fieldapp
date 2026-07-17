import React from 'react';
import './components.css';

// ErrorBanner: inline error with optional retry.
// Props: message (string), onRetry? (fn — renders a Retry button), onDismiss? (fn — renders X).
export default function ErrorBanner({ message, onRetry, onDismiss }) {
  if (!message) return null;
  return (
    <div className="c-error" role="alert">
      <span>{message}</span>
      {onRetry && <button type="button" className="c-error-retry" onClick={onRetry}>Retry</button>}
      {onDismiss && !onRetry && (
        <button type="button" className="c-error-retry" onClick={onDismiss} aria-label="Dismiss">×</button>
      )}
    </div>
  );
}
