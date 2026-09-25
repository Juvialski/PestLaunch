import { createHash } from "node:crypto";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  analysisEvidenceIsGrounded,
  CallAnalysisSchema,
  CallTranscriptSchema,
} from "../src/shared/calls.js";
import {
  AgentActionPayloadSchema,
  AgentActionRowSchema,
  CustomerCommunicationDraftSchema,
  DemoCustomerSchema,
  MAX_ACTION_EXECUTION_ATTEMPTS,
  type AgentActionPayload,
  type AgentActionRow,
  type AgentActionStatus,
  type DemoCustomer,
} from "../src/shared/actions.js";
import {
  DEMO_CUSTOMER_ID_LIST,
  DEMO_CUSTOMERS,
  DEMO_CUSTOMER_IDS,
  isDemoCustomerId,
} from "./demoFixtures.js";
import { proposeDeterministicAction } from "./actionPolicy.js";
import type { CallsAiService } from "./aiTypes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DNS_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
type RouterLogger = Pick<Console, "error"> & Partial<Pick<Console, "warn">>;

export type ActionsRouterDependencies = {
  supabase: SupabaseClient;
  ai: Pick<CallsAiService, "draftCustomerCommunication">;
  logger?: RouterLogger;
};

type PersistedCall = { id: string; demo_customer_id: string | null; caller_name: string | null };
type ProposalSource = {
  call: PersistedCall;
  analysis: ReturnType<typeof CallAnalysisSchema.parse>;
  transcript: ReturnType<typeof CallTranscriptSchema.parse>;
  customer: DemoCustomer | null;
};
type SourceLoadResult =
  | { ok: true; source: ProposalSource }
  | { ok: false; statusCode: number; code: string; message: string; cause?: unknown };

type CustomerExecution = {
  customer: DemoCustomer | null;
  mutation: NonNullable<AgentActionPayload["execution"]>["customerMutation"];
  result: string;
};

