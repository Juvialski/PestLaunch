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
import { buildCallWorkflowSteps } from "./shared/callWorkflowProgress.js";
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
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [demoCustomers, setDemoCustomers] = useState<DemoCustomer[]>([]);
  const [demoCustomersLoaded, setDemoCustomersLoaded] = useState(false);
  const [isRetryingDemoCustomers, setIsRetryingDemoCustomers] = useState(false);
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
  const selectedDemoCustomer = demoCustomers.find((customer) => customer.id === selectedDemoCustomerId) ?? null;

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

  const retryDemoCustomerList = async () => {
    if (isRetryingDemoCustomers) return;
    setIsRetryingDemoCustomers(true);
    setDemoMessage("");
    try {
      await loadDemoCustomers();
      setDemoCustomersLoaded(true);
      setDemoResetState("idle");
    } catch (error) {
      setDemoCustomersLoaded(true);
      setDemoResetState("error");
      setDemoMessage(error instanceof Error ? error.message : "Synthetic demo customers could not be loaded.");
    } finally {
      setIsRetryingDemoCustomers(false);
    }
  };

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
            <img src="/pestlaunch-logo.webp" alt="" />
          </span>
          <span className="brand-copy">
            <span className="brand-name">PestLaunch</span>
            <span className="brand-product">CALL INTELLIGENCE</span>
          </span>
        </a>
      </header>

      <main id="top" className="main-content">
        <section className="page-heading" aria-labelledby="page-title">
          <div className="page-heading-copy">
            <p className="eyebrow">CALL WORKSPACE</p>
            <h1 id="page-title">Call Intelligence</h1>
            <p className="page-description">
              Turn pest-control conversations into clear customer signals and safe follow-up.
            </p>
          </div>
          <button
            className="primary-button upload-toggle"
            type="button"
            aria-expanded={isUploadOpen}
            aria-controls="upload-panel"
            onClick={() => setIsUploadOpen((open) => !open)}
          >
            <UploadIcon /> {isUploadOpen ? "Close" : "Add recording"}
          </button>
        </section>

        <section id="upload-panel" className="upload-card" aria-labelledby="upload-title" hidden={!isUploadOpen}>
            <div className="section-heading upload-heading">
              <div>
                <p className="eyebrow">NEW RECORDING</p>
                <h2 id="upload-title">Add a call recording</h2>
                <p className="upload-description">Choose the audio, identify the caller, then add it to the inbox for review.</p>
              </div>
              <span className="private-note"><LockIcon /> Private storage</span>
            </div>

            <ol className="upload-steps" aria-label="Recording upload steps">
              <li><span>01</span>Choose audio</li>
              <li><span>02</span>Identify caller</li>
              <li><span>03</span>Link customer</li>
              <li><span>04</span>Upload</li>
            </ol>

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
                <strong>Choose a call recording</strong>
                <span>Drop an audio file here, or browse your device</span>
              </span>
              <span className="browse-button">Browse files</span>
            </label>

            <div className="upload-identity-fields">
              <div className="caller-field">
                <label htmlFor="caller-name">Caller name <span>Optional</span></label>
                <input
                  id="caller-name"
                  type="text"
                  value={callerName}
                  maxLength={200}
                  disabled={uploadState === "uploading"}
                  placeholder="e.g. Jordan Example"
                  onChange={(event) => setCallerName(event.currentTarget.value)}
                />
                <span className="field-help">Leave blank to use the linked customer name, or “Unassigned call”.</span>
              </div>

              <div className="demo-customer-select">
                <label htmlFor="demo-customer">Link a synthetic customer <span>Optional</span></label>
                <select
                  id="demo-customer"
                  value={selectedDemoCustomerId}
                  disabled={uploadState === "uploading" || demoCustomers.length === 0}
                  onChange={(event) => setSelectedDemoCustomerId(event.currentTarget.value)}
                  aria-describedby="customer-link-help"
                >
                  <option value="">No linked customer</option>
                  {demoCustomers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name} · {formatStatus(customer.customer_type ?? "SYNTHETIC")}
                    </option>
                  ))}
                </select>
                <span id="customer-link-help" className="field-help">
                  {selectedDemoCustomer
                    ? `This recording will be linked to ${selectedDemoCustomer.name}.`
                    : demoCustomers.length === 0
                      ? "Prepare the synthetic demo records before linking a customer."
                      : "Without a link, the call stays unassigned."}
                </span>
                {demoResetState === "error" && demoCustomers.length === 0 && (
                  <button className="text-button customer-list-retry" type="button" onClick={() => void retryDemoCustomerList()} disabled={isRetryingDemoCustomers}>
                    {isRetryingDemoCustomers ? "Retrying customer list…" : "Retry customer list"}
                  </button>
                )}
              </div>
            </div>

            <div className="demo-customer-controls">
              <div className={`customer-association${selectedDemoCustomer ? " is-linked" : ""}`} aria-live="polite">
                <span className="association-mark" aria-hidden="true">{selectedDemoCustomer ? "✓" : "—"}</span>
                <span>
                  <strong>{selectedDemoCustomer ? selectedDemoCustomer.name : "No customer linked"}</strong>
                  <small>{selectedDemoCustomer ? `${formatStatus(selectedDemoCustomer.customer_type ?? "SYNTHETIC")} · synthetic demo record` : "The caller name can still label this call."}</small>
                </span>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleDemoReset()}
                disabled={uploadState === "uploading" || demoResetState === "resetting" || actionRequestState !== "idle" || !demoCustomersLoaded}
              >
                {!demoCustomersLoaded ? "Loading demo data…" : demoResetState === "resetting" ? "Preparing demo data…" : demoCustomers.length === 0 ? "Prepare demo records" : "Reset demo records"}
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
                  ) : <span className="no-file">No file selected</span>}
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

        <div className="workspace-layout">
          <aside className="recent-section inbox-column" aria-labelledby="recent-title">
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
                  <span>Add a recording to see its transcript, intelligence, and suggested next step.</span>
                  <button className="text-button" type="button" onClick={() => setIsUploadOpen(true)}>Add your first recording</button>
                </div>
              ) : (
                <ul className="call-list">
                  {calls.map((call) => {
                    const linkedCustomer = demoCustomers.find((customer) => customer.id === call.demo_customer_id)
                      ?? (selectedCallId === call.id ? callDetail?.demoCustomer ?? null : null);
                    const fallbackName = call.demo_customer_id ? "Linked customer" : "Unassigned call";
                    const callName = call.caller_name?.trim() || linkedCustomer?.name || fallbackName;
                    const callAccessibleLabel = [
                      callName,
                      call.original_filename,
                      call.duration !== null ? formatDuration(call.duration) : null,
                      formatStatus(call.status),
                      formatDate(call.created_at),
                    ].filter(Boolean).join(", ");
                    return (
                      <li key={call.id}>
                        <button
                          className={`call-row${selectedCallId === call.id ? " is-selected" : ""}`}
                          type="button"
                          aria-current={selectedCallId === call.id ? "true" : undefined}
                          aria-label={callAccessibleLabel}
                          onClick={() => selectCall(call.id)}
                        >
                          <span className="call-file-icon" aria-hidden="true"><AudioIcon /></span>
                          <span className="call-main">
                            <span className="call-name">{callName}</span>
                            <span className="call-filename" title={call.original_filename}>{call.original_filename}</span>
                            <span className="call-date-inline">
                              <time dateTime={call.created_at}>{formatDate(call.created_at)}</time>
                              {call.duration !== null && <> · {formatDuration(call.duration)}</>}
                            </span>
                          </span>
                          <span className={`status-pill status-${call.status.toLowerCase().replaceAll("_", "-")}`}>
                            <span className="status-dot" aria-hidden="true" />{formatStatus(call.status)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <p className="inbox-caption">Select a call to follow its path from recording to outcome.</p>
          </aside>

          <section className="detail-section review-column" aria-labelledby="detail-title">
            <div className="section-heading detail-section-heading">
              <div>
                <p className="eyebrow">WORKFLOW REVIEW</p>
                <h2 id="detail-title">Review a call</h2>
              </div>
            </div>
            <div className="call-detail-card">
              {detailState === "idle" ? (
                <div className="detail-empty">
                  <span className="empty-icon" aria-hidden="true"><AudioIcon /></span>
                  <strong>Your call story appears here</strong>
                  <span>Select a recording to review its transcript, AI findings, recommended action, and activity.</span>
                  <ol className="empty-workflow" aria-label="Call workflow">
                    <li>Call</li><li>Transcript</li><li>Intelligence</li><li>Approval</li><li>Outcome</li>
                  </ol>
                </div>
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
        </div>
      </main>
      <footer className="app-footer">
        <span>PestLaunch Call Intelligence</span>
        <span>AI proposes · people approve · actions are logged</span>
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
  const callDisplayName = call.caller_name?.trim() || demoCustomer?.name || "Unassigned call";
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
  const needsReview = call.status === "NEEDS_REVIEW" || call.status === "FAILED";
  const workflowSteps = buildCallWorkflowSteps({
    hasTranscript: Boolean(transcript),
    hasIntelligence: Boolean(intelligence),
    isBusy,
    needsReview,
    actionStatuses: actions.map((action) => action.status),
  });

  return (
    <div className="detail-grid">
      <header className="call-overview-header">
        <div>
          <p className="eyebrow">SELECTED CALL</p>
          <h3 id="recording-title">{callDisplayName}</h3>
          <div className="recording-meta-inline">
            <span title={call.original_filename}>{call.original_filename}</span>
            <span><time dateTime={call.created_at}>{formatDate(call.created_at)}</time></span>
            {call.duration !== null && <span>{formatDuration(call.duration)}</span>}
            {demoCustomer && <span className="linked-customer-tag">Linked to {demoCustomer.name}</span>}
          </div>
        </div>
        <div className="call-header-badges">
          <span className={`status-pill status-${call.status.toLowerCase().replaceAll("_", "-")}`}>
            <span className="status-dot" aria-hidden="true" />{formatStatus(call.status)}
          </span>
          {intelligence && <>
            <span className="call-type-pill">{formatStatus(intelligence.callType)}</span>
            <span className={`priority-pill priority-${intelligence.priority.toLowerCase()}`}>{intelligence.priority} priority</span>
            {intelligence.signals.cancellationRisk && <span className="risk-pill">Cancellation risk</span>}
          </>}
        </div>
      </header>

      <ol className="workflow-progress" aria-label="Call workflow progress">
        {workflowSteps.map((step, index) => (
          <li
            className={`workflow-step${step.complete ? " is-complete" : ""}${step.active ? " is-active" : ""}${step.attention ? " is-attention" : ""}`}
            aria-current={step.active || step.attention ? "step" : undefined}
            key={step.label}
          >
            <span className="workflow-step-index" aria-hidden="true">{step.complete ? "✓" : String(index + 1).padStart(2, "0")}</span>
            <span className="workflow-step-label">{step.label}</span>
          </li>
        ))}
      </ol>

      <section className="detail-panel intelligence-panel" aria-labelledby="intelligence-title">
        <div className="intelligence-heading">
          <div className="detail-panel-heading">
            <p className="eyebrow">AI ANALYSIS</p>
            <h3 id="intelligence-title">{intelligence ? "Key findings" : "Call insights"}</h3>
          </div>
          {intelligence && (
            <div className="analysis-badges">
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
        {visibleError && <p className={`process-status ${processError ? "is-error" : "is-warning"}`} role={processError ? "alert" : "status"}>{visibleError}</p>}

        {intelligence ? (
          <>
            <div className="analysis-summary-block">
              <span className="field-label">Call summary</span>
              <p>{intelligence.summary}</p>
            </div>
            <div className="analysis-support-grid">
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
              <div className="signal-heading">
                <span className="field-label">Detected signals</span>
                {analysis && <span className="model-note">{analysis.model_used}</span>}
              </div>
              {signals.length > 0 ? (
                <ul className="signal-list">
                  {signals.map(([key, label]) => <li className={`signal-pill signal-${key}`} key={label}>{label}</li>)}
                </ul>
              ) : <p className="detail-muted">No key signals detected.</p>}
            </div>
            <div className="ai-recommendation">
              <span className="field-label">Model recommendation · context only</span>
              {intelligence.recommendedAction ? (
                <div>
                  <strong>{formatStatus(intelligence.recommendedAction.type)}</strong>
                  <p>{intelligence.recommendedAction.reason}</p>
                </div>
              ) : <p className="detail-muted">No model recommendation was returned. Application policy still evaluates the validated signals.</p>}
              <span className="proposal-note">The model provides context; it cannot execute a business action.</span>
            </div>
          </>
        ) : (
          <div className="analysis-empty">
            <strong>{call.status === "PROCESSING" ? "Analysis in progress" : "No validated analysis yet"}</strong>
            <span>Call type, priority, and supporting evidence appear here after processing.</span>
          </div>
        )}
      </section>

      <section className="detail-panel agent-proposal-panel" aria-labelledby="agent-proposal-title">
        <div className="agent-proposal-heading">
          <div>
            <p className="eyebrow">APPLICATION POLICY</p>
            <h3 id="agent-proposal-title">Recommended action</h3>
          </div>
          <span className="proposal-origin">Deterministic</span>
        </div>
        {!intelligence ? (
          <div className="agent-proposal-empty">
            <p className="detail-muted">A follow-up proposal can be reviewed after the call has validated intelligence.</p>
            <span className="approval-boundary">Customer state never changes without human approval.</span>
          </div>
        ) : actions.length === 0 ? (
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
                      <span className="field-label">{action.payload_json.priority} priority · {isPending ? "approval required" : action.status === "REJECTED" ? "rejected by reviewer" : "human approved"}</span>
                      <h4>{action.payload_json.title}</h4>
                    </div>
                    <span className={`action-status status-${action.status.toLowerCase().replaceAll("_", "-")}`}>{formatStatus(action.status)}</span>
                  </div>
                  <p className="action-reason">{action.payload_json.reason}</p>
                  {isPending && (
                    <div className="approval-boundary">
                      <strong>Review before applying</strong>
                      <span>No customer or pipeline state changes until you approve this follow-up.</span>
                    </div>
                  )}
                  {action.status !== "COMPLETED" && (
                    <div className="action-effect">
                      <span className="field-label">{isPending ? "If approved" : "Expected effect"}</span>
                      <p>{describeActionEffect(action)}</p>
                    </div>
                  )}
                  {action.status === "REJECTED" && <p className="action-result is-rejected">Rejected. No business state changed.</p>}
                  {action.status === "COMPLETED" && action.payload_json.execution?.result && (
                    <div className="action-outcome">
                      <span className="field-label">Recorded outcome</span>
                      <p>{action.payload_json.execution.result}</p>
                    </div>
                  )}
                  {action.status === "FAILED" && action.error_message && <p className="action-result is-error" role="alert">{action.error_message}</p>}
                  {action.status === "EXECUTING" && <p className="action-result">Approved; deterministic execution is in progress.</p>}
                  {(isPending || canResume) && (
                    <div className="action-controls">
                      {isPending && (
                        <>
                          <button className="primary-button" type="button" onClick={() => onDecision(action.id, "approve")} disabled={isActionBusy}>
                            {actionRequestState === "approving" ? <><span className="spinner" aria-hidden="true" /> Approving</> : "Approve follow-up"}
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
          <div className="customer-state-heading">
            <span className="field-label">Current customer state</span>
            {demoCustomer && <span className={`health-pill health-${(demoCustomer.health_status ?? "unknown").toLowerCase().replaceAll("_", "-")}`}>{formatStatus(demoCustomer.health_status ?? "UNKNOWN")}</span>}
          </div>
          {demoCustomer ? (
            <>
              <strong>{demoCustomer.name}</strong>
              <span>Pipeline · {formatStatus(demoCustomer.pipeline_stage ?? "UNKNOWN")}</span>
            </>
          ) : <p className="detail-muted">No linked demo customer. Approved follow-ups still appear as completed action tasks.</p>}
        </div>
      </section>

      <section className="detail-panel transcript-panel" aria-labelledby="transcript-title">
        <div className="detail-panel-heading transcript-panel-heading">
          <div>
            <p className="eyebrow">SOURCE RECORDING</p>
            <h3 id="transcript-title">Transcript</h3>
          </div>
          {transcript && <span className="model-note">{transcript.model_used}</span>}
        </div>
        <audio
          className="call-audio"
          controls
          preload="none"
          src={`/api/calls/${call.id}/audio`}
          aria-label={`Recording for ${call.caller_name?.trim() || demoCustomer?.name || call.original_filename}`}
          onError={() => setAudioPlaybackFailedCallId(call.id)}
          onPlaying={() => setAudioPlaybackFailedCallId(null)}
        >
          Your browser does not support audio playback.
        </audio>
        {audioPlaybackFailedCallId === call.id && <p className="process-status is-error" role="alert">{AUDIO_PLAYBACK_ERROR}</p>}
        {transcript ? (
          transcript.segments_json.length > 0 ? (
            <ol className="transcript-segments">
              {transcript.segments_json.map((segment, index) => (
                <li key={`${segment.speaker}-${segment.startMs ?? index}-${index}`}>
                  <div className="transcript-segment-meta">
                    <strong>{formatSpeakerLabel(segment.speaker)}</strong>
                    {(segment.startMs !== undefined || segment.endMs !== undefined) && <time>{formatSegmentTime(segment.startMs, segment.endMs)}</time>}
                  </div>
                  <p>{segment.text}</p>
                </li>
              ))}
            </ol>
          ) : <p className="transcript-plain">{transcript.text}</p>
        ) : <p className="detail-muted">The transcript will appear here after processing.</p>}
      </section>

      <section className="detail-panel evidence-panel" aria-labelledby="evidence-title">
        <div className="detail-panel-heading">
          <p className="eyebrow">WHY IT WAS FLAGGED</p>
          <h3 id="evidence-title">Transcript evidence</h3>
        </div>
        {intelligence ? (
          <ul className="evidence-list">
            {intelligence.evidence.map((item, index) => (
              <li key={`${item.quote}-${index}`}>
                <blockquote>“{item.quote}”</blockquote>
                {item.speaker && <span>{formatSpeakerLabel(item.speaker)}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="detail-muted">Evidence quotes will appear here alongside validated analysis.</p>}
      </section>

      <section className="detail-panel timeline-panel" aria-labelledby="activity-title">
        <div className="timeline-heading">
          <div className="detail-panel-heading">
            <p className="eyebrow">PERSISTED ACTIVITY</p>
            <h3 id="activity-title">Activity timeline</h3>
          </div>
          <span className="timeline-caption">A record of what happened to this call</span>
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
function formatSpeakerLabel(speaker: string): string {
  const speakerNumber = /^spk:(\d+)$/i.exec(speaker.trim());
  return speakerNumber ? `Speaker ${Number(speakerNumber[1]) + 1}` : speaker;
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
