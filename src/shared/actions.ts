import { z } from "zod";
import { PRIORITIES } from "./calls.js";

export const AGENT_ACTION_TYPES = [
  "CREATE_RETENTION_FOLLOWUP",
  "CREATE_SALES_FOLLOWUP",
  "CREATE_UPSELL_TASK",
  "CREATE_COLLECTIONS_FOLLOWUP",
  "CREATE_REACTIVATION_FOLLOWUP",
] as const;

export const AGENT_ACTION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXECUTING", "COMPLETED", "FAILED"] as const;

export const CALL_ACTION_POLICY_STATES = [
  "NOT_READY",
  "ACTION_AVAILABLE",
  "PENDING_ACTION",
  "APPROVED_ACTION",
  "EXECUTING_ACTION",
  "COMPLETED_ACTION",
  "REJECTED_ACTION",
  "FAILED_ACTION",
  "NO_ACTION_REQUIRED",
] as const;

export const CallActionPolicyStateSchema = z.enum(CALL_ACTION_POLICY_STATES);

export const DEMO_CUSTOMER_IDS = {
  retention: "a1000000-0000-4000-8000-000000000001",
  termiteLead: "a1000000-0000-4000-8000-000000000002",
  upsell: "a1000000-0000-4000-8000-000000000003",
} as const;

export const AgentActionTypeSchema = z.enum(AGENT_ACTION_TYPES);
export const AgentActionStatusSchema = z.enum(AGENT_ACTION_STATUSES);

export const DemoCustomerSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    customer_type: z.string().max(80).nullable(),
    pipeline_stage: z.string().max(80).nullable(),
    health_status: z.string().max(80).nullable(),
    assigned_to: z.string().max(200).nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const DemoCustomerSeedSchema = DemoCustomerSchema.pick({
  id: true,
  name: true,
  customer_type: true,
  pipeline_stage: true,
  health_status: true,
  assigned_to: true,
});