export function createActionsRouter({ supabase, ai, logger = console }: ActionsRouterDependencies): express.Router {
  const router = express.Router();

  router.post("/calls/:id/actions/propose", async (request, response) => {
    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      sendError(response, 400, "INVALID_CALL_ID", "Call ID must be a valid UUID.");
      return;
    }
    if (!hasEmptyBody(request.body)) {
      sendError(response, 400, "INVALID_ACTION_REQUEST", "Action proposals are generated from saved call analysis only.");
      return;
    }

    const sourceResult = await loadProposalSource(supabase, id);
    if (!sourceResult.ok) {
      if (sourceResult.cause) logger.error("Persisted call analysis could not be loaded for action proposal.", sourceResult.cause);
      sendError(response, sourceResult.statusCode, sourceResult.code, sourceResult.message);
      return;
    }

    const proposal = proposeDeterministicAction(sourceResult.source.analysis, sourceResult.source.customer);
    if (!proposal) {
      response.json({ action: null, reason: "NO_PERMITTED_ACTION" });
      return;
    }

    const actionId = deterministicActionId(id);
    try {
      const existingResult = await supabase
        .from("agent_actions")
        .select("*")
        .eq("call_id", id)
        .order("created_at", { ascending: true })
        .limit(1);
      if (existingResult.error) {
        logger.error("Existing action proposals could not be checked before insertion.", existingResult.error);
        sendError(response, 503, "ACTION_UNAVAILABLE", "Existing action history could not be checked. Please retry.");
        return;
      }
      const existingRows = Array.isArray(existingResult.data) ? existingResult.data : [];
      if (existingRows.length > 0) {
        const existing = readActionRow(existingRows[0]);
        if (!existing || existing.call_id !== id) {
          sendError(response, 503, "ACTION_UNAVAILABLE", "Existing action history failed runtime validation.");
          return;
        }
        response.json({ action: existing });
        return;
      }

      const { data, error } = await supabase
        .from("agent_actions")
        .insert({
          id: actionId,
          call_id: id,
          action_type: proposal.actionType,
          payload_json: proposal,
          status: "PENDING",
          requires_approval: true,
          error_message: null,
        })
        .select("*")
        .single();

      if (error?.code === "23505") {
        const existing = await loadActionById(supabase, actionId);
        if (existing.error || !existing.action) {
          logger.error("Existing deterministic action could not be reloaded after an ID conflict.", existing.error);
          sendError(response, 503, "ACTION_UNAVAILABLE", "The existing action proposal could not be loaded.");
          return;
        }
        if (existing.action.call_id !== id) {
          sendError(response, 409, "ACTION_ID_CONFLICT", "The deterministic action ID is already used by a different action.");
          return;
        }
        response.json({ action: existing.action });
        return;
      }
      if (error || !data) {
        logger.error("Deterministic action proposal could not be persisted.", error);
        sendError(response, 503, "ACTION_SAVE_FAILED", "The action proposal could not be saved. Please retry.");
        return;
      }

      let action = readActionRow(data);
      if (!action || action.id !== actionId || action.call_id !== id || action.action_type !== proposal.actionType) {
        logger.error("Persisted deterministic action did not match its validated proposal.");
        sendError(response, 503, "ACTION_SAVE_FAILED", "The saved action proposal could not be validated.");
        return;
      }

      if (action.action_type === "CREATE_RETENTION_FOLLOWUP") {
        try {
          const draft = await ai.draftCustomerCommunication({
            ...(sourceResult.source.call.caller_name?.trim()
              ? { customerName: sourceResult.source.call.caller_name.trim() }
              : sourceResult.source.customer?.name
                ? { customerName: sourceResult.source.customer.name }
                : {}),
            transcript: sourceResult.source.transcript.text,
            analysis: {
              summary: sourceResult.source.analysis.summary,
              customerIntent: sourceResult.source.analysis.customerIntent,
              outcome: sourceResult.source.analysis.outcome,
              signals: {
                complaint: sourceResult.source.analysis.signals.complaint,
                cancellationRisk: sourceResult.source.analysis.signals.cancellationRisk,
                followUpRequired: sourceResult.source.analysis.signals.followUpRequired,
              },
            },
            actionType: "CREATE_RETENTION_FOLLOWUP",
            actionReason: proposal.reason,
          });
          const customerCommunication = CustomerCommunicationDraftSchema.parse({
            type: "EMAIL_DRAFT",
            ...draft,
          });
          const payload = AgentActionPayloadSchema.parse({
            ...action.payload_json,
            customerCommunication,
          });
          const update = await supabase
            .from("agent_actions")
            .update({ payload_json: payload })
            .eq("id", action.id)
            .eq("status", "PENDING")
            .select("*")
            .maybeSingle();
          if (update.error) {
            logger.warn?.("Customer communication draft could not be saved; the deterministic action remains available.", update.error);
          } else if (update.data) {
            const updatedAction = readActionRow(update.data);
            if (updatedAction?.id === action.id) action = updatedAction;
            else logger.warn?.("Saved customer communication draft failed action validation; the deterministic action remains available.");
          } else {
            const latest = await loadActionById(supabase, action.id);
            if (latest.action) action = latest.action;
          }
        } catch (error) {
          logger.warn?.("Customer response draft is unavailable; the deterministic action remains available.", error);
        }
      }

      response.status(201).json({ action });
    } catch (error) {
      logger.error("Action proposal request failed.", error);
      sendError(response, 503, "ACTION_SAVE_FAILED", "The action proposal could not be saved. Please retry.");
    }
  });

  router.post("/actions/:id/reject", async (request, response) => {
    const actionId = request.params.id;
    if (!UUID_PATTERN.test(actionId)) {
      sendError(response, 400, "INVALID_ACTION_ID", "Action ID must be a valid UUID.");
      return;
    }
    if (!hasEmptyBody(request.body)) {
      sendError(response, 400, "INVALID_ACTION_REQUEST", "Action decisions do not accept action types or database patches.");
      return;
    }

    const loaded = await loadActionById(supabase, actionId);
    if (loaded.error) {
      logger.error("Action could not be loaded for rejection.", loaded.error);
      sendError(response, 503, "ACTION_UNAVAILABLE", "The action could not be loaded.");
      return;
    }
    if (!loaded.action) {
      sendError(response, 404, "ACTION_NOT_FOUND", "That action could not be found.");
      return;
    }
    if (loaded.action.status === "REJECTED") {
      response.json({ action: loaded.action });
      return;
    }
    if (loaded.action.status !== "PENDING") {
      sendError(response, 409, "ACTION_NOT_REJECTABLE", "Only a pending action can be rejected.");
      return;
    }

    const rejection = AgentActionPayloadSchema.parse({
      ...loaded.action.payload_json,
      rejection: { rejectedAt: new Date().toISOString() },
    });
    const transition = await transitionAction(supabase, actionId, "PENDING", {
      status: "REJECTED",
      payload_json: rejection,
    });
    if (transition.error) {
      logger.error("Action rejection could not be persisted.", transition.error);
      sendError(response, 503, "ACTION_DECISION_FAILED", "The rejection could not be saved. Please retry.");
      return;
    }
    if (transition.action) {
      response.json({ action: transition.action });
      return;
    }

    const latest = await loadActionById(supabase, actionId);
    if (latest.action?.status === "REJECTED") {
      response.json({ action: latest.action });
      return;
    }
    sendError(response, 409, "ACTION_STATE_CHANGED", "The action changed state before rejection. Refresh and review it.");
  });

  router.post("/actions/:id/approve", async (request, response) => {
    const actionId = request.params.id;
    if (!UUID_PATTERN.test(actionId)) {
      sendError(response, 400, "INVALID_ACTION_ID", "Action ID must be a valid UUID.");
      return;
    }
    if (!hasEmptyBody(request.body)) {
      sendError(response, 400, "INVALID_ACTION_REQUEST", "Action decisions do not accept action types or database patches.");
      return;
    }

    const loaded = await loadActionById(supabase, actionId);
    if (loaded.error) {
      logger.error("Action could not be loaded for approval.", loaded.error);
      sendError(response, 503, "ACTION_UNAVAILABLE", "The action could not be loaded.");
      return;
    }
    if (!loaded.action) {
      sendError(response, 404, "ACTION_NOT_FOUND", "That action could not be found.");
      return;
    }
    if (loaded.action.status === "COMPLETED") {
      await sendActionWithCustomer(response, supabase, loaded.action);
      return;
    }
    if (loaded.action.status === "REJECTED") {
      sendError(response, 409, "ACTION_REJECTED", "A rejected action cannot be executed.");
      return;
    }
    if (loaded.action.status === "EXECUTING") {
      await sendActionWithCustomer(response, supabase, loaded.action, 202);
      return;
    }

    let action = loaded.action;
    let claimStatus: "APPROVED" | "FAILED";
    if (action.status === "PENDING") {
      const approval = await transitionAction(supabase, actionId, "PENDING", {
        status: "APPROVED",
        approved_at: new Date().toISOString(),
      });
      if (approval.error) {
        logger.error("Human approval could not be persisted.", approval.error);
        sendError(response, 503, "ACTION_APPROVAL_FAILED", "Approval could not be saved. Please retry.");
        return;
      }
      if (approval.action) {
        action = approval.action;
      } else {
        const latest = await loadActionById(supabase, actionId);
        if (latest.error || !latest.action) {
          sendError(response, 503, "ACTION_UNAVAILABLE", "The action state could not be reloaded.");
          return;
        }
        action = latest.action;
        if (action.status === "COMPLETED") {
          await sendActionWithCustomer(response, supabase, action);
          return;
        }
        if (action.status === "EXECUTING") {
          await sendActionWithCustomer(response, supabase, action, 202);
          return;
        }
        if (action.status !== "APPROVED") {
          respondToUnavailableApprovalState(response, action);
          return;
        }
      }
      claimStatus = "APPROVED";
    } else if (action.status === "APPROVED") {
      if (!action.approved_at) {
        sendError(response, 409, "ACTION_APPROVAL_MISSING", "This action has no persisted human approval.");
        return;
      }
      claimStatus = "APPROVED";
    } else if (action.status === "FAILED") {
      if (!action.approved_at) {
        sendError(response, 409, "ACTION_APPROVAL_MISSING", "A failed action without recorded approval cannot be retried.");
        return;
      }
      if ((action.payload_json.execution?.attemptCount ?? 0) >= MAX_ACTION_EXECUTION_ATTEMPTS) {
        sendError(response, 409, "ACTION_RETRY_LIMIT", "This approved action has reached its safe retry limit.");
        return;
      }
      claimStatus = "FAILED";
    } else {
      respondToUnavailableApprovalState(response, action);
      return;
    }

    const claim = await claimActionExecution(supabase, action, claimStatus);
    if (claim.error) {
      logger.error("Approved action execution could not be claimed.", claim.error);
      sendError(response, 503, "ACTION_EXECUTION_FAILED", "The approved action could not start. Please retry.");
      return;
    }
    if (!claim.action) {
      const latest = await loadActionById(supabase, actionId);
      if (latest.error || !latest.action) {
        sendError(response, 503, "ACTION_UNAVAILABLE", "The action state could not be reloaded.");
        return;
      }
      if (latest.action.status === "COMPLETED") {
        await sendActionWithCustomer(response, supabase, latest.action);
        return;
      }
      if (latest.action.status === "EXECUTING" || latest.action.status === "APPROVED") {
        await sendActionWithCustomer(response, supabase, latest.action, 202);
        return;
      }
      respondToUnavailableApprovalState(response, latest.action);
      return;
    }

    await executeClaimedAction(response, supabase, claim.action, logger);
  });

  router.get("/demo/customers", async (_request, response) => {
    const result = await loadSyntheticCustomers(supabase);
    if (result.error) {
      logger.error("Synthetic demo customers could not be loaded.", result.error);
      sendError(response, 503, "DEMO_CUSTOMERS_UNAVAILABLE", "Demo customers could not be loaded. Please retry.");
      return;
    }
    response.json({ customers: result.customers });
  });

  router.post("/demo/reset", async (request, response) => {
    if (!hasEmptyBody(request.body)) {
      sendError(response, 400, "INVALID_DEMO_RESET", "Demo reset accepts no customer IDs or data patches.");
      return;
    }
    try {
      const { error } = await supabase
        .from("demo_customers")
        .upsert(DEMO_CUSTOMERS, { onConflict: "id" });
      if (error) {
        logger.error("Fixed synthetic demo records could not be reset.", error);
        sendError(response, 503, "DEMO_RESET_FAILED", "The synthetic demo customers could not be reset.");
        return;
      }
      const result = await loadSyntheticCustomers(supabase);
      if (result.error) {
        logger.error("Reset synthetic customers could not be reloaded.", result.error);
        sendError(response, 503, "DEMO_RESET_FAILED", "The synthetic demo reset could not be verified.");
        return;
      }
      response.json({ customers: result.customers, message: "Synthetic demo customers are ready." });
    } catch (error) {
      logger.error("Synthetic demo reset failed.", error);
      sendError(response, 503, "DEMO_RESET_FAILED", "The synthetic demo customers could not be reset.");
    }
  });

  return router;
}

