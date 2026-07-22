import React from 'react';
import Sheet from '../components/Sheet.jsx';
import Spinner from '../components/Spinner.jsx';
import Checkbox from '../components/Checkbox.jsx';
import PhotoAttach from '../components/PhotoAttach.jsx';
import { fmtTime, fmtMins } from '../lib/clockHelpers.js';

// Clock-out confirm sheet: "just a break" vs "done for the day" (which gates
// on today's daily log for the job), plus the mini-log form when required.
// Clock.jsx owns all the state/handlers below and stays the orchestrator.
export default function ClockOutSheet({
  open,
  onClose,
  current,
  runningMins,
  outMode,
  onChooseOutMode,
  logExists,
  outTasks,
  onToggleTask,
  onToggleSubtask,
  doneText,
  onDoneTextChange,
  neededText,
  onNeededTextChange,
  outConcerns,
  onConcernsChange,
  outComplete,
  onCompleteChange,
  outPhotos,
  setOutPhotos,
  tags,
  ccAvailable,
  actionErr,
  onPhotoError,
  breakMin,
  onBreakMinChange,
  busy,
  onSubmit,
}) {
  return (
    <Sheet open={open} title="Clock out?" onClose={onClose}>
      {current && (
        <div className="clk-review">
          <p><strong>{current.jobName}</strong></p>
          <p className="muted">
            {current.costItemName} · started {fmtTime(current.startedAt)} · {fmtMins(runningMins)} so far
          </p>
        </div>
      )}

      {/* Step 1: why are you clocking out? */}
      {outMode === null && (
        <>
          <p className="clk-outq">Done at this job for today?</p>
          <button
            type="button"
            className="c-btn c-btn-big c-btn-block"
            onClick={() => onChooseOutMode('done')}
          >
            ✅ Done for the day
          </button>
          <button
            type="button"
            className="c-btn c-btn-big c-btn-block c-btn-ghost"
            style={{ marginTop: 8 }}
            onClick={() => onChooseOutMode('break')}
          >
            🥪 Just a break — I&apos;ll be back
          </button>
        </>
      )}

      {/* Step 2: done-for-the-day requires today's daily log for this job */}
      {outMode === 'done' && logExists === undefined && <Spinner label="Checking today's log…" />}
      {outMode === 'done' && logExists === true && (
        <p className="clk-logok">✓ Daily log already submitted for this job today.</p>
      )}
      {outMode === 'done' && logExists === false && (
        <>
          <p className="clk-logreq">
            A quick daily log is required before you leave. Photos help: Before, During, After, Concerns.
          </p>

          {outTasks === null && <Spinner label="Loading today's tasks…" />}
          {Array.isArray(outTasks) && outTasks.length > 0 && (
            <>
              <p className="c-label">Today&apos;s tasks on this job — check off what you finished</p>
              <div className="clk-tasklist">
                {outTasks.map((t) => (
                  <div key={t.id}>
                    <div className="clk-taskline">
                      <Checkbox
                        checked={t.progress >= 1}
                        onChange={() => onToggleTask(t)}
                        label={`Mark ${t.name} ${t.progress >= 1 ? 'incomplete' : 'complete'}`}
                      />
                      <span className={t.progress >= 1 ? 'clk-taskname done' : 'clk-taskname'}>{t.name}</span>
                    </div>
                    {(t.subtasks || []).map((sub) => (
                      <div key={sub.id} className="clk-taskline clk-subline-task">
                        <Checkbox
                          checked={!!sub.isComplete}
                          onChange={() => onToggleSubtask(t, sub)}
                          label={`Mark subtask ${sub.name} ${sub.isComplete ? 'incomplete' : 'complete'}`}
                        />
                        <span className={sub.isComplete ? 'clk-taskname done' : 'clk-taskname'}>{sub.name}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
          <label className="c-label" htmlFor="clk-done">What got done today?</label>
          <textarea
            id="clk-done"
            className="c-input"
            rows={3}
            placeholder="Plain words are fine — tore off north slope, dried in, staged shingles…"
            value={doneText}
            onChange={(e) => onDoneTextChange(e.target.value)}
          />
          <label className="c-label" htmlFor="clk-needed">What&apos;s still needed? (optional)</label>
          <textarea
            id="clk-needed"
            className="c-input"
            rows={2}
            placeholder="Ridge cap, final cleanup, inspection…"
            value={neededText}
            onChange={(e) => onNeededTextChange(e.target.value)}
          />

          <div className="c-checkrow" style={{ marginTop: 10 }}>
            <label className="c-check">
              <input type="checkbox" checked={outConcerns} onChange={(e) => onConcernsChange(e.target.checked)} />
              ⚠️ Concerns
            </label>
            <label className="c-check">
              <input type="checkbox" checked={outComplete} onChange={(e) => onCompleteChange(e.target.checked)} />
              ✅ Work complete
            </label>
          </div>
          {(outConcerns || outComplete) && (
            <p className="c-check-hint">
              Remember photos tagged {[outConcerns && '"Concerns"', outComplete && '"Completion"'].filter(Boolean).join(' and ')}.
            </p>
          )}
          <PhotoAttach
            jobId={current?.jobId}
            photos={outPhotos}
            setPhotos={setOutPhotos}
            tags={tags}
            ccAvailable={ccAvailable}
            onError={onPhotoError}
          />
        </>
      )}

      {/* Errors must be visible inside the sheet, not behind it. */}
      {actionErr && <p className="login-err" role="alert">{actionErr}</p>}

      {outMode !== null && (
        <>
          <label className="c-label" htmlFor="clk-break">Break minutes (optional)</label>
          <input
            id="clk-break"
            className="c-input"
            type="number"
            inputMode="numeric"
            min="0"
            step="5"
            placeholder="0"
            value={breakMin}
            onChange={(e) => onBreakMinChange(e.target.value)}
          />
          <button
            type="button"
            className="c-btn c-btn-big c-btn-block c-btn-red"
            style={{ marginTop: 12 }}
            disabled={busy || (outMode === 'done' && logExists === undefined)}
            onClick={onSubmit}
          >
            {busy && <Spinner inline size={18} />}
            {busy
              ? 'Clocking out…'
              : outMode === 'done' && logExists === false
                ? 'Submit log & clock out'
                : 'Confirm Clock Out'}
          </button>
        </>
      )}

      <button
        type="button"
        className="c-btn c-btn-block c-btn-ghost"
        style={{ marginTop: 8 }}
        disabled={busy}
        onClick={onClose}
      >
        Keep working
      </button>
    </Sheet>
  );
}