const AgentActionExpectedChangesSchema = z
  .object({
    customer: z
      .object({
        healthStatus: z.literal("AT_RISK").optional(),
        pipelineStage: z.literal("QUALIFIED").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const AgentActionExecutionSchema = z
  .object({
    startedAt: z.string().datetime().optional(),
    failedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    result: z.string().max(500).optional(),
    customerMutation: z.enum(["NONE", "HEALTH_AT_RISK", "PIPELINE_QUALIFIED"]).optional(),
    attemptCount: z.number().int().min(1).max(3).optional(),
    lastError: z.string().max(500).optional(),
    previousAttempts: z
      .array(
        z
          .object({
            startedAt: z.string().datetime(),
            finishedAt: z.string().datetime(),
            outcome: z.enum(["FAILED", "COMPLETED"]),
            errorMessage: z.string().max(500).optional(),
            result: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(2)
      .optional(),
  })
  .strict();

const AgentActionRejectionSchema = z
  .object({
    rejectedAt: z.string().datetime(),
  })
  .strict();

export const CustomerCommunicationDraftSchema = z
  .object({
    type: z.literal("EMAIL_DRAFT"),
    subject: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(2400),
    modelUsed: z.literal("gemini-3.5-flash-lite"),
  })
  .strict();

export const AgentActionPayloadSchema = z
  .object({
    version: z.literal(1),
    actionType: AgentActionTypeSchema,
    title: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(500),
    priority: z.enum(PRIORITIES),
    requiresApproval: z.literal(true),
    targetDemoCustomerId: z.string().uuid().nullable(),
    expectedChanges: AgentActionExpectedChangesSchema,
    customerCommunication: CustomerCommunicationDraftSchema.optional(),
    execution: AgentActionExecutionSchema.optional(),
    rejection: AgentActionRejectionSchema.optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.customerCommunication && payload.actionType !== "CREATE_RETENTION_FOLLOWUP") {
      context.addIssue({
        code: "custom",
        message: "Customer communication drafts are only supported for retention follow-ups.",
        path: ["customerCommunication"],
      });
    }

    const actual = payload.expectedChanges.customer ?? {};
    const expected =
      payload.actionType === "CREATE_RETENTION_FOLLOWUP" &&
      payload.targetDemoCustomerId === DEMO_CUSTOMER_IDS.retention
        ? { healthStatus: "AT_RISK" }
        : payload.actionType === "CREATE_SALES_FOLLOWUP" &&
            payload.targetDemoCustomerId === DEMO_CUSTOMER_IDS.termiteLead
          ? { pipelineStage: "QUALIFIED" }
          : {};

    if (
      actual.healthStatus !== expected.healthStatus ||
      actual.pipelineStage !== expected.pipelineStage
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected customer changes must match the deterministic action definition.",
        path: ["expectedChanges"],
      });
    }
  });

export const AgentActionRowSchema = z
  .object({
    id: z.string().uuid(),
    call_id: z.string().uuid(),
    action_type: AgentActionTypeSchema,
    payload_json: AgentActionPayloadSchema,
    status: AgentActionStatusSchema,
    requires_approval: z.literal(true),
    error_message: z.string().nullable(),
    created_at: z.string().min(1),
    approved_at: z.string().nullable(),
    executed_at: z.string().nullable(),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.action_type !== action.payload_json.actionType) {
      context.addIssue({ code: "custom", message: "Action type does not match its validated payload.", path: ["action_type"] });
    }
    if (action.status === "PENDING" && (action.approved_at || action.executed_at || action.payload_json.rejection)) {
      context.addIssue({ code: "custom", message: "Pending action cannot contain a later lifecycle decision.", path: ["status"] });
    }
    if (["APPROVED", "EXECUTING", "COMPLETED", "FAILED"].includes(action.status) && !action.approved_at) {
      context.addIssue({ code: "custom", message: "Action lifecycle must retain its human approval timestamp.", path: ["approved_at"] });
    }
    if (action.status === "APPROVED" && action.executed_at) {
      context.addIssue({ code: "custom", message: "Approved action cannot have an execution completion timestamp.", path: ["executed_at"] });
    }
    if (action.status === "EXECUTING" && (!action.payload_json.execution?.startedAt || action.executed_at)) {
      context.addIssue({ code: "custom", message: "Executing action must have a start timestamp only.", path: ["payload_json", "execution"] });
    }
    if (action.status === "REJECTED" && (!action.payload_json.rejection || action.approved_at || action.executed_at)) {
      context.addIssue({ code: "custom", message: "Rejected action must contain only its rejection decision.", path: ["payload_json", "rejection"] });
    }
    if (action.status === "FAILED" && (!action.error_message || !action.payload_json.execution?.failedAt || action.executed_at)) {
      context.addIssue({ code: "custom", message: "Failed action must preserve its error and failed-at timestamp.", path: ["error_message"] });
    }
    if (action.status === "COMPLETED" && (!action.executed_at || !action.payload_json.execution?.completedAt)) {
      context.addIssue({ code: "custom", message: "Completed action must include its execution timestamps.", path: ["executed_at"] });
    }
    const mutation = action.payload_json.execution?.customerMutation;
    const mutationMatchesType =
      mutation === undefined ||
      mutation === "NONE" ||
      (mutation === "HEALTH_AT_RISK" &&
        action.action_type === "CREATE_RETENTION_FOLLOWUP" &&
        action.payload_json.targetDemoCustomerId === DEMO_CUSTOMER_IDS.retention) ||
      (mutation === "PIPELINE_QUALIFIED" &&
        action.action_type === "CREATE_SALES_FOLLOWUP" &&
        action.payload_json.targetDemoCustomerId === DEMO_CUSTOMER_IDS.termiteLead);
    if (!mutationMatchesType) {
      context.addIssue({ code: "custom", message: "Execution result does not match the deterministic action definition.", path: ["payload_json", "execution", "customerMutation"] });
    }
  });

export type AgentActionType = z.infer<typeof AgentActionTypeSchema>;
export type AgentActionStatus = z.infer<typeof AgentActionStatusSchema>;
export type AgentActionPayload = z.infer<typeof AgentActionPayloadSchema>;
export type AgentActionRow = z.infer<typeof AgentActionRowSchema>;
export type DemoCustomer = z.infer<typeof DemoCustomerSchema>;
export type DemoCustomerSeed = z.infer<typeof DemoCustomerSeedSchema>;
export type CallActionPolicyState = z.infer<typeof CallActionPolicyStateSchema>;

export const MAX_ACTION_EXECUTION_ATTEMPTS = 3;