async function loadProposalSource(supabase: SupabaseClient, callId: string): Promise<SourceLoadResult> {
  try {
    const [callResult, analysisResult, transcriptResult] = await Promise.all([
      supabase.from("calls").select("id,demo_customer_id,caller_name").eq("id", callId).maybeSingle(),
      supabase.from("call_analysis").select("*").eq("call_id", callId).maybeSingle(),
      supabase.from("transcripts").select("*").eq("call_id", callId).maybeSingle(),
    ]);
    if (callResult.error || analysisResult.error || transcriptResult.error) {
      return {
        ok: false,
        statusCode: 503,
        code: "CALL_INTELLIGENCE_UNAVAILABLE",
        message: "Persisted call intelligence could not be loaded. Please retry.",
        cause: { call: callResult.error, analysis: analysisResult.error, transcript: transcriptResult.error },
      };
    }
    if (!callResult.data) {
      return { ok: false, statusCode: 404, code: "CALL_NOT_FOUND", message: "That call could not be found." };
    }
    if (!analysisResult.data) {
      return { ok: false, statusCode: 409, code: "ANALYSIS_REQUIRED", message: "Process the call before proposing an action." };
    }
    if (!transcriptResult.data) {
      return { ok: false, statusCode: 409, code: "ANALYSIS_INVALID", message: "The saved analysis has no persisted transcript evidence." };
    }

    const analysisRow = analysisResult.data as Record<string, unknown>;
    const parsedAnalysis = CallAnalysisSchema.safeParse(analysisRow.analysis_json);
    const transcriptRow = transcriptResult.data as Record<string, unknown>;
    const parsedTranscript = CallTranscriptSchema.safeParse({
      text: transcriptRow.text,
      segments: transcriptRow.segments_json,
      modelUsed: transcriptRow.model_used,
    });
    const confidence = Number(analysisRow.confidence);
    if (
      !parsedAnalysis.success ||
      !parsedTranscript.success ||
      analysisRow.call_id !== callId ||
      transcriptRow.call_id !== callId ||
      analysisRow.call_type !== parsedAnalysis.data.callType ||
      analysisRow.summary !== parsedAnalysis.data.summary ||
      !Number.isFinite(confidence) ||
      Math.abs(confidence - parsedAnalysis.data.confidence) > 0.00011 ||
      !analysisEvidenceIsGrounded(parsedAnalysis.data, parsedTranscript.data.text)
    ) {
      return { ok: false, statusCode: 409, code: "ANALYSIS_INVALID", message: "The saved call analysis failed validation." };
    }

    const callRow = callResult.data as Record<string, unknown>;
    if (
      typeof callRow.id !== "string" ||
      (callRow.demo_customer_id !== null && typeof callRow.demo_customer_id !== "string") ||
      (callRow.caller_name !== null && typeof callRow.caller_name !== "string")
    ) {
      return { ok: false, statusCode: 409, code: "CALL_INVALID", message: "The saved call record failed validation." };
    }
    const call: PersistedCall = {
      id: callRow.id,
      demo_customer_id: callRow.demo_customer_id as string | null,
      caller_name: callRow.caller_name as string | null,
    };
    const customer = await loadDemoCustomerById(supabase, call.demo_customer_id);
    if (customer.error) {
      return { ok: false, statusCode: 503, code: "DEMO_CUSTOMER_UNAVAILABLE", message: "The linked demo customer could not be loaded.", cause: customer.error };
    }
    return {
      ok: true,
      source: { call, analysis: parsedAnalysis.data, transcript: parsedTranscript.data, customer: customer.customer },
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      code: "CALL_INTELLIGENCE_UNAVAILABLE",
      message: "Persisted call intelligence could not be loaded. Please retry.",
      cause: error,
    };
  }
}

