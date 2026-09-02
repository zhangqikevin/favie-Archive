/**
 * Backs the customer-facing Connectors page: browsing Composio's full toolkit catalog
 * (not just the handful of servers a sysadmin has manually bound to an agent), connecting
 * one on demand, and listing what a user has already connected. A toolkit gets its own
 * mcpServers row the first time ANYONE tries to connect it — auth_config + Composio "MCP
 * server" provisioned automatically, no sysadmin step required.
 */
import { storage } from "./storage";
import { encryptSecret, decryptSecret } from "./crypto";
import {
  ensureComposioAuthConfig,
  createComposioMcpServer,
  composioMcpServerUrl,
  findComposioConnection,
  startComposioConnection,
  listComposioToolkits,
  type ComposioCategory,
} from "./composio-client";
import type { McpServer } from "@shared/schema";

export function composioApiKey(): string {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error("COMPOSIO_API_KEY is not set");
  return key;
}

/** Composio "MCP server" names: 4-30 chars, letters/digits/spaces/hyphens only. */
function mcpServerNameFor(toolkitSlug: string): string {
  const cleaned = `favie-${toolkitSlug}`.replace(/[^a-zA-Z0-9 -]/g, "-").slice(0, 30);
  return cleaned.length >= 4 ? cleaned : cleaned.padEnd(4, "-");
}

export async function getMcpServerByKey(key: string): Promise<McpServer | undefined> {
  const servers = await storage.listMcpServers();
  return servers.find((s) => s.key === key);
}

/** Idempotent: returns the existing row for this toolkit, provisioning one on Composio + locally if needed. */
export async function ensureMcpServerForToolkit(
  toolkitSlug: string,
  toolkitName: string,
  description: string | null,
): Promise<McpServer> {
  const existing = await getMcpServerByKey(toolkitSlug);
  if (existing) return existing;

  const apiKey = composioApiKey();
  const authConfigId = await ensureComposioAuthConfig(apiKey, toolkitSlug);
  const composioServerId = await createComposioMcpServer(apiKey, mcpServerNameFor(toolkitSlug), authConfigId);

  return storage.createMcpServer({
    key: toolkitSlug,
    name: toolkitName,
    description: description ? description.slice(0, 500) : null,
    targetUrl: composioMcpServerUrl(composioServerId),
    transport: "streamable-http",
    authHeaderName: "x-api-key",
    authScheme: "",
    authStyle: "query_param_shared_key",
    encryptedAdminKey: encryptSecret(apiKey),
    oauthConfigId: authConfigId,
  });
}

/** Starts (or resumes) a hosted OAuth connection for `userId` on this toolkit. */
export async function startToolkitConnection(
  toolkitSlug: string,
  toolkitName: string,
  description: string | null,
  userId: string,
  callbackUrl: string,
): Promise<{ redirectUrl: string }> {
  const server = await ensureMcpServerForToolkit(toolkitSlug, toolkitName, description);
  if (!server.oauthConfigId || !server.encryptedAdminKey) {
    throw new Error(`mcpServers row for "${toolkitSlug}" is missing OAuth config`);
  }
  const apiKey = decryptSecret(server.encryptedAdminKey);
  const { redirectUrl } = await startComposioConnection(apiKey, server.oauthConfigId, userId, callbackUrl);
  return { redirectUrl };
}

/** Self-heals: if Composio shows an ACTIVE connection with no local credential row yet, creates one. */
export async function checkToolkitConnectionStatus(
  toolkitSlug: string,
  userId: string,
): Promise<{ connected: boolean; pending: boolean }> {
  const server = await getMcpServerByKey(toolkitSlug);
  if (!server?.oauthConfigId || !server.encryptedAdminKey) return { connected: false, pending: false };

  const existingCred = await storage.getUserMcpCredential(userId, server.id);
  if (existingCred) return { connected: true, pending: false };

  const apiKey = decryptSecret(server.encryptedAdminKey);
  const remote = await findComposioConnection(apiKey, server.oauthConfigId, userId);
  if (remote?.status === "ACTIVE") {
    await storage.upsertUserMcpCredential(userId, server.id, encryptSecret(userId));
    return { connected: true, pending: false };
  }
  const pending = remote ? !["FAILED", "EXPIRED"].includes(remote.status) : false;
  return { connected: false, pending };
}

let categoryCache: { categories: (ComposioCategory & { count: number })[]; fetchedAt: number } | null = null;
const CATEGORY_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Category ids/names, ranked by how often they actually show up on a toolkit — sampled from
 * real toolkit data rather than Composio's separate /toolkits/categories endpoint, whose ~800
 * ids are mostly unfiltered and often don't match anything when passed back in as a filter
 * (see listComposioToolkits' doc comment). Cached in-process since this rarely changes.
 */
export async function getPopularCategories(limit = 14): Promise<ComposioCategory[]> {
  if (categoryCache && Date.now() - categoryCache.fetchedAt < CATEGORY_CACHE_TTL_MS) {
    return categoryCache.categories.slice(0, limit);
  }
  const apiKey = composioApiKey();
  const counts = new Map<string, { name: string; count: number }>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await listComposioToolkits(apiKey, { cursor, limit: 100 });
    for (const toolkit of result.items) {
      if (!toolkit.selfServeCapable) continue;
      for (const cat of toolkit.categories) {
        const existing = counts.get(cat.id);
        counts.set(cat.id, { name: cat.name, count: (existing?.count ?? 0) + 1 });
      }
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const ranked = Array.from(counts.entries())
    .map(([id, { name, count }]) => ({ id, name, count }))
    .sort((a, b) => b.count - a.count);
  categoryCache = { categories: ranked, fetchedAt: Date.now() };
  return ranked.slice(0, limit);
}

export interface ConnectedConnector {
  mcpServerId: string;
  key: string;
  name: string;
  description: string | null;
}

/** Everything this user has actually connected, regardless of which agent(s) it's bound to. */
export async function listConnectedConnectors(userId: string): Promise<ConnectedConnector[]> {
  const creds = await storage.listUserMcpCredentials(userId);
  if (creds.length === 0) return [];
  const servers = await storage.listMcpServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  return creds
    .map((c) => byId.get(c.mcpServerId))
    .filter((s): s is McpServer => !!s)
    .map((s) => ({ mcpServerId: s.id, key: s.key, name: s.name, description: s.description }));
}
