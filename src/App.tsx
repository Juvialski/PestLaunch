import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiErrorResponse,
  CallAnalysisRow,
  CallRecord,
  CallSummary,
  CallTranscriptRow,
} from "./shared/calls.js";
import type { AgentActionRow, DemoCustomer } from "./shared/actions.js";
import { buildCallTimeline } from "./shared/actionTimeline.js";
import { AUDIO_PLAYBACK_ERROR, visibleCallError } from "./shared/callErrorFeedback.js";
import { MAX_AUDIO_UPLOAD_BYTES } from "./shared/calls.js";

const ACCEPTED_EXTENSIONS = new Set(["mp3", "wav", "m4a", "webm"]);
const ACCEPTED_FORMATS = "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/webm,.mp3,.wav,.m4a,.webm";

type UploadState = "idle" | "uploading" | "success" | "error";
type CallsState = "loading" | "ready" | "error";
type DetailState = "idle" | "loading" | "ready" | "error";
type ProcessState = "idle" | "processing" | "success" | "error";
type ActionRequestState = "idle" | "proposing" | "approving" | "rejecting";
type CallDetailPayload = {
  call: CallRecord;
  transcript: CallTranscriptRow | null;
  analysis: CallAnalysisRow | null;
  demoCustomer: DemoCustomer | null;
  actions: AgentActionRow[];
};
type ApiPayload = {
  calls?: CallSummary[];
  customers?: DemoCustomer[];
  call?: CallRecord;
  transcript?: CallTranscriptRow | null;
  analysis?: CallAnalysisRow | null;
  demoCustomer?: DemoCustomer | null;
  actions?: AgentActionRow[];
  action?: AgentActionRow | null;
  reason?: string;
  error?: ApiErrorResponse["error"];
};

async function fetchRecentCalls(): Promise<CallSummary[]> {
  const response = await fetch("/api/calls");
  const payload = (await response.json()) as ApiPayload;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Recent calls could not be loaded.");
  }
  return payload.calls ?? [];
}

async function fetchCallDetail(callId: string): Promise<CallDetailPayload> {
  const response = await fetch(`/api/calls/${callId}`);
  const payload = (await response.json()) as ApiPayload;
  if (!response.ok || !payload.call) {
    throw new Error(payload.error?.message ?? "Call details could not be loaded.");
  }
  return {
    call: payload.call,
    transcript: payload.transcript ?? null,
    analysis: payload.analysis ?? null,
    demoCustomer: payload.demoCustomer ?? null,
    actions: payload.actions ?? [],
  };
}

async function fetchDemoCustomers(): Promise<DemoCustomer[]> {
  const response = await fetch("/api/demo/customers");
  const payload = (await response.json()) as ApiPayload;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Synthetic demo customers could not be loaded.");
  }
  return payload.customers ?? [];
}

