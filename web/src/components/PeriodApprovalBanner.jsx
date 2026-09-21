import React from 'react';

export default function PeriodApprovalBanner({ onReview }) {
  return (
    <div className="hrs-ready" role="status">
      <p>Last period hours are ready to approve. Open Hours → Last period to check them.</p>
      {onReview && (
        <button type="button" className="c-btn c-btn-small c-btn-green" onClick={onReview}>
          Review hours
        </button>
      )}
    </div>
  );
}

export function needsPeriodApproval(status) {
  return Boolean(status?.reviewRequested && !status.approval);
}
