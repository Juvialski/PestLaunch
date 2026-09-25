import type { DemoCustomerSeed } from "../src/shared/actions.js";
import { DEMO_CUSTOMER_IDS } from "../src/shared/actions.js";

export { DEMO_CUSTOMER_IDS };

export const DEMO_CUSTOMER_ID_LIST: string[] = Object.values(DEMO_CUSTOMER_IDS);

export const DEMO_CUSTOMERS: DemoCustomerSeed[] = [
  {
    id: DEMO_CUSTOMER_IDS.retention,
    name: "Jordan Example (Synthetic Retention Customer)",
    customer_type: "EXISTING_CUSTOMER",
    pipeline_stage: "WON",
    health_status: "HEALTHY",
    assigned_to: null,
  },
  {
    id: DEMO_CUSTOMER_IDS.termiteLead,
    name: "Taylor Example (Synthetic Termite Lead)",
    customer_type: "LEAD",
    pipeline_stage: "NEW",
    health_status: "HEALTHY",
    assigned_to: null,
  },
  {
    id: DEMO_CUSTOMER_IDS.upsell,
    name: "Morgan Example (Synthetic Mosquito Customer)",
    customer_type: "EXISTING_CUSTOMER",
    pipeline_stage: "WON",
    health_status: "HEALTHY",
    assigned_to: null,
  },
];

export function isDemoCustomerId(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && DEMO_CUSTOMER_ID_LIST.includes(value);
}