export default function App() {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [callsState, setCallsState] = useState<CallsState>("loading");
  const [callsError, setCallsError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [callerName, setCallerName] = useState("");
  const [demoCustomers, setDemoCustomers] = useState<DemoCustomer[]>([]);
  const [demoCustomersLoaded, setDemoCustomersLoaded] = useState(false);
  const [selectedDemoCustomerId, setSelectedDemoCustomerId] = useState("");
  const [demoResetState, setDemoResetState] = useState<"idle" | "resetting" | "error">("idle");
  const [demoMessage, setDemoMessage] = useState("");
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMessage, setUploadMessage] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [callDetail, setCallDetail] = useState<CallDetailPayload | null>(null);
  const [detailState, setDetailState] = useState<DetailState>("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [processState, setProcessState] = useState<ProcessState>("idle");
  const [processError, setProcessError] = useState<string | null>(null);
  const [actionRequestState, setActionRequestState] = useState<ActionRequestState>("idle");
  const [actionRequestError, setActionRequestError] = useState<string | null>(null);
  const [actionRequestNotice, setActionRequestNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const detailRequestRef = useRef(0);
  const selectedCallIdRef = useRef<string | null>(null);

  const loadCalls = useCallback(async () => {
    setCallsState("loading");
    setCallsError(null);
    try {
      const nextCalls = await fetchRecentCalls();
      setCalls(nextCalls);
      setCallsState("ready");
    } catch (error) {
      setCallsError(error instanceof Error ? error.message : "Recent calls could not be loaded.");
      setCallsState("error");
    }
  }, []);

  const retryCalls = () => {
    void loadCalls();
  };

  const loadCallDetail = useCallback(async (callId: string) => {
    const requestId = ++detailRequestRef.current;
    setDetailState("loading");
    setDetailError(null);
    try {
      const nextDetail = await fetchCallDetail(callId);
      if (requestId !== detailRequestRef.current) return;
      setCallDetail(nextDetail);
      setDetailState("ready");
    } catch (error) {
      if (requestId !== detailRequestRef.current) return;
      setDetailError(error instanceof Error ? error.message : "Call details could not be loaded.");
      setDetailState("error");
    }
  }, []);

  const loadDemoCustomers = useCallback(async () => {
    const nextCustomers = await fetchDemoCustomers();
    setDemoCustomers(nextCustomers);
    return nextCustomers;
  }, []);

  const runActionRequest = async (
    callId: string | null,
    state: Exclude<ActionRequestState, "idle">,
    url: string,
  ) => {
    if (actionRequestState !== "idle") return;
    setActionRequestState(state);
    setActionRequestError(null);
    setActionRequestNotice(null);
    try {
      const response = await fetch(url, { method: "POST" });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok) throw new Error(payload.error?.message ?? "The action request could not be completed.");
      if (payload.reason === "NO_PERMITTED_ACTION") {
        setActionRequestNotice("No deterministic action applies to this validated analysis.");
      }
    } catch (error) {
      setActionRequestError(error instanceof Error ? error.message : "The action request could not be completed.");
    } finally {
      if (callId && selectedCallIdRef.current === callId) await loadCallDetail(callId);
      setActionRequestState("idle");
    }
  };

  const handleDemoReset = async () => {
    if (demoResetState === "resetting" || actionRequestState !== "idle" || !demoCustomersLoaded) return;
    setDemoResetState("resetting");
    setDemoMessage("");
    try {
      const response = await fetch("/api/demo/reset", { method: "POST" });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok) throw new Error(payload.error?.message ?? "Synthetic demo customers could not be reset.");
      if (payload.customers) setDemoCustomers(payload.customers);
      else await loadDemoCustomers();
      if (selectedCallIdRef.current) await loadCallDetail(selectedCallIdRef.current);
      setDemoMessage("The three synthetic demo customers are ready. Existing calls and action history were kept.");
      setDemoResetState("idle");
    } catch (error) {
      setDemoMessage(error instanceof Error ? error.message : "Synthetic demo customers could not be reset.");
      setDemoResetState("error");
    }
  };

  const selectCall = (callId: string) => {
    selectedCallIdRef.current = callId;
    setSelectedCallId(callId);
    setCallDetail(null);
    setProcessState("idle");
    setProcessError(null);
    setActionRequestError(null);
    setActionRequestNotice(null);
    void loadCallDetail(callId);
  };

  const handleProcessCall = async () => {
    if (!callDetail || processState === "processing" || callDetail.call.status === "PROCESSING") return;
    const callId = callDetail.call.id;
    setProcessState("processing");
    setProcessError(null);
    setCallDetail((current) =>
      current ? { ...current, call: { ...current.call, status: "PROCESSING" } } : current,
    );
    setCalls((current) => current.map((call) => (call.id === callId ? { ...call, status: "PROCESSING" } : call)));

    try {
      const response = await fetch(`/api/calls/${callId}/process`, { method: "POST" });
      const payload = (await response.json()) as ApiPayload;
      if (payload.call && selectedCallIdRef.current === callId) {
        setCallDetail({
          call: payload.call,
          transcript: payload.transcript ?? null,
          analysis: payload.analysis ?? null,
          demoCustomer: payload.demoCustomer ?? null,
          actions: payload.actions ?? [],
        });
      }
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "Call processing could not be completed.");
      }
      if (selectedCallIdRef.current === callId) setProcessState("success");
      if (payload.analysis && selectedCallIdRef.current === callId) {
        await runActionRequest(callId, "proposing", `/api/calls/${callId}/actions/propose`);
      }
    } catch (error) {
      if (selectedCallIdRef.current === callId) {
        setProcessState("error");
        setProcessError(error instanceof Error ? error.message : "Call processing could not be completed.");
      }
    } finally {
      if (selectedCallIdRef.current === callId) {
        await loadCallDetail(callId);
      }
      await loadCalls();
    }
  };

  useEffect(() => {
    let active = true;
    void fetchRecentCalls()
      .then((nextCalls) => {
        if (!active) {
          return;
        }
        setCalls(nextCalls);
        setCallsState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setCallsError(error instanceof Error ? error.message : "Recent calls could not be loaded.");
        setCallsState("error");
      });
    void fetchDemoCustomers()
      .then((nextCustomers) => {
        if (active) {
          setDemoCustomers(nextCustomers);
          setDemoCustomersLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setDemoMessage(error instanceof Error ? error.message : "Synthetic demo customers could not be loaded.");
          setDemoResetState("error");
          setDemoCustomersLoaded(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const chooseFile = (file: File | undefined) => {
    if (!file || uploadState === "uploading") {
      return;
    }

    const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    if (!ACCEPTED_EXTENSIONS.has(extension)) {
      setSelectedFile(null);
      setUploadState("error");
      setUploadMessage("Choose an MP3, WAV, M4A, or WebM audio file.");
      return;
    }

    if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
      setSelectedFile(null);
      setUploadState("error");
      setUploadMessage("Audio must be 25 MB or smaller.");
      return;
    }

    if (file.size === 0) {
      setSelectedFile(null);
      setUploadState("error");
      setUploadMessage("Choose a non-empty audio file.");
      return;
    }

    setSelectedFile(file);
    setUploadState("idle");
    setUploadMessage("");
  };

  const handleUpload = async () => {
    if (!selectedFile || uploadState === "uploading") {
      return;
    }

    const formData = new FormData();
    formData.append("audio", selectedFile, selectedFile.name);
    if (callerName.trim()) {
      formData.append("caller_name", callerName.trim());
    }
    if (selectedDemoCustomerId) {
      formData.append("demo_customer_id", selectedDemoCustomerId);
    }
    setUploadState("uploading");
    setUploadMessage("");

    try {
      const response = await fetch("/api/calls/ingest", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "The audio could not be uploaded.");
      }

      const uploadedName = selectedFile.name;
      setSelectedFile(null);
      setCallerName("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setUploadState("success");
      setUploadMessage(`${uploadedName} was added to recent calls.`);
      await loadCalls();
    } catch (error) {
      setUploadState("error");
      setUploadMessage(error instanceof Error ? error.message : "The audio could not be uploaded.");
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    chooseFile(event.dataTransfer.files[0]);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="PestLaunch Call Intelligence home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path d="M25.9 5.3C15.7 5.4 8.6 8.5 7.4 16.2c-.7 4.4 2.1 7.5 6.1 7.5 8.4 0 11.8-8.3 12.4-18.4Z" fill="currentColor" />
              <path d="M6.3 26.6c3.8-6.2 8.2-10.4 14.2-14.1" stroke="#f5f7f2" strokeLinecap="round" strokeWidth="1.8" />
            </svg>
          </span>
          <span className="brand-name">PestLaunch</span>
        </a>
        <span className="prototype-tag">Interview prototype</span>
      </header>

      <main id="top" className="main-content">
        <section className="page-heading" aria-labelledby="page-title">
          <p className="eyebrow">CALL WORKSPACE</p>
          <h1 id="page-title">Call Intelligence</h1>
          <p className="page-description">
            Bring a conversation into focus. Upload a recording to start its journey through the call workflow.
          </p>
        </section>

        <section className="upload-card" aria-labelledby="upload-title">
          <div className="section-heading upload-heading">
            <div>
              <p className="eyebrow">NEW RECORDING</p>
              <h2 id="upload-title">Add a call recording</h2>
            </div>
            <span className="private-note">
              <LockIcon /> Private storage
            </span>
          </div>

          <input
            ref={fileInputRef}
            className="visually-hidden"
            id="audio-file"
            type="file"
            accept={ACCEPTED_FORMATS}
            disabled={uploadState === "uploading"}
            onChange={(event) => {
              chooseFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
            aria-describedby="upload-help upload-result"
          />
          <label
            className={`upload-dropzone${isDragging ? " is-dragging" : ""}${uploadState === "uploading" ? " is-disabled" : ""}`}
            htmlFor="audio-file"
            onDragEnter={(event) => {
              event.preventDefault();
              if (uploadState === "uploading") return;
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setIsDragging(false);
              }
            }}
            onDrop={handleDrop}
          >
            <span className="upload-icon" aria-hidden="true"><UploadIcon /></span>
            <span className="dropzone-copy">
              <strong>Drop an audio file here</strong>
              <span>or select a file from your device</span>
            </span>
            <span className="browse-button">Browse files</span>
          </label>

          <div className="caller-field">
            <label htmlFor="caller-name">Caller name <span>Optional</span></label>
            <input
              id="caller-name"
              type="text"
              value={callerName}
              maxLength={200}
              disabled={uploadState === "uploading"}
              placeholder="e.g. Sarah Johnson"
              onChange={(event) => setCallerName(event.currentTarget.value)}
            />
          </div>

          <div className="demo-customer-controls">
            <div className="demo-customer-select">
              <label htmlFor="demo-customer">Synthetic demo customer <span>Optional</span></label>
              <select
                id="demo-customer"
                value={selectedDemoCustomerId}
                disabled={uploadState === "uploading" || demoCustomers.length === 0}
                onChange={(event) => setSelectedDemoCustomerId(event.currentTarget.value)}
              >
                <option value="">No linked demo customer</option>
                {demoCustomers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name} · {formatStatus(customer.customer_type ?? "SYNTHETIC")}
                  </option>
                ))}
              </select>
              {demoCustomers.length === 0 && <span className="demo-customer-hint">Initialize the fixed demo records to associate a call.</span>}
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void handleDemoReset()}
              disabled={uploadState === "uploading" || demoResetState === "resetting" || actionRequestState !== "idle" || !demoCustomersLoaded}
            >
              {!demoCustomersLoaded ? "Loading demo data…" : demoResetState === "resetting" ? "Preparing demo data…" : demoCustomers.length === 0 ? "Initialize synthetic demo data" : "Reset synthetic demo data"}
            </button>
          </div>
          {demoMessage && <p className={`demo-message${demoResetState === "error" ? " is-error" : ""}`} role={demoResetState === "error" ? "alert" : "status"}>{demoMessage}</p>}

          <div className="upload-controls">
            <p id="upload-help" className="upload-help">MP3, WAV, M4A, or WebM · Up to 25 MB</p>
            <div className="upload-action-row">
              <div className="selected-file" aria-live="polite">
                {selectedFile ? (
                  <>
                    <span className="file-indicator" aria-hidden="true"><AudioIcon /></span>
                    <span className="selected-file-name" title={selectedFile.name}>{selectedFile.name}</span>
                  </>
                ) : (
                  <span className="no-file">No file selected</span>
                )}
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => void handleUpload()}
                disabled={!selectedFile || uploadState === "uploading"}
              >
                {uploadState === "uploading" ? <><span className="spinner" aria-hidden="true" /> Uploading</> : "Upload recording"}
              </button>
            </div>
            <p
              id="upload-result"
              className={`upload-result${uploadState === "error" ? " is-error" : ""}${uploadState === "success" ? " is-success" : ""}`}
              role={uploadState === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {uploadMessage}
            </p>
          </div>
        </section>

        <section className="recent-section" aria-labelledby="recent-title">
          <div className="section-heading recent-heading">
            <div>
              <p className="eyebrow">INBOX</p>
              <h2 id="recent-title">Recent calls</h2>
            </div>
            {callsState === "ready" && <span className="call-count">{calls.length} {calls.length === 1 ? "call" : "calls"}</span>}
          </div>

          <div className="calls-card">
            {callsState === "loading" ? (
              <div className="list-state"><span className="spinner" aria-hidden="true" /> Loading recent calls…</div>
            ) : callsState === "error" ? (
              <div className="list-state list-error" role="alert">
                <span>{callsError}</span>
                <button className="text-button" type="button" onClick={retryCalls}>Try again</button>
              </div>
            ) : calls.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon" aria-hidden="true"><AudioIcon /></span>
                <strong>No calls yet</strong>
                <span>Your uploaded recordings will appear here.</span>
              </div>
            ) : (
              <ul className="call-list">
                {calls.map((call) => (
                  <li key={call.id}>
                    <button
                      className={`call-row${selectedCallId === call.id ? " is-selected" : ""}`}
                      type="button"
                      aria-current={selectedCallId === call.id ? "true" : undefined}
                      onClick={() => selectCall(call.id)}
                    >
                      <span className="call-file-icon" aria-hidden="true"><AudioIcon /></span>
                      <span className="call-main">
                        <span className="call-name">{call.caller_name?.trim() || "Unassigned call"}</span>
                        <span className="call-filename" title={call.original_filename}>{call.original_filename}</span>
                      </span>
                      <time className="call-date" dateTime={call.created_at}>{formatDate(call.created_at)}</time>
                      <span className={`status-pill status-${call.status.toLowerCase().replaceAll("_", "-")}`}>
                        <span className="status-dot" aria-hidden="true" />{formatStatus(call.status)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="detail-section" aria-labelledby="detail-title">
          <div className="section-heading detail-section-heading">
            <div>
              <p className="eyebrow">REVIEW</p>
              <h2 id="detail-title">Call detail</h2>
            </div>
            {callDetail && <span className={`status-pill status-${callDetail.call.status.toLowerCase().replaceAll("_", "-")}`}>
              <span className="status-dot" aria-hidden="true" />{formatStatus(callDetail.call.status)}
            </span>}
          </div>
          <div className="call-detail-card">
            {detailState === "idle" ? (
              <div className="detail-empty">Select a recent call to review its recording and intelligence.</div>
            ) : detailState === "loading" ? (
              <div className="list-state"><span className="spinner" aria-hidden="true" /> Loading call detail…</div>
            ) : detailState === "error" ? (
              <div className="list-state list-error" role="alert">
                <span>{detailError}</span>
                {selectedCallId && <button className="text-button" type="button" onClick={() => void loadCallDetail(selectedCallId)}>Try again</button>}
              </div>
            ) : callDetail ? (
              <CallDetailWorkspace
                detail={callDetail}
                processState={processState}
                processError={processError}
                actionRequestState={actionRequestState}
                actionRequestError={actionRequestError}
                actionRequestNotice={actionRequestNotice}
                onProcess={() => void handleProcessCall()}
                onPropose={() => void runActionRequest(callDetail.call.id, "proposing", `/api/calls/${callDetail.call.id}/actions/propose`)}
                onDecision={(actionId, decision) => void runActionRequest(
                  callDetail.call.id,
                  decision === "approve" ? "approving" : "rejecting",
                  `/api/actions/${actionId}/${decision}`,
                )}
              />
            ) : null}
          </div>
        </section>
      </main>
      <footer className="app-footer">
        <span>Call Intelligence</span>
        <span>Upload and review call workflow status</span>
      </footer>
    </div>
  );
}

function CallDetailWorkspace({
  detail,
  processState,
  processError,
  actionRequestState,
  actionRequestError,
  actionRequestNotice,
  onProcess,
  onPropose,
  onDecision,
}: {
  detail: CallDetailPayload;
  processState: ProcessState;
  processError: string | null;
  actionRequestState: ActionRequestState;
  actionRequestError: string | null;
  actionRequestNotice: string | null;
  onProcess: () => void;
  onPropose: () => void;
  onDecision: (actionId: string, decision: "approve" | "reject") => void;
}) {
  const { call, transcript, analysis, demoCustomer, actions } = detail;
  const [audioPlaybackFailedCallId, setAudioPlaybackFailedCallId] = useState<string | null>(null);
  const visibleError = visibleCallError(processError, call.last_error);
  const intelligence = analysis?.analysis_json;
  const canProcess = call.status === "UPLOADED" || call.status === "FAILED" || call.status === "NEEDS_REVIEW";
  const isBusy = call.status === "PROCESSING" || processState === "processing";
  const isActionBusy = actionRequestState !== "idle";
  const timeline = buildCallTimeline(detail);
  const signals = intelligence
    ? [
        ["newLead", "New lead"],
        ["complaint", "Complaint"],
        ["cancellationRisk", "Cancellation risk"],
        ["upsellOpportunity", "Upsell opportunity"],
        ["reactivationOpportunity", "Reactivation opportunity"],
        ["collectionsIssue", "Collections issue"],
        ["followUpRequired", "Follow-up required"],
      ].filter(([key]) => intelligence.signals[key as keyof typeof intelligence.signals])
    : [];

  return (
    <div className="detail-grid">
      <section className="detail-panel" aria-labelledby="recording-title">
        <div className="detail-panel-heading">
          <p className="eyebrow">RECORDING</p>
          <h3 id="recording-title">{call.caller_name?.trim() || "Unassigned call"}</h3>
        </div>
        <dl className="recording-meta">
          <div><dt>File</dt><dd title={call.original_filename}>{call.original_filename}</dd></div>
          <div><dt>Received</dt><dd>{formatDate(call.created_at)}</dd></div>
          {call.duration !== null && <div><dt>Duration</dt><dd>{formatDuration(call.duration)}</dd></div>}
        </dl>
        <audio
          className="call-audio"
          controls
          preload="none"
          src={`/api/calls/${call.id}/audio`}
          aria-label={`Recording for ${call.caller_name?.trim() || call.original_filename}`}
          onError={() => setAudioPlaybackFailedCallId(call.id)}
          onPlaying={() => setAudioPlaybackFailedCallId(null)}
        >
          Your browser does not support audio playback.
        </audio>
        {audioPlaybackFailedCallId === call.id && (
          <p className="process-status is-error" role="alert">{AUDIO_PLAYBACK_ERROR}</p>
        )}

        <div className="transcript-heading">
          <div>
            <p className="eyebrow">TRANSCRIPT</p>
            <h3>Conversation</h3>
          </div>
          {transcript && <span className="model-note">{transcript.model_used}</span>}
        </div>
        {transcript ? (
          transcript.segments_json.length > 0 ? (
            <ol className="transcript-segments">
              {transcript.segments_json.map((segment, index) => (
                <li key={`${segment.speaker}-${segment.startMs ?? index}-${index}`}>
                  <div className="transcript-segment-meta">
                    <strong>{segment.speaker}</strong>
                    {(segment.startMs !== undefined || segment.endMs !== undefined) && (
                      <time>{formatSegmentTime(segment.startMs, segment.endMs)}</time>
                    )}
                  </div>
                  <p>{segment.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="transcript-plain">{transcript.text}</p>
          )
        ) : (
          <p className="detail-muted">The transcript will appear here after processing.</p>
        )}
      </section>

      <section className="detail-panel intelligence-panel" aria-labelledby="intelligence-title">
        <div className="intelligence-heading">
          <div className="detail-panel-heading">
            <p className="eyebrow">CALL INTELLIGENCE</p>
            <h3 id="intelligence-title">{intelligence ? formatStatus(intelligence.callType) : "Analysis"}</h3>
          </div>
          {intelligence && (
            <div className="analysis-badges">
              <span className={`priority-pill priority-${intelligence.priority.toLowerCase()}`}>{intelligence.priority} priority</span>
              <span className="confidence-pill">{Math.round(intelligence.confidence * 100)}% confidence</span>
            </div>
          )}
        </div>

        {canProcess && (
          <button className="primary-button process-button" type="button" onClick={onProcess} disabled={isBusy}>
            {isBusy ? <><span className="spinner" aria-hidden="true" /> Processing call</> : call.status === "UPLOADED" ? "Process call" : "Retry processing"}
          </button>
        )}
        {isBusy && <p className="process-status" role="status">Processing this call. Duplicate processing is disabled.</p>}
        {processState === "success" && call.status === "ANALYZED" && (
          <p className="process-status is-success" role="status">Transcript and call intelligence saved.</p>
        )}
        {visibleError && (
          processError
            ? <p className="process-status is-error" role="alert">{visibleError}</p>
            : <p className="last-error" role="alert">{visibleError}</p>
        )}

        {intelligence ? (
          <>
            <div className="analysis-copy">
              <div>
                <span className="field-label">Summary</span>
                <p>{intelligence.summary}</p>
              </div>
              <div>
                <span className="field-label">Customer intent</span>
                <p>{intelligence.customerIntent}</p>
              </div>
              <div className="analysis-inline-fields">
                <div><span className="field-label">Sentiment</span><strong>{formatStatus(intelligence.sentiment)}</strong></div>
                <div><span className="field-label">Outcome</span><strong>{formatStatus(intelligence.outcome)}</strong></div>
              </div>
            </div>

            <div className="signal-section">
              <span className="field-label">Signals</span>
              {signals.length > 0 ? (
                <ul className="signal-list">
                  {signals.map(([, label]) => <li key={label}>{label}</li>)}
                </ul>
              ) : <p className="detail-muted">No key signals detected.</p>}
            </div>

            <div className="evidence-section">
              <span className="field-label">Transcript evidence</span>
              <ul className="evidence-list">
                {intelligence.evidence.map((item, index) => (
                  <li key={`${item.quote}-${index}`}>
                    <blockquote>“{item.quote}”</blockquote>
                    {item.speaker && <span>{item.speaker}</span>}
                  </li>
                ))}
              </ul>
            </div>

            <div className="proposed-action ai-recommendation">
              <span className="field-label">AI recommendation · context only</span>
              {intelligence.recommendedAction ? (
                <div>
                  <strong>{formatStatus(intelligence.recommendedAction.type)}</strong>
                  <p>{intelligence.recommendedAction.reason}</p>
                  <span className="proposal-note">AI context only. This recommendation is never an executable command.</span>
                </div>
              ) : <p className="detail-muted">The model did not return a recommendation. Deterministic policy still evaluates the validated signals.</p>}
            </div>
            {analysis && <p className="model-note reasoning-model">Reasoning model · {analysis.model_used}</p>}
          </>
        ) : (
          <div className="analysis-empty">
            <strong>{call.status === "PROCESSING" ? "Analysis in progress" : "No validated analysis yet"}</strong>
            <span>Call classification and evidence will appear here after processing.</span>
          </div>
        )}

        {intelligence && (
          <section className="agent-proposal-section" aria-labelledby="agent-proposal-title">
            <div className="agent-proposal-heading">
              <div>
                <p className="eyebrow">APPLICATION POLICY</p>
                <h3 id="agent-proposal-title">Agent proposal</h3>
              </div>
              <span className="proposal-origin">Deterministic</span>
            </div>

            {actions.length === 0 ? (
              <div className="agent-proposal-empty">
                <p className="detail-muted">No deterministic proposal is saved for this call yet.</p>
                <button className="secondary-button" type="button" onClick={onPropose} disabled={isActionBusy}>
                  {actionRequestState === "proposing" ? <><span className="spinner" aria-hidden="true" /> Creating proposal</> : "Generate action proposal"}
                </button>
              </div>
            ) : (
              <div className="agent-action-list">
                {actions.map((action) => {
                  const isPending = action.status === "PENDING";
                  const canResume = action.status === "APPROVED" || action.status === "FAILED";
                  return (
                    <article className={`agent-action-card action-${action.status.toLowerCase()}`} key={action.id}>
                      <div className="agent-action-title-row">
                        <div>
                          <span className="field-label">{action.payload_json.priority} priority · approval required</span>
                          <strong>{action.payload_json.title}</strong>
                        </div>
                        <span className={`action-status status-${action.status.toLowerCase().replaceAll("_", "-")}`}>{formatStatus(action.status)}</span>
                      </div>
                      <p>{action.payload_json.reason}</p>
                      <div className="action-effect">
                        <span className="field-label">Expected demo effect</span>
                        <p>{describeActionEffect(action)}</p>
                      </div>

                      {isPending && <p className="approval-boundary">No customer or pipeline state changes until you approve this action.</p>}
                      {action.status === "REJECTED" && <p className="action-result is-rejected">Rejected. No business state changed.</p>}
                      {action.status === "COMPLETED" && action.payload_json.execution?.result && (
                        <p className="action-result is-complete">{action.payload_json.execution.result}</p>
                      )}
                      {action.status === "FAILED" && action.error_message && <p className="action-result is-error" role="alert">{action.error_message}</p>}
                      {action.status === "EXECUTING" && <p className="action-result">Approved; deterministic execution is in progress.</p>}

                      {(isPending || canResume) && (
                        <div className="action-controls">
                          {isPending && (
                            <>
                              <button className="primary-button" type="button" onClick={() => onDecision(action.id, "approve")} disabled={isActionBusy}>
                                {actionRequestState === "approving" ? <><span className="spinner" aria-hidden="true" /> Approving</> : "Approve"}
                              </button>
                              <button className="secondary-button" type="button" onClick={() => onDecision(action.id, "reject")} disabled={isActionBusy}>
                                {actionRequestState === "rejecting" ? "Rejecting…" : "Reject"}
                              </button>
                            </>
                          )}
                          {canResume && (
                            <button className="primary-button" type="button" onClick={() => onDecision(action.id, "approve")} disabled={isActionBusy}>
                              {actionRequestState === "approving" ? <><span className="spinner" aria-hidden="true" /> Executing</> : action.status === "FAILED" ? "Retry approved action" : "Continue approved action"}
                            </button>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}

            {actionRequestError && <p className="action-result is-error" role="alert">{actionRequestError}</p>}
            {actionRequestNotice && <p className="process-status" role="status">{actionRequestNotice}</p>}

            <div className="demo-customer-state">
              <span className="field-label">Linked synthetic customer</span>
              {demoCustomer ? (
                <>
                  <strong>{demoCustomer.name}</strong>
                  <span>Health · {formatStatus(demoCustomer.health_status ?? "UNKNOWN")}</span>
                  <span>Pipeline · {formatStatus(demoCustomer.pipeline_stage ?? "UNKNOWN")}</span>
                </>
              ) : <p className="detail-muted">No linked demo customer. Approved follow-ups still appear as completed action tasks.</p>}
            </div>
          </section>
        )}
        </section>
        <section className="detail-panel timeline-panel" aria-labelledby="activity-title">
          <div className="detail-panel-heading">
            <p className="eyebrow">PERSISTED ACTIVITY</p>
            <h3 id="activity-title">Call timeline</h3>
          </div>
          <ol className="activity-timeline">
            {timeline.map((event, index) => (
              <li key={`${event.occurredAt}-${event.label}-${index}`}>
                <span className="timeline-marker" aria-hidden="true" />
                <div>
                  <strong>{event.label}</strong>
                  {event.detail && <p>{event.detail}</p>}
                  <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function describeActionEffect(action: AgentActionRow): string {
  const expected = action.payload_json.expectedChanges.customer;
  if (expected?.healthStatus === "AT_RISK") {
    return "If approved, the linked synthetic customer health will be set to AT_RISK.";
  }
  if (expected?.pipelineStage === "QUALIFIED") {
    return "If approved, the linked synthetic termite lead may move from NEW to QUALIFIED.";
  }
  return "If approved, this completed action record represents the created follow-up task; no customer fields are changed.";
}

function formatSegmentTime(startMs?: number, endMs?: number): string {
  const format = (value: number) => {
    const totalSeconds = Math.floor(value / 1_000);
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
  };
  if (startMs === undefined) return endMs === undefined ? "" : format(endMs);
  if (endMs === undefined) return format(startMs);
  return `${format(startMs)}–${format(endMs)}`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatStatus(status: string): string {
  return status.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.7" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.2 7V4.8a2.8 2.8 0 0 1 5.6 0V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path d="M14 18V4m0 0L8.8 9.2M14 4l5.2 5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17.5v4A1.5 1.5 0 0 0 6.5 23h15a1.5 1.5 0 0 0 1.5-1.5v-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 8v4m4-7v10m4-13v16m4-11v6m4-8v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
