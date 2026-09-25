import type { CallActionPolicyState } from "./actions.js";
import type { CallStatus } from "./calls.js";

export type ProcessTrigger = "fresh-upload" | "manual-recovery" | "page-load";
export type ProcessStartReason = "already_in_flight" | "already_started" | "not_processable" | "page_load_does_not_process";
export type ProcessStartResult<T> = { started: true; value: T } | { started: false; reason: ProcessStartReason };

type ProcessableCall = { id: string; status: CallStatus };

const MANUALLY_PROCESSABLE_STATUSES = new Set<CallStatus>(["UPLOADED", "FAILED", "NEEDS_REVIEW"]);

export class CallProcessingCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly autoStarted = new Set<string>();

  async run<T>(
    call: ProcessableCall,
    trigger: ProcessTrigger,
    request: (callId: string) => Promise<T>,
  ): Promise<ProcessStartResult<T>> {
    if (trigger === "page-load") {
      return { started: false, reason: "page_load_does_not_process" };
    }
    if (this.inFlight.has(call.id)) {
      return { started: false, reason: "already_in_flight" };
    }
    if (trigger === "fresh-upload") {
      if (call.status !== "UPLOADED") return { started: false, reason: "not_processable" };
      if (this.autoStarted.has(call.id)) return { started: false, reason: "already_started" };
      this.autoStarted.add(call.id);
    } else if (!MANUALLY_PROCESSABLE_STATUSES.has(call.status)) {
      return { started: false, reason: "not_processable" };
    }

    this.inFlight.add(call.id);
    try {
      return { started: true, value: await request(call.id) };
    } finally {
      this.inFlight.delete(call.id);
    }
  }
}

export type ProcessingStageId = "recording" | "transcription" | "analysis" | "workflow" | "review";
export type ProcessingMode = "idle" | "processing" | "ready" | "attention";

export type CallProcessingProgress = {
  mode: ProcessingMode;
  completed: ProcessingStageId[];
  active: ProcessingStageId | null;
  errorStage: ProcessingStageId | null;
};

export type CallProcessingProgressInput = {
  status: CallStatus;
  hasTranscript: boolean;
  hasAnalysis: boolean;
  actionPolicyState: CallActionPolicyState;
  requestPending: boolean;
};

const ALL_STAGES: ProcessingStageId[] = ["recording", "transcription", "analysis", "workflow", "review"];
const TERMINAL_CALL_STATUSES = new Set<CallStatus>(["ANALYZED", "FAILED", "NEEDS_REVIEW"]);

export function mapCallProcessingProgress(input: CallProcessingProgressInput): CallProcessingProgress {
  const { status, hasTranscript, hasAnalysis, actionPolicyState, requestPending } = input;
  const persistedStages: ProcessingStageId[] = ["recording"];
  if (hasTranscript) persistedStages.push("transcription");
  if (hasAnalysis) persistedStages.push("analysis");

  if (status === "FAILED" || status === "NEEDS_REVIEW") {
    const errorStage: ProcessingStageId = !hasTranscript
      ? "transcription"
      : !hasAnalysis
        ? "analysis"
        : "workflow";
    return { mode: "attention", completed: completedBefore(errorStage, persistedStages), active: null, errorStage };
  }

  if (status === "UPLOADED") {
    return requestPending
      ? { mode: "processing", completed: ["recording"], active: null, errorStage: null }
      : { mode: "idle", completed: ["recording"], active: null, errorStage: null };
  }

  if (status === "PROCESSING") {
    if (hasAnalysis) {
      return { mode: "processing", completed: persistedStages, active: "workflow", errorStage: null };
    }
    if (hasTranscript) {
      return { mode: "processing", completed: persistedStages, active: "analysis", errorStage: null };
    }
    return { mode: "processing", completed: persistedStages, active: "transcription", errorStage: null };
  }

  if (status === "TRANSCRIBED" && hasAnalysis) {
    return { mode: "processing", completed: persistedStages, active: "workflow", errorStage: null };
  }

  if (status === "TRANSCRIBED") {
    return { mode: "processing", completed: persistedStages, active: "analysis", errorStage: null };
  }

  if (status === "ANALYZED" && (!hasAnalysis || actionPolicyState === "ACTION_AVAILABLE" || actionPolicyState === "NOT_READY")) {
    const completed = hasAnalysis ? persistedStages : completedBefore("analysis", persistedStages);
    return { mode: "processing", completed, active: hasAnalysis ? "workflow" : "analysis", errorStage: null };
  }

  if (status === "ANALYZED") {
    return { mode: "ready", completed: ALL_STAGES, active: null, errorStage: null };
  }

  return { mode: "idle", completed: persistedStages, active: null, errorStage: null };
}

function completedBefore(stage: ProcessingStageId, persisted: ProcessingStageId[]): ProcessingStageId[] {
  const stageIndex = ALL_STAGES.indexOf(stage);
  return persisted.filter((candidate) => ALL_STAGES.indexOf(candidate) < stageIndex);
}

type PolledCallDetail = { call: { status: CallStatus } };
type ProcessingPollWait = (intervalMs: number, signal?: AbortSignal) => Promise<void>;

export type PollCallUntilTerminalResult<T> =
  | { reason: "terminal"; detail: T }
  | { reason: "aborted" }
  | { reason: "limit" };

export async function pollCallUntilTerminal<T extends PolledCallDetail>(options: {
  callId: string;
  readCall: (callId: string, signal?: AbortSignal) => Promise<T>;
  onUpdate?: (detail: T) => void;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  intervalMs?: number;
  maxAttempts?: number;
  wait?: ProcessingPollWait;
}): Promise<PollCallUntilTerminalResult<T>> {
  const {
    callId,
    readCall,
    onUpdate,
    onError,
    signal,
    intervalMs = 1500,
    maxAttempts = 120,
    wait = waitForPollInterval,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) return { reason: "aborted" };
    await wait(intervalMs, signal);
    if (signal?.aborted) return { reason: "aborted" };

    let detail: T;
    try {
      detail = await readCall(callId, signal);
    } catch (error) {
      if (signal?.aborted) return { reason: "aborted" };
      onError?.(error);
      continue;
    }
    if (signal?.aborted) return { reason: "aborted" };
    onUpdate?.(detail);
    if (TERMINAL_CALL_STATUSES.has(detail.call.status)) return { reason: "terminal", detail };
  }

  return signal?.aborted ? { reason: "aborted" } : { reason: "limit" };
}

function waitForPollInterval(intervalMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, intervalMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
