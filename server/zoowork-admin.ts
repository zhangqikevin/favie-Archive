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
import type { AgentCatalogEntry, UserMcpCredential } from "@shared/schema";
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

/**
 * Without this, the agent has the MCP tool FUNCTIONS available (ZooWork wires
 * them in automatically once `mcp` is declared) but no idea they exist unless
 * the user's request happens to make the model reach for them on its own —
 * it won't proactively mention or offer to use a connected integration. This
 * tells it by name what's live and how to invoke it.
 */
function buildConnectedIntegrationsSection(connected: { key: string; name: string; description: string | null }[]): string {
  if (connected.length === 0) return "";
  const lines = connected.map((s) => `- "${s.name}" — tools named mcp__${s.key}__*${s.description ? `. ${s.description}` : ""}`);
  return (
    "\n\nYou currently have these connected tool integrations available — use them whenever relevant " +
    "instead of saying you can't look something up:\n" + lines.join("\n")
  );
}

// Applied to every synced agent regardless of what sysadmin wrote for personaPrompt —
// an empty or unset personaPrompt otherwise falls through to the platform's own default
// self-description ("I'm an AI assistant from ZooWork..."), which leaks our vendor's name
// to the end customer.
const BRAND_GUARD =
  "\n\nYou are a Favie AI assistant. Never mention \"ZooWork\" or any other underlying platform " +
  "or vendor by name — from the user's perspective, you are simply Favie.";

// Used whenever a catalog entry's own personaPrompt is blank, so a sysadmin forgetting to
// fill one in still gets a coherent, on-brand agent instead of a generic one.
const DEFAULT_PERSONA_PROMPT =
  "You are Favie, a helpful AI assistant for restaurant owners and operators. Answer questions " +
  "clearly and practically. You do not yet have access to the user's live business data or " +
  "specialized tools unless a tool result says otherwise; say so rather than inventing numbers.";

// Bump this whenever persona construction below changes in a way that should force every
// already-synced agent to re-push on its next use — configHash only reflects the catalog
// entry's own fields, so a change to how we assemble the final prompt from those fields
// would otherwise go unnoticed by the "has this changed since last sync" check.
const PERSONA_TEMPLATE_VERSION = "v3-connected-integrations";

function proxyUrlFor(proxyToken: string): string {
  const base = process.env.MCP_PROXY_BASE_URL;
  if (!base) throw new Error("MCP_PROXY_BASE_URL is not set");
  return `${base.replace(/\/$/, "")}/mcp/${proxyToken}`;
}

function buildPersona(personaPrompt: string, connected: { key: string; name: string; description: string | null }[]): string {
  return (personaPrompt.trim() || DEFAULT_PERSONA_PROMPT) + BRAND_GUARD
    + buildConnectedIntegrationsSection(connected) + MCP_CONNECT_HINT;
}

function configHash(
  model: string | null,
  personaPrompt: string,
  skillIds: string[],
  mcp: { name: string; url: string; transport: McpTransport }[],
): string {
  const mcpKey = mcp.map((m) => `${m.name}:${m.url}:${m.transport}`).sort().join(",");
  return createHash("sha256")
    .update(`${PERSONA_TEMPLATE_VERSION}\n${model ?? ""}\n${personaPrompt}\n${[...skillIds].sort().join(",")}\n${mcpKey}`)
    .digest("hex");
}

export async function listModels() {
  return zc.listModels();
}

export async function listOrgSkills() {
  return zc.listSkills({ scope: "org" });
}

/**
 * MCP servers this customer has already supplied a key for, paired with their
 * credential — the ones actually live on their agent right now. Two kinds count:
 * servers a sysadmin explicitly bound to this catalog entry (agentMcpBindings), and
 * servers the customer provisioned themselves (source "composio_catalog" or
 * "user_custom", see storage.getSelfServeMcpServers) — those aren't scoped to any one
 * agent and become available to every agent of theirs as soon as they connect. Anything
 * bound-but-not-yet-connected is omitted; the persona's connect hint tells the model
 * to point the user at the Connect button for those instead.
 */
async function getConnectedMcpServers(userId: string, catalogId: string) {
  const boundServers = await storage.getMcpServersForAgent(catalogId);
  const selfServeServers = await storage.getSelfServeMcpServers();
  // A server can be both explicitly bound AND self-serve-eligible (e.g. a sysadmin bound
  // it to this catalog entry after a customer had already provisioned it via Browse) —
  // dedupe by id or ZooWork rejects the mcp[] array outright ("must be unique server names").
  const candidates = Array.from(new Map([...boundServers, ...selfServeServers].map((s) => [s.id, s])).values());
  const connected: { server: (typeof candidates)[number]; credential: UserMcpCredential }[] = [];
  for (const server of candidates) {
    const cred = await storage.getUserMcpCredential(userId, server.id);
    if (cred) connected.push({ server, credential: cred });
  }
  return connected;
}

/**
 * Ensure `userId` has a running ZooWork agent for this catalog entry, creating
 * it on first use and re-pushing config only when the template or this user's
 * MCP connections actually changed since the last sync.
 */
export async function syncUserAgentToZoowork(userId: string, entry: AgentCatalogEntry): Promise<string> {
  const connected = await getConnectedMcpServers(userId, entry.id);
  const mcp = connected.map(({ server, credential }) => ({
    name: server.key,
    url: proxyUrlFor(credential.proxyToken),
    transport: asTransport(server.transport),
  }));
  const skillIds = entry.skillIds as string[];
  const hash = configHash(entry.model, entry.personaPrompt, skillIds, mcp);
  const persona = buildPersona(entry.personaPrompt, connected.map(({ server }) => server));

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
