import { createZooworkClient } from "@zoowork-ai/sdk";

// Single shared client — reused by both the customer-facing chat path
// (zoowork-agent.ts) and the System Admin agent-management path (zoowork-admin.ts).
export const zc = createZooworkClient();