function deterministicActionId(callId: string): string {
  const digest = createHash("sha1")
    .update(Buffer.concat([DNS_NAMESPACE, Buffer.from(`pestlaunch:call-action:${callId.toLowerCase()}`)]))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loadActionById(
  supabase: SupabaseClient,
  id: string,
): Promise<{ action: AgentActionRow | null; error: unknown | null }> {
  try {
    const { data, error } = await supabase.from("agent_actions").select("*").eq("id", id).maybeSingle();
    if (error) return { action: null, error };
    const action = data ? readActionRow(data) : null;
    return { action, error: data && !action ? new Error("Stored action row failed runtime validation.") : null };
  } catch (error) {
    return { action: null, error };
  }
}

function readActionRow(value: unknown): AgentActionRow | null {
  const parsed = AgentActionRowSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function transitionAction(
  supabase: SupabaseClient,
  id: string,
  expectedStatus: AgentActionStatus,
  values: Record<string, unknown>,
): Promise<{ action: AgentActionRow | null; error: unknown | null }> {
  try {
    const { data, error } = await supabase
      .from("agent_actions")
      .update(values)
      .eq("id", id)
      .eq("status", expectedStatus)
      .select("*")
      .maybeSingle();
    if (error) return { action: null, error };
    const action = data ? readActionRow(data) : null;
    return { action, error: data && !action ? new Error("Updated action row failed runtime validation.") : null };
  } catch (error) {
    return { action: null, error };
  }
}

async function claimActionExecution(
  supabase: SupabaseClient,
  action: AgentActionRow,
  expectedStatus: "APPROVED" | "FAILED",
): Promise<{ action: AgentActionRow | null; error: unknown | null }> {
  const previous = action.payload_json.execution;
  const attemptCount = (previous?.attemptCount ?? 0) + 1;
  const now = new Date().toISOString();
  const previousAttempts = [...(previous?.previousAttempts ?? [])];
  if (expectedStatus === "FAILED" && previous?.startedAt) {
    previousAttempts.push({
      startedAt: previous.startedAt,
      finishedAt: previous.failedAt ?? now,
      outcome: "FAILED",
      ...(action.error_message ? { errorMessage: action.error_message.slice(0, 500) } : {}),
    });
  }
  const payload = AgentActionPayloadSchema.parse({
    ...action.payload_json,
    execution: {
      attemptCount,
      startedAt: now,
      ...(previousAttempts.length ? { previousAttempts: previousAttempts.slice(-2) } : {}),
    },
  });
  return transitionAction(supabase, action.id, expectedStatus, {
    status: "EXECUTING",
    payload_json: payload,
    error_message: null,
  });
}

async function executeClaimedAction(
  response: express.Response,
  supabase: SupabaseClient,
  action: AgentActionRow,
  logger: RouterLogger,
): Promise<void> {
  try {
    const execution = await applyAllowlistedCustomerEffect(supabase, action);
    const completedAt = new Date().toISOString();
    const payload = AgentActionPayloadSchema.parse({
      ...action.payload_json,
      execution: {
        ...action.payload_json.execution,
        completedAt,
        result: execution.result,
        customerMutation: execution.mutation ?? "NONE",
      },
    });
    const completed = await transitionAction(supabase, action.id, "EXECUTING", {
      status: "COMPLETED",
      payload_json: payload,
      error_message: null,
      executed_at: completedAt,
    });
    if (completed.error || !completed.action) {
      throw new ActionExecutionFailure("The demo change finished, but its completed audit state could not be saved.");
    }
    response.json({ action: completed.action, customer: execution.customer });
  } catch (error) {
    const message = error instanceof ActionExecutionFailure
      ? error.message
      : "The deterministic demo action failed. It remains approved and can be safely retried.";
    const failedAt = new Date().toISOString();
    logger.error("Approved deterministic action execution failed.", error);
    const failedPayload = AgentActionPayloadSchema.parse({
      ...action.payload_json,
      execution: {
        ...action.payload_json.execution,
        failedAt,
        lastError: message,
      },
    });
    const failed = await transitionAction(supabase, action.id, "EXECUTING", {
      status: "FAILED",
      payload_json: failedPayload,
      error_message: message,
    });
    if (failed.error) logger.error("Failed action state could not be persisted.", failed.error);
    const current = failed.action ?? (await loadActionById(supabase, action.id)).action;
    if (current) {
      const customer = await loadDemoCustomerById(supabase, current.payload_json.targetDemoCustomerId);
      response.status(503).json({ action: current, customer: customer.customer });
      return;
    }
    sendError(response, 503, "ACTION_EXECUTION_FAILED", message);
  }
}

async function applyAllowlistedCustomerEffect(
  supabase: SupabaseClient,
  action: AgentActionRow,
): Promise<CustomerExecution> {
  const targetId = action.payload_json.targetDemoCustomerId;
  const noMutation = async (result: string): Promise<CustomerExecution> => {
    const customer = await loadDemoCustomerById(supabase, targetId);
    if (customer.error) throw new ActionExecutionFailure("The linked demo customer could not be reloaded.");
    return { customer: customer.customer, mutation: "NONE", result };
  };

  if (action.action_type === "CREATE_RETENTION_FOLLOWUP" && targetId === DEMO_CUSTOMER_IDS.retention) {
    const result = await setSyntheticCustomerField(supabase, targetId, "health_status", "HEALTHY", "AT_RISK", "EXISTING_CUSTOMER");
    return {
      customer: result.customer,
      mutation: result.changed ? "HEALTH_AT_RISK" : "NONE",
      result: result.changed
        ? "Retention follow-up created; synthetic customer health marked AT_RISK."
        : "Retention follow-up created; synthetic customer was already AT_RISK.",
    };
  }

  if (action.action_type === "CREATE_SALES_FOLLOWUP" && targetId === DEMO_CUSTOMER_IDS.termiteLead) {
    const result = await setSyntheticCustomerField(supabase, targetId, "pipeline_stage", "NEW", "QUALIFIED", "LEAD");
    return {
      customer: result.customer,
      mutation: result.changed ? "PIPELINE_QUALIFIED" : "NONE",
      result: result.changed
        ? "Sales follow-up created; synthetic lead moved to QUALIFIED."
        : "Sales follow-up created; the synthetic lead had already progressed beyond NEW.",
    };
  }

  return noMutation(`${action.payload_json.title} created; no customer field change was required.`);
}

async function setSyntheticCustomerField(
  supabase: SupabaseClient,
  id: string,
  field: "health_status" | "pipeline_stage",
  fromValue: string,
  toValue: string,
  requiredType: string,
): Promise<{ customer: DemoCustomer; changed: boolean }> {
  const current = await loadDemoCustomerById(supabase, id);
  if (current.error || !current.customer || current.customer.customer_type !== requiredType) {
    throw new ActionExecutionFailure("The fixed synthetic demo customer could not be validated.");
  }
  if (current.customer[field] === toValue) return { customer: current.customer, changed: false };
  if (current.customer[field] !== fromValue && field === "health_status") {
    throw new ActionExecutionFailure("The synthetic customer health state changed; review it before retrying.");
  }
  if (current.customer[field] !== fromValue && field === "pipeline_stage") {
    return { customer: current.customer, changed: false };
  }

  const { data, error } = await supabase
    .from("demo_customers")
    .update({ [field]: toValue })
    .eq("id", id)
    .eq("customer_type", requiredType)
    .eq(field, fromValue)
    .select("*")
    .maybeSingle();
  if (error) {
    throw new ActionExecutionFailure(
      "The synthetic demo customer update failed during deterministic execution; the approved action is safe to retry.",
    );
  }
  const updated = data ? DemoCustomerSchema.safeParse(data) : null;
  if (updated?.success) return { customer: updated.data, changed: true };

  const latest = await loadDemoCustomerById(supabase, id);
  if (latest.error || !latest.customer || latest.customer.customer_type !== requiredType) {
    throw new ActionExecutionFailure("The synthetic demo customer could not be verified after the update.");
  }
  if (latest.customer[field] === toValue) return { customer: latest.customer, changed: false };
  throw new ActionExecutionFailure("The synthetic customer state changed before the update could be applied.");
}

async function loadDemoCustomerById(
  supabase: SupabaseClient,
  id: string | null,
): Promise<{ customer: DemoCustomer | null; error: unknown | null }> {
  if (!id) return { customer: null, error: null };
  try {
    const { data, error } = await supabase.from("demo_customers").select("*").eq("id", id).maybeSingle();
    if (error) return { customer: null, error };
    const parsed = data ? DemoCustomerSchema.safeParse(data) : null;
    return { customer: parsed?.success ? parsed.data : null, error: data && !parsed?.success ? new Error("Demo customer row failed validation.") : null };
  } catch (error) {
    return { customer: null, error };
  }
}

async function loadSyntheticCustomers(
  supabase: SupabaseClient,
): Promise<{ customers: DemoCustomer[]; error: unknown | null }> {
  try {
    const { data, error } = await supabase
      .from("demo_customers")
      .select("*")
      .in("id", DEMO_CUSTOMER_ID_LIST);
    if (error) return { customers: [], error };
    const rows = Array.isArray(data) ? data : [];
    const customersById = new Map<string, DemoCustomer>();
    for (const row of rows) {
      const parsed = DemoCustomerSchema.safeParse(row);
      if (parsed.success && isDemoCustomerId(parsed.data.id)) customersById.set(parsed.data.id, parsed.data);
    }
    return { customers: DEMO_CUSTOMER_ID_LIST.flatMap((id) => customersById.get(id) ?? []), error: null };
  } catch (error) {
    return { customers: [], error };
  }
}

async function sendActionWithCustomer(
  response: express.Response,
  supabase: SupabaseClient,
  action: AgentActionRow,
  statusCode = 200,
): Promise<void> {
  const result = await loadDemoCustomerById(supabase, action.payload_json.targetDemoCustomerId);
  response.status(statusCode).json({ action, customer: result.customer });
}

function respondToUnavailableApprovalState(response: express.Response, action: AgentActionRow): void {
  if (action.status === "REJECTED") {
    sendError(response, 409, "ACTION_REJECTED", "A rejected action cannot be executed.");
  } else if (action.status === "FAILED") {
    sendError(response, 503, "ACTION_EXECUTION_FAILED", action.error_message ?? "The approved action failed and can be retried.");
  } else {
    sendError(response, 409, "ACTION_STATE_CHANGED", "The action changed state. Refresh and review it.");
  }
}

function hasEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  return typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
}

function sendError(response: express.Response, statusCode: number, code: string, message: string): void {
  response.status(statusCode).json({ error: { code, message } });
}

class ActionExecutionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionExecutionFailure";
  }
}
