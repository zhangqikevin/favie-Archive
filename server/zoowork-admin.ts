/**
 * ZooWork Managed Agents surface used by System Admin's "Agent Management" page,
 * and by the customer chat path (zoowork-agent.ts) to sync each customer's own
 * ZooWork agent instance.
 *
 * Every ZooWork agent is per-customer: `mcp`, `persona`, `model` and `skills`
 * are all agent-level fields, and MCP credentials are per-customer, so there is
 * no way to vary them per session of one shared agent. Each (userId,
 * agentCatalog row) pair gets its own ZooWork agent, tracked in
 * user_agent_instances. The catalog row is the *template* — one edit there
 * reaches every customer's instance the next time they chat, via the hash
 * comparison in syncUserAgentToZoowork.
 */
import { createHash, randomBytes } from "crypto";
import { zc } from "./zoowork-client";
import { storage } from "./storage";
import type { AgentCatalogEntry } from "@shared/schema";
type McpTransport = "streamable-http" | "sse";
function asTransport(t: string): McpTransport {
  return t === "sse" ? "sse" : "streamable-http";
}

// A real `users` row (FK-safe) that System Admin's "test sync" button uses
// instead of a real customer, so trying out a catalog edit never touches a
// paying customer's ZooWork agent instance.
export const PREVIEW_USER_EMAIL = "sysadmin-preview@favie.internal";

export async function ensurePreviewUser(): Promise<string> {
  const existing = await storage.getUserByEmail(PREVIEW_USER_EMAIL);
  if (existing) return existing.id;
  const created = await storage.createUser({
    email: PREVIEW_USER_EMAIL,
    password: randomBytes(32).toString("hex"), // never used to log in
  });
  return created.id;
}

// The internal MCP server step 3 of the restaurant onboarding wizard connects
// to: the customer's "Favie AI Key" (emailed once Favie's own data pipeline has
// synced their orders) is stored as this server's credential, the same way any
// other MCP connection is. Admin can edit the real targetUrl once that data
// service exists — this just guarantees the row is there to bind onto agents.
export const FAVIE_DATA_MCP_KEY = "favie-data";

export async function ensureFavieDataMcpServer(): Promise<string> {
  const servers = await storage.listMcpServers();
  const existing = servers.find((s) => s.key === FAVIE_DATA_MCP_KEY);
  if (existing) return existing.id;
  const created = await storage.createMcpServer({
    key: FAVIE_DATA_MCP_KEY,
    name: "Favie Data",
    description: "Favie's own order/customer data service, keyed per restaurant by the customer's Favie AI Key.",
    targetUrl: "https://data.zoowork.ai/mcp",
    transport: "streamable-http",
    authHeaderName: "Authorization",
    authScheme: "Bearer ",
  });
  return created.id;
}

const MCP_CONNECT_HINT =
  "\n\nIf the user asks to connect a new integration/tool that isn't listed above, tell them to use " +
  "the \"Connect\" button for that service in the panel next to this chat — you cannot collect or " +
  "store API keys yourself.";

function proxyUrlFor(proxyToken: string): string {
  const base = process.env.MCP_PROXY_BASE_URL;
  if (!base) throw new Error("MCP_PROXY_BASE_URL is not set");
  return `${base.replace(/\/$/, "")}/mcp/${proxyToken}`;
}

function configHash(
  model: string | null,
  personaPrompt: string,
  skillIds: string[],
  mcp: { name: string; url: string; transport: McpTransport }[],
): string {
  const mcpKey = mcp.map((m) => `${m.name}:${m.url}:${m.transport}`).sort().join(",");
  return createHash("sha256")
    .update(`${model ?? ""}\n${personaPrompt}\n${[...skillIds].sort().join(",")}\n${mcpKey}`)
    .digest("hex");
}

export async function listModels() {
  return zc.listModels();
}

export async function listOrgSkills() {
  return zc.listSkills({ scope: "org" });
}

/**
 * Build the `mcp` declarations for one customer's agent: only servers bound to
 * this catalog entry AND that this customer has already supplied a key for.
 * Anything bound-but-not-yet-connected is simply omitted — the agent's persona
 * hint tells the model to point the user at the Connect button instead.
 */
async function buildMcpDeclarations(
  userId: string,
  catalogId: string,
): Promise<{ name: string; url: string; transport: McpTransport }[]> {
  const boundServers = await storage.getMcpServersForAgent(catalogId);
  const declarations: { name: string; url: string; transport: McpTransport }[] = [];
  for (const server of boundServers) {
    const cred = await storage.getUserMcpCredential(userId, server.id);
    if (!cred) continue;
    declarations.push({ name: server.key, url: proxyUrlFor(cred.proxyToken), transport: asTransport(server.transport) });
  }
  return declarations;
}

/**
 * Ensure `userId` has a running ZooWork agent for this catalog entry, creating
 * it on first use and re-pushing config only when the template or this user's
 * MCP connections actually changed since the last sync.
 */
export async function syncUserAgentToZoowork(userId: string, entry: AgentCatalogEntry): Promise<string> {
  const mcp = await buildMcpDeclarations(userId, entry.id);
  const skillIds = entry.skillIds as string[];
  const hash = configHash(entry.model, entry.personaPrompt, skillIds, mcp);
  const persona = entry.personaPrompt + MCP_CONNECT_HINT;

  const existing = await storage.getUserAgentInstance(userId, entry.id);

  if (!existing?.zooworkAgentId) {
    const models = await zc.listModels();
    const model = entry.model ?? models.find((m) => m.model.includes("sonnet"))?.model ?? models[0]?.model;
    if (!model) throw new Error("no models available to this ZooWork key");

    const created = await zc.createAgent(
      {
        resource: {
          name: entry.name,
          model: { primary: model },
          persona: { docs: [{ name: "AGENTS.md", content: persona }] },
          ...(mcp.length > 0 ? { mcp } : {}),
        },
      },
      `favie-agent-${entry.id}-${userId}`,
    );
    await zc.startAgent(created.agent_id);
    await zc.waitUntilRunning(created.agent_id);
    await reconcileSkills(created.agent_id, [], skillIds);
    await storage.upsertUserAgentInstanceSync(userId, entry.id, created.agent_id, hash);
    return created.agent_id;
  }

  if (existing.syncedHash !== hash) {
    await zc.updateAgent(existing.zooworkAgentId, {
      name: entry.name,
      persona: { docs: [{ name: "AGENTS.md", content: persona }] },
      ...(entry.model ? { model: { primary: entry.model } } : {}),
      ...(mcp.length > 0 ? { mcp } : {}),
    });
    const attached = await zc.listAgentSkills(existing.zooworkAgentId);
    const attachedIds = attached.map((a: any) => a.skill_id ?? a.id).filter(Boolean);
    await reconcileSkills(existing.zooworkAgentId, attachedIds, skillIds);
    await storage.upsertUserAgentInstanceSync(userId, entry.id, existing.zooworkAgentId, hash);
  }

  return existing.zooworkAgentId;
}

async function reconcileSkills(zooworkAgentId: string, currentIds: string[], desiredIds: string[]) {
  const current = new Set(currentIds);
  const desired = new Set(desiredIds);
  for (const id of Array.from(desired)) {
    if (!current.has(id)) await zc.putAgentSkill(zooworkAgentId, id, { enabled: true }).catch(() => {});
  }
  for (const id of Array.from(current)) {
    if (!desired.has(id)) await zc.deleteAgentSkill(zooworkAgentId, id).catch(() => {});
  }
}
