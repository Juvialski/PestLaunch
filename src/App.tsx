import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiErrorResponse, CallSummary } from "./shared/calls.js";
import { MAX_AUDIO_UPLOAD_BYTES } from "./shared/calls.js";

const ACCEPTED_EXTENSIONS = new Set(["mp3", "wav", "m4a", "webm"]);
const ACCEPTED_FORMATS = "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/webm,.mp3,.wav,.m4a,.webm";

type UploadState = "idle" | "uploading" | "success" | "error";
type CallsState = "loading" | "ready" | "error";
type ApiPayload = {
  calls?: CallSummary[];
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

export default function App() {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [callsState, setCallsState] = useState<CallsState>("loading");
  const [callsError, setCallsError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [callerName, setCallerName] = useState("");
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMessage, setUploadMessage] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
                  <li className="call-row" key={call.id}>
                    <span className="call-file-icon" aria-hidden="true"><AudioIcon /></span>
                    <div className="call-main">
                      <span className="call-name">{call.caller_name?.trim() || "Unassigned call"}</span>
                      <span className="call-filename" title={call.original_filename}>{call.original_filename}</span>
                    </div>
                    <time className="call-date" dateTime={call.created_at}>{formatDate(call.created_at)}</time>
                    <span className={`status-pill status-${call.status.toLowerCase().replaceAll("_", "-")}`}>
                      <span className="status-dot" aria-hidden="true" />{formatStatus(call.status)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
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
