import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiErrorResponse, CallRecord, CallSummary } from "../src/shared/calls.js";
import { MAX_AUDIO_UPLOAD_BYTES } from "../src/shared/calls.js";
import { formatMaxUploadSize, validateAudioUpload } from "./audioValidation.js";

const CALL_SUMMARY_COLUMNS =
  "id,caller_name,demo_customer_id,original_filename,mime_type,status,duration,created_at,updated_at";
const CALL_RECORD_COLUMNS = `${CALL_SUMMARY_COLUMNS},audio_path,last_error`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CallsRouterDependencies = {
  supabase: SupabaseClient;
  bucketName: string;
  maxUploadBytes?: number;
  logger?: Pick<Console, "error">;
};

export function createCallsRouter({
  supabase,
  bucketName,
  maxUploadBytes = MAX_AUDIO_UPLOAD_BYTES,
  logger = console,
}: CallsRouterDependencies): express.Router {
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new Error("maxUploadBytes must be a positive safe integer.");
  }

  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 2,
      fieldSize: 1024,
      parts: 3,
    },
  });

  router.post("/ingest", upload.single("audio"), async (request, response) => {
    const file = request.file;
    if (!file) {
      sendError(response, 400, "AUDIO_REQUIRED", "Choose an audio file to upload.");
      return;
    }

    const validation = validateAudioUpload(
      {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
      maxUploadBytes,
    );

    if (!validation.ok) {
      sendError(response, validation.statusCode, validation.code, validation.message);
      return;
    }

    const form = (request.body ?? {}) as Record<string, unknown>;
    const callerName = readCallerName(form.caller_name);
    if (callerName === undefined) {
      sendError(response, 400, "INVALID_CALLER_NAME", "Caller name must be 200 characters or fewer.");
      return;
    }

    const demoCustomerId = readDemoCustomerId(form.demo_customer_id);
    if (demoCustomerId === undefined) {
      sendError(response, 400, "INVALID_DEMO_CUSTOMER_ID", "Choose a valid demo customer.");
      return;
    }

    const callId = randomUUID();
    const audioPath = `calls/${callId}.${validation.extension}`;
    let audioUploaded = false;

    try {
      const { error: storageError } = await supabase.storage
        .from(bucketName)
        .upload(audioPath, file.buffer, {
          cacheControl: "3600",
          contentType: validation.mimeType,
          upsert: false,
        });

      if (storageError) {
        logger.error("Call recording upload failed.", storageError);
        sendError(response, 502, "AUDIO_STORAGE_FAILED", "The audio could not be stored. Please try again.");
        return;
      }
      audioUploaded = true;

      const record = {
        id: callId,
        caller_name: callerName,
        demo_customer_id: demoCustomerId,
        audio_path: audioPath,
        original_filename: validation.originalFilename,
        mime_type: validation.mimeType,
        status: "UPLOADED",
        duration: null,
        last_error: null,
      };

      const { data, error: databaseError } = await supabase
        .from("calls")
        .insert(record)
        .select(CALL_RECORD_COLUMNS)
        .single();

      if (databaseError || !data) {
        logger.error("Call record could not be persisted after audio upload.", databaseError);
        await removeUploadedRecording(supabase, bucketName, audioPath, logger);
        sendError(
          response,
          503,
          "CALL_PERSISTENCE_FAILED",
          "The call record could not be saved. Please retry the upload.",
        );
        return;
      }

      response.status(201).json({ call: data as CallRecord });
    } catch (error) {
      logger.error("Call ingestion failed.", error);
      if (audioUploaded) {
        await removeUploadedRecording(supabase, bucketName, audioPath, logger);
      }
      sendError(response, 503, "CALL_INGESTION_FAILED", "The call could not be saved. Please try again.");
    }
  });

  router.get("/", async (_request, response) => {
    try {
      const { data, error } = await supabase
        .from("calls")
        .select(CALL_SUMMARY_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        logger.error("Recent calls could not be loaded.", error);
        sendError(response, 503, "CALLS_UNAVAILABLE", "Recent calls could not be loaded. Please try again.");
        return;
      }

      response.json({ calls: (data ?? []) as CallSummary[] });
    } catch (error) {
      logger.error("Recent calls request failed.", error);
      sendError(response, 503, "CALLS_UNAVAILABLE", "Recent calls could not be loaded. Please try again.");
    }
  });

  router.get("/:id", async (request, response) => {
    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      sendError(response, 400, "INVALID_CALL_ID", "Call ID must be a valid UUID.");
      return;
    }

    try {
      const { data, error } = await supabase
        .from("calls")
        .select(CALL_RECORD_COLUMNS)
        .eq("id", id)
        .maybeSingle();

      if (error) {
        logger.error("Call details could not be loaded.", error);
        sendError(response, 503, "CALL_UNAVAILABLE", "Call details could not be loaded. Please try again.");
        return;
      }

      if (!data) {
        sendError(response, 404, "CALL_NOT_FOUND", "That call could not be found.");
        return;
      }

      response.json({ call: data as CallRecord });
    } catch (error) {
      logger.error("Call details request failed.", error);
      sendError(response, 503, "CALL_UNAVAILABLE", "Call details could not be loaded. Please try again.");
    }
  });

  const handleUploadError: ErrorRequestHandler = (error, _request, response, _next) => {
    void _next;
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(
        response,
        413,
        "UPLOAD_TOO_LARGE",
        `Audio must be ${formatMaxUploadSize(maxUploadBytes)} or smaller.`,
      );
      return;
    }

    if (error instanceof multer.MulterError) {
      sendError(response, 400, "INVALID_UPLOAD", "Upload one audio file using the audio field.");
      return;
    }

    logger.error("Call API request failed.", error);
    sendError(response, 500, "INTERNAL_ERROR", "The request could not be completed.");
  };

  router.use(handleUploadError);
  return router;
}

function readCallerName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length > 200) {
    return undefined;
  }
  return normalized || null;
}

function readDemoCustomerId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

async function removeUploadedRecording(
  supabase: SupabaseClient,
  bucketName: string,
  audioPath: string,
  logger: Pick<Console, "error">,
): Promise<void> {
  try {
    const { error } = await supabase.storage.from(bucketName).remove([audioPath]);
    if (error) {
      logger.error("Uploaded recording cleanup failed.", error);
    }
  } catch (error) {
    logger.error("Uploaded recording cleanup failed.", error);
  }
}

function sendError(
  response: express.Response,
  statusCode: number,
  code: string,
  message: string,
): void {
  const payload: ApiErrorResponse = { error: { code, message } };
  response.status(statusCode).json(payload);
}
