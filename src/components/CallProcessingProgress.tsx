import type { CallProcessingProgress as Progress, ProcessingStageId } from "../shared/callProcessingLifecycle.js";
import type { CallStatus } from "../shared/calls.js";

const STAGES: Array<{ id: ProcessingStageId; label: string }> = [
  { id: "recording", label: "Recording uploaded" },
  { id: "transcription", label: "Transcribing call" },
  { id: "analysis", label: "Analyzing conversation" },
  { id: "workflow", label: "Applying workflow rules" },
  { id: "review", label: "Ready for review" },
];

export function CallProcessingProgress({
  progress,
  callStatus,
  errorMessage,
  canRetry,
  forceAttention = false,
  onRetry,
}: {
  progress: Progress;
  callStatus: CallStatus;
  errorMessage: string | null;
  canRetry: boolean;
  forceAttention?: boolean;
  onRetry: () => void;
}) {
  if (progress.mode === "idle" && !forceAttention) return null;

  if (progress.mode === "ready" && !forceAttention) {
    return (
      <section className="processing-progress processing-progress-complete" aria-label="Call processing complete" role="status">
        <span className="processing-progress-check" aria-hidden="true">✓</span>
        <div>
          <strong>Ready for review</strong>
          <span>Transcript, analysis, and workflow outcome are saved.</span>
        </div>
      </section>
    );
  }

  if (progress.mode === "attention" || forceAttention) {
    return (
      <section className="processing-progress processing-progress-attention" aria-label="Call processing needs attention" role="alert">
        <div className="processing-attention-recording">
          <span className="processing-progress-check" aria-hidden="true">✓</span>
          <div>
            <strong>Recording uploaded</strong>
            <span>The recording is safely saved.</span>
          </div>
        </div>
        <div className="processing-attention-message">
          <span className="processing-attention-icon" aria-hidden="true">!</span>
          <div>
            <strong>Processing needs attention</strong>
            <span>{errorMessage ?? "The saved call needs review before processing can continue."}</span>
          </div>
        </div>
        {canRetry && (
          <button className="primary-button processing-retry-button" type="button" onClick={onRetry}>
            Retry processing
          </button>
        )}
      </section>
    );
  }

  const activeLabel = STAGES.find((stage) => stage.id === progress.active)?.label;
  const announcement = callStatus === "UPLOADED"
    ? "Recording uploaded. Processing is starting."
    : activeLabel
      ? `${activeLabel}…`
      : "Call processing is underway.";

  return (
    <section className="processing-progress" aria-label="Call processing progress">
      <ol className="processing-stages">
        {STAGES.map((stage, index) => {
          const isComplete = progress.completed.includes(stage.id);
          const isActive = progress.active === stage.id;
          const state = isComplete ? "complete" : isActive ? "active" : "pending";
          return (
            <li
              className={`processing-stage processing-stage-${state}`}
              key={stage.id}
              aria-current={isActive ? "step" : undefined}
            >
              <span className="processing-stage-marker" aria-hidden="true">
                {isComplete ? "✓" : isActive ? <span className="spinner" /> : String(index + 1)}
              </span>
              <span className="processing-stage-label">{stage.label}</span>
            </li>
          );
        })}
      </ol>
      {progress.active === null && progress.mode === "processing" && (
        <div className="processing-start-message">
          <span className="spinner" aria-hidden="true" />
          <span>Processing is starting.</span>
        </div>
      )}
      <p className="processing-progress-announcement" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}
