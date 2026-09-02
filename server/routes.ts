import type { Express } from "express";
import QRCode from "qrcode";
import { createServer, type Server } from "http";
import passport from "passport";
import { storage } from "./storage";
import { hashPassword } from "./auth";
import { insertUserSchema } from "@shared/schema";
import { z } from "zod";
import { getAgentSystemPrompt, type AgentId, AGENT_META, DEFAULT_ROLES, DEFAULT_RULES } from "./agent-context";
import { TASK_SEED } from "./task-seed";
import {
  exchangeCodeForTokens,
  fetchStores,
  fetchStoreDetails,
  buildFavieSystemPrompt,
  getRedirectUri,
  buildAuthUrl,
} from "./ubereats-api";
import { syncOpencrawAgent, callOpenclaw } from "./openclaw";
import { getEffectiveOpenclawConfig, DEFAULT_OPENCLAW_BASE_URL, maskApiKey } from "./openclaw-config";
import { chatWithAgentSlot, chatWithCatalogKeyUnchecked, NotEntitledError } from "./zoowork-agent";
import { getEntitledSlots } from "./agent-entitlements";
import { registerAdminRoutes } from "./admin-routes";
import { registerMcpProxyRoutes } from "./mcp-proxy";
import { registerUploadRoutes } from "./uploads";
import { ensurePreviewUser, ensureFavieDataMcpServer } from "./zoowork-admin";
import { encryptSecret, decryptSecret } from "./crypto";
import { findComposioConnection, deleteComposioConnection, listComposioToolkits } from "./composio-client";
import {
  composioApiKey,
  startToolkitConnection,
  checkToolkitConnectionStatus,
  listConnectedConnectors,
  getPopularCategories,
  createCustomMcpServer,
  listCustomMcpConnections,
} from "./connectors-service";
import { getLogs } from "./log-buffer";
import * as zwChannels from "./zoowork-channels";
import { ChannelApiError } from "./zoowork-channels";
import cron from "node-cron";

// Default config values (used when system_config entries are not set)
const DEFAULT_APP_BASE_URL = "https://favieai.replit.app";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

import { withDeliveryInstructions } from "./delivery-instructions";

// ─── Shared Memory Sync ────────────────────────────────────────────────────────

const ALL_AGENT_IDS: AgentId[] = ["operation", "chef", "social", "customer", "finance", "legal", "expert"];

function buildSummaryPrompt(chatText: string, dateStr: string): string {
  return `Below are recent chat messages from a restaurant management team across all agents.
Summarize the key cross-agent insights in concise bullet points (max 200 words).
Focus on: customer feedback, operational issues, menu problems, financial signals.
Format your response EXACTLY as:

<!-- SHARED MEMORY ${dateStr} -->
## Team Insights — ${dateStr}
- ...
<!-- /SHARED MEMORY ${dateStr} -->

MESSAGES:
${chatText}`;
}

function buildPrependPrompt(block: string): string {
  return `Prepend the following block to the very top of your MEMORY.md file.
Do NOT modify, move, or delete any existing content in the file.
Simply insert this block before everything else, followed by a blank line.
If MEMORY.md does not exist yet, create it with only this block.
Reply "Done." after writing.

BLOCK:
${block}`;
}

async function runMemorySyncForUser(
  userId: string,
  since: Date,
): Promise<void> {
  const { baseUrl, apiKey } = await getEffectiveOpenclawConfig(userId);
  if (!baseUrl || !apiKey) return;

  const msgs = await storage.getAllChatHistorySince(userId, since);
  if (!msgs.length) return;

  const chatText = msgs
    .map((m) => `[${m.agentId}/${m.role}]: ${m.text}`)
    .join("\n");

  const dateStr = new Date().toISOString().slice(0, 10);
  const opAgentId = `favie-${userId.slice(0, 8)}-operation`;

  let sharedBlock: string;
  try {
    sharedBlock = await callOpenclaw(
      baseUrl, apiKey, opAgentId, `${userId}-memsync`,
      buildSummaryPrompt(chatText, dateStr),
      [{ role: "user", content: "Please summarize the recent cross-agent insights." }],
      600,
    );
  } catch (e: any) {
    console.warn(`[memsync] summary failed for ${userId}:`, e.message);
    return;
  }

  if (!sharedBlock.includes(`<!-- SHARED MEMORY ${dateStr} -->`)) return;

  const prependPrompt = buildPrependPrompt(sharedBlock);
  await Promise.all(ALL_AGENT_IDS.map(async (agentId) => {
    const ocAgentId = `favie-${userId.slice(0, 8)}-${agentId}`;
    callOpenclaw(
      baseUrl, apiKey, ocAgentId, `${userId}-memsync-write`,
      prependPrompt,
      [{ role: "user", content: "Please update your MEMORY.md." }],
      100,
    ).catch((e: Error) => console.warn(`[memsync] write failed ${ocAgentId}:`, e.message));
  }));
}

// ─── Expert Agent Onboarding ───────────────────────────────────────────────────

async function triggerExpertOnboarding(
  userId: string,
  restaurant: { id: string; name: string; address: string; rating: string | null; reviewCount: number | null },
  cfg: Record<string, string>,
): Promise<void> {
  const ratingLine = restaurant.rating
    ? `Current rating: ${restaurant.rating}${restaurant.reviewCount ? ` (${restaurant.reviewCount} reviews)` : ""}.`
    : "No rating data yet.";

  const systemPrompt = `You are the Restaurant Expert, a seasoned restaurant industry consultant working for Favie, an AI restaurant growth platform. You are assigned to help the owner of ${restaurant.name}, located at ${restaurant.address}. ${ratingLine}

IMPORTANT: You are a B2B advisor. The person you are speaking with is the restaurant owner or operator — a business professional seeking growth and operational advice. You are NOT restaurant staff. Never act as if you are greeting diners, offering menu items, taking reservations, or serving guests.

You are meeting this restaurant owner for the first time. Your job right now is to briefly introduce yourself (1 sentence) and ask 3-4 short, targeted questions to understand their business situation before providing a personalized analysis.
Cover these areas in your questions:
1. Main business model — dine-in, delivery, or both?
2. How long have they been open?
3. Biggest current pain point — give 3-4 options (e.g. "reviews & reputation / controlling costs / getting more customers / operations & staff")
4. Approximate scale — daily covers or monthly revenue range

Be warm and concise. Do NOT explain what you will do after they answer — just ask. Reply in the same language the user is likely to use based on the restaurant's location.`;

  let text: string;
  try {
    ({ text } = await chatWithCatalogKeyUnchecked(userId, "expert", `${systemPrompt}\n\nStart.`));
  } catch (e: any) {
    console.warn("[expert-onboard] chatWithCatalogKeyUnchecked failed:", e.message);
    return;
  }

  if (!text.trim()) return;

  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
  await storage.saveChatMessage({
    userId,
    agentId: "expert",
    role: "ai",
    text: text.trim(),
    ts,
  });
}

// ───────────────────────────────────────────────────────────────────────────────

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {

  registerAdminRoutes(app);
  registerMcpProxyRoutes(app);
  registerUploadRoutes(app);

  // Seed the first System Admin account if none exists yet.
  storage.countAdminUsers().then(async (count) => {
    if (count > 0) return;
    const email = process.env.SYSADMIN_EMAIL || "admin@favie.local";
    const password = process.env.SYSADMIN_PASSWORD || "favie-admin-dev";
    await storage.createAdminUser({ email, password: hashPassword(password) });
    console.log(`[sysadmin] seeded first admin account: ${email}`);
  }).catch((e) => console.error("Admin seed error:", e));

  ensurePreviewUser().catch((e) => console.error("Preview user seed error:", e));
  ensureFavieDataMcpServer().catch((e) => console.error("FavieData MCP server seed error:", e));

  // Seed task definitions on startup
  storage.seedTaskDefinitions(TASK_SEED).catch((e) =>
    console.error("Task seed error:", e)
  );

  // Seed default agent role/rules into system_config on startup.
  // Only writes keys that don't already exist in DB — never overwrites user customizations.
  storage.getSystemConfig().then(async (cfg) => {
    const defaults: Record<string, string> = {};
    for (const id of Object.keys(AGENT_META) as AgentId[]) {
      if (!cfg[`agent_${id}_role`])  defaults[`agent_${id}_role`]  = DEFAULT_ROLES[id];
      if (!cfg[`agent_${id}_rules`]) defaults[`agent_${id}_rules`] = DEFAULT_RULES[id];
    }
    if (Object.keys(defaults).length > 0) {
      await storage.setSystemConfig(defaults);
    }
  }).catch((e) => console.error("Agent defaults seed error:", e));

  // ========== UBEREATS WEBHOOK ROUTES (MUST BE FIRST - Before Vite/Static) ==========

  // Webhooks - support ALL methods for testing
  app.all("/webhook/order-cancelled", (req, res) => {
    console.log("📨 Webhook received - Order Cancelled:", req.body);
    res.status(200).json({ received: true, method: req.method });
  });

  app.all("/webhook/order-notification", (req, res) => {
    console.log("📨 Webhook received - Order Notification:", req.body);
    res.status(200).json({ received: true, method: req.method });
  });

  // Integration Config
  app.post("/api/integration/activate", (_req, res) => {
    console.log("✅ Integration activated");
    res.status(200).json({
      status: "success",
      message: "Integration activated",
      client_id: process.env.UBEREATS_CLIENT_ID || "demo-client",
    });
  });

  app.get("/api/integration/details", (_req, res) => {
    res.status(200).json({
      status: "success",
      integration: {
        client_id: process.env.UBEREATS_CLIENT_ID || "demo-client",
        status: "active",
        webhooks_configured: true,
        store_id: "demo-store-001",
      },
    });
  });

  app.delete("/api/integration", (_req, res) => {
    console.log("✅ Integration removed");
    res.status(204).send();
  });

  app.put("/api/integration", (req, res) => {
    console.log("✅ Integration updated:", req.body);
    res.status(200).json({
      status: "success",
      message: "Integration details updated",
    });
  });

  // Menu
  app.post("/api/menu/upload", (req, res) => {
    console.log("✅ Menu uploaded:", req.body);
    res.status(200).json({
      status: "success",
      menu_id: "menu-" + Date.now(),
      items_processed: req.body.items?.length || 0,
    });
  });

  app.put("/api/menu/item/:itemId", (req, res) => {
    console.log("✅ Item updated:", req.params.itemId, req.body);
    res.status(200).json({
      status: "success",
      item_id: req.params.itemId,
      message: "Item updated successfully",
    });
  });

  // Orders - SPECIFIC ROUTES FIRST (before :orderId param)
  app.post("/api/order/:orderId/accept", (req, res) => {
    console.log("✅ Order accepted:", req.params.orderId);
    res.status(200).json({
      status: "success",
      order_id: req.params.orderId,
      state: "ACCEPTED",
    });
  });

  app.post("/api/order/:orderId/deny", (req, res) => {
    console.log("✅ Order denied:", req.params.orderId);
    res.status(200).json({
      status: "success",
      order_id: req.params.orderId,
      state: "DENIED",
    });
  });

  app.post("/api/order/:orderId/cancel", (req, res) => {
    console.log("✅ Order cancelled:", req.params.orderId);
    res.status(200).json({
      status: "success",
      order_id: req.params.orderId,
      state: "CANCELLED",
    });
  });

  app.put("/api/order/:orderId", (req, res) => {
    console.log("✅ Order updated:", req.params.orderId, req.body);
    res.status(200).json({
      status: "success",
      order_id: req.params.orderId,
      message: "Order updated",
    });
  });

  // Generic order get - MUST BE LAST for /api/order/*
  app.get("/api/order/:orderId", (req, res) => {
    res.status(200).json({
      status: "success",
      order: {
        id: req.params.orderId,
        status: "pending",
        items: [],
        total: 0,
        customer: { name: "Demo Customer" },
        created_at: new Date().toISOString(),
      },
    });
  });

  // Store
  app.put("/api/store/holiday-hours", (req, res) => {
    console.log("✅ Holiday hours updated:", req.body);
    res.status(200).json({
      status: "success",
      message: "Holiday hours updated",
      store_id: "demo-store-001",
    });
  });

  console.log("🚀 UberEats webhook routes registered");

  // ================================================================================

  // GET /api/auth/me — return current user (without password)
  app.get("/api/auth/me", (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const { password, ...safeUser } = req.user;
    res.json({ user: safeUser });
  });

  // POST /api/auth/register
  app.post("/api/auth/register", async (req, res, next) => {
    try {
      const { email, password } = z
        .object({
          email: z.string().email(),
          password: z.string().min(6),
        })
        .parse(req.body);

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res
          .status(400)
          .json({ message: "An account with this email already exists." });
      }

      const user = await storage.createUser({
        email,
        password: hashPassword(password),
      });

      req.login(user as Express.User, (err) => {
        if (err) return next(err);
        const { password: _, ...safeUser } = user;
        res.status(201).json({ user: safeUser });
      });
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return res
          .status(400)
          .json({ message: err.errors[0]?.message || "Invalid input" });
      }
      next(err);
    }
  });

  // POST /api/auth/login
  app.post("/api/auth/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) return next(err);
      if (!user) {
        return res
          .status(401)
          .json({ message: info?.message || "Invalid credentials." });
      }
      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        const { password, ...safeUser } = user;
        res.json({ user: safeUser });
      });
    })(req, res, next);
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.json({ message: "Logged out successfully" });
    });
  });

  // POST /api/auth/select-plan
  app.post("/api/auth/select-plan", async (req, res, next) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { planId } = z
        .object({ planId: z.string().min(1) })
        .parse(req.body);
      const updated = await storage.updateUserPlan(req.user.id, planId);
      const { password, ...safeUser } = updated;
      res.json({ user: safeUser });
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return res.status(400).json({ message: "Invalid plan selection" });
      }
      next(err);
    }
  });

  // POST /api/agent/chat — streams the turn back as SSE (text deltas + tool
  // start/end) so the chat UI can render progressively, Claude-Code style,
  // instead of waiting for the whole run before showing anything. Validation
  // and auth are checked BEFORE the response is committed to SSE, so those
  // still fail as plain JSON with a normal status code; everything that goes
  // wrong once streaming has started (including "not entitled") surfaces as
  // an SSE `error` frame instead, since the HTTP status is already sent.
  app.post("/api/agent/chat", async (req, res) => {
    let parsed: { agentId: string; messages: { role: "user" | "assistant"; content: string }[] };
    try {
      parsed = z
        .object({
          agentId: z.string().min(1).max(50),
          messages: z
            .array(
              z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string(),
              }),
            )
            .min(1),
        })
        .parse(req.body);
    } catch (err: any) {
      return res.status(400).json({ message: err.errors?.[0]?.message || "Invalid request" });
    }
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const { agentId, messages } = parsed;
    const userId = req.user.id;
    const lastMsg = messages.at(-1);
    console.log("[chat-api] /api/agent/chat", JSON.stringify({
      userTail: userId.slice(-8),
      agentId,
      msgCount: messages.length,
      lastRole: lastMsg?.role,
      lastPreview: lastMsg?.content?.slice(0, 200) ?? "",
    }));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      // Each agent tab is synced to its own ZooWork agent instance, gated by the
      // user's subscription (see server/zoowork-agent.ts, server/agent-entitlements.ts).
      const { text, steps } = await chatWithAgentSlot(userId, agentId, lastMsg!.content, send);
      send({ type: "done", text, steps });
    } catch (err: any) {
      const message = err instanceof NotEntitledError ? err.message : (err?.message || "Internal server error");
      if (!(err instanceof NotEntitledError)) {
        console.error("[chat-api] error:", err?.stack ?? err?.message ?? JSON.stringify(err));
      }
      send({ type: "error", message });
    } finally {
      res.end();
    }
  });

  // GET /api/agent/my-agents — which agent_catalog products this user's subscription
  // actually entitles them to (any key sysadmin bundled, not just the 7 legacy tabs);
  // drives the sidebar's agent list.
  app.get("/api/agent/my-agents", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const entitled = await getEntitledSlots(req.user.id);
      res.json({
        agents: entitled.map(({ slot, entry }) => ({
          key: slot,
          name: entry.name,
          description: entry.description,
        })),
      });
    } catch (err: any) {
      console.error("[agent-api] my-agents error:", err?.stack ?? err?.message ?? JSON.stringify(err));
      res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // GET /api/chat/:agentId — fetch saved chat history (paginated)
  // Query params: limit (default 20), before (message id for cursor-based pagination)
  app.get("/api/chat/:agentId", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { agentId } = z.object({ agentId: z.string().min(1).max(50) }).parse(req.params);
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const before = req.query.before ? Number(req.query.before) : undefined;
      const { messages, hasMore } = await storage.getChatHistory(req.user.id, agentId, limit, before);
      res.json({ messages, hasMore });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // POST /api/chat/:agentId — save one or more chat messages
  app.post("/api/chat/:agentId", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { agentId } = z.object({ agentId: z.string().min(1).max(50) }).parse(req.params);
      const { messages } = z.object({
        messages: z.array(z.object({
          role: z.string(),
          text: z.string(),
          ts: z.string(),
        })).min(1),
      }).parse(req.body);
      await storage.saveChatMessages(messages.map((m) => ({ userId: req.user!.id, agentId, role: m.role, text: m.text, ts: m.ts })));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // DELETE /api/chat/:agentId — clear chat history for this agent
  app.delete("/api/chat/:agentId", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { agentId } = z.object({ agentId: z.string().min(1).max(50) }).parse(req.params);
      await storage.clearChatHistory(req.user.id, agentId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // DELETE /api/chat/:agentId/:messageId — delete one chat message
  app.delete("/api/chat/:agentId/:messageId", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { agentId, messageId } = z.object({
        agentId: z.string().min(1).max(50),
        messageId: z.string().regex(/^\d+$/).transform(Number),
      }).parse(req.params);
      const deleted = await storage.deleteChatMessage(req.user.id, agentId, messageId);
      if (!deleted) return res.status(404).json({ message: "Message not found" });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // GET /api/mcp/available — MCP servers offered by the "general" agent template,
  // with whether the current user has already connected each one. For OAuth-style
  // servers (authStyle "query_param_shared_key") not yet connected locally, this
  // also checks Composio directly and self-heals: an ACTIVE remote connection the
  // user finished via the hosted OAuth page gets its local credential row created
  // here, and a still-in-flight one is reported as "pending" instead of "connected".
  app.get("/api/mcp/available", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const entry = await storage.getAgentCatalogByKey("general");
      if (!entry) return res.json({ mcpServers: [] });
      const servers = await storage.getMcpServersForAgent(entry.id);
      const creds = await storage.listUserMcpCredentials(req.user.id);
      const connectedIds = new Set(creds.map((c) => c.mcpServerId));

      const mcpServers = await Promise.all(
        servers.map(async (s) => {
          const base = { id: s.id, key: s.key, name: s.name, description: s.description, authStyle: s.authStyle };
          if (connectedIds.has(s.id)) return { ...base, connected: true, pending: false };
          if (s.authStyle !== "query_param_shared_key" || !s.oauthConfigId || !s.encryptedAdminKey) {
            return { ...base, connected: false, pending: false };
          }
          try {
            const adminKey = decryptSecret(s.encryptedAdminKey);
            const remote = await findComposioConnection(adminKey, s.oauthConfigId, req.user!.id);
            if (remote?.status === "ACTIVE") {
              await storage.upsertUserMcpCredential(req.user!.id, s.id, encryptSecret(req.user!.id));
              return { ...base, connected: true, pending: false };
            }
            const pending = remote ? !["FAILED", "EXPIRED"].includes(remote.status) : false;
            return { ...base, connected: false, pending };
          } catch {
            return { ...base, connected: false, pending: false };
          }
        }),
      );
      res.json({ mcpServers });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to list MCP servers" });
    }
  });

  // GET /api/connectors/catalog — every app Composio can self-serve connect (i.e. we
  // don't need a sysadmin to bring their own OAuth client for it), paginated/searchable,
  // for the Connectors page's "Browse" tab. Cross-referenced with which ones this user
  // has already connected.
  app.get("/api/connectors/catalog", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const page = await listComposioToolkits(composioApiKey(), { search, category, cursor, limit: 40 });
      const connected = new Set((await listConnectedConnectors(req.user.id)).map((c) => c.key));
      res.json({
        items: page.items
          .filter((t) => t.selfServeCapable)
          .map((t) => ({ ...t, connected: connected.has(t.slug) })),
        nextCursor: page.nextCursor,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to load connector catalog" });
    }
  });

  // GET /api/connectors/categories — ranked category filter chips for the Browse tab.
  app.get("/api/connectors/categories", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      res.json({ items: await getPopularCategories() });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to load connector categories" });
    }
  });

  // POST /api/connectors/catalog/:slug/connect — start a hosted Composio OAuth connection
  // for this toolkit, provisioning its mcpServers row on first-ever use. Returns a
  // redirect_url for the client to open; the callback just lands back on the Connectors
  // page, which polls /api/connectors/catalog/:slug/status to notice completion.
  app.post("/api/connectors/catalog/:slug/connect", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { name, description } = z
        .object({ name: z.string().min(1), description: z.string().nullable().optional() })
        .parse(req.body);
      const callbackUrl = `${req.protocol}://${req.get("host")}/admin/plugins`;
      const { redirectUrl } = await startToolkitConnection(
        req.params.slug,
        name,
        description ?? null,
        req.user.id,
        callbackUrl,
      );
      res.json({ redirectUrl });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(500).json({ message: err.message || "Failed to start connection" });
    }
  });

  // GET /api/connectors/catalog/:slug/status — self-heals and reports whether this
  // user's connection for one toolkit has gone ACTIVE yet; polled while "connecting".
  app.get("/api/connectors/catalog/:slug/status", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      res.json(await checkToolkitConnectionStatus(req.params.slug, req.user.id));
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to check connection status" });
    }
  });

  // GET /api/connectors/connected — everything this user has connected, for the
  // Connectors page's "Connected" management tab. Unlike GET /api/mcp/available (used by
  // the in-chat MCP panel), this isn't scoped to any one agent's bindings.
  app.get("/api/connectors/connected", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      res.json({ items: await listConnectedConnectors(req.user.id) });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to list connected connectors" });
    }
  });

  // GET /api/mcps/custom — this user's own custom MCP servers, for the Plug-ins
  // page's "MCPs" tab.
  app.get("/api/mcps/custom", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      res.json({ items: await listCustomMcpConnections(req.user.id) });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to list custom MCP servers" });
    }
  });

  // POST /api/mcps/custom — add and connect a customer's own MCP server. Encrypted at
  // rest; never echoed back. Always creates a brand new mcpServers row (source
  // "user_custom") — unlike Connectors, there's no shared catalog to reuse.
  app.post("/api/mcps/custom", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const body = z
        .object({
          name: z.string().min(1).max(100),
          description: z.string().max(500).nullable().optional(),
          targetUrl: z.string().url(),
          authHeaderName: z.string().min(1).max(100).optional(),
          authScheme: z.string().max(20).optional(),
          apiKey: z.string().min(1),
        })
        .parse(req.body);
      const server = await createCustomMcpServer(req.user.id, {
        name: body.name,
        description: body.description ?? null,
        targetUrl: body.targetUrl,
        authHeaderName: body.authHeaderName ?? "Authorization",
        authScheme: body.authScheme ?? "Bearer ",
        apiKey: body.apiKey,
      });
      res.json({ mcpServerId: server.id, key: server.key, name: server.name });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(500).json({ message: err.message || "Failed to add custom MCP server" });
    }
  });

  // POST /api/mcp/connect — save the current user's own key for one MCP server.
  // Encrypted at rest; never echoed back.
  app.post("/api/mcp/connect", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { mcpServerId, apiKey } = z
        .object({ mcpServerId: z.string().min(1), apiKey: z.string().min(1) })
        .parse(req.body);
      const server = await storage.getMcpServer(mcpServerId);
      if (!server) return res.status(404).json({ message: "MCP server not found" });
      await storage.upsertUserMcpCredential(req.user.id, mcpServerId, encryptSecret(apiKey));
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // DELETE /api/mcp/connect/:mcpServerId — disconnect (removes the stored key). For
  // OAuth-style servers this also deletes+revokes the connection at Composio — otherwise
  // it's still ACTIVE there, and the self-heal in GET /api/mcp/available would just
  // recreate our local row on the very next poll, making "Disconnect" a no-op.
  app.delete("/api/mcp/connect/:mcpServerId", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const server = await storage.getMcpServer(req.params.mcpServerId);
    if (server?.authStyle === "query_param_shared_key" && server.oauthConfigId && server.encryptedAdminKey) {
      try {
        const adminKey = decryptSecret(server.encryptedAdminKey);
        const remote = await findComposioConnection(adminKey, server.oauthConfigId, req.user.id);
        if (remote) await deleteComposioConnection(adminKey, remote.id);
      } catch (err: any) {
        console.error("[mcp] failed to delete Composio connection on disconnect:", err.message);
      }
    }
    await storage.deleteUserMcpCredential(req.user.id, req.params.mcpServerId);
    res.json({ ok: true });
  });

  // ── Restaurant onboarding wizard ────────────────────────────────────────
  // Step 1 reuses POST /api/restaurants (already existed). Steps 2 and 3 live
  // here. "At least one connected platform" is the gate out of step 2; the
  // Favie AI Key in step 3 is just this user's MCP credential for the
  // FavieData server (see zoowork-admin.ts), so agents can use it later.

  const PERMISSION_PLATFORMS = ["ubereats", "doordash", "chowbus", "menusifu"] as const;
  const API_KEY_PLATFORMS = ["toast", "square"] as const;
  const ALL_PLATFORMS = [...PERMISSION_PLATFORMS, ...API_KEY_PLATFORMS] as const;
  type OnboardingPlatform = (typeof ALL_PLATFORMS)[number];

  app.get("/api/onboarding/status", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const restaurants = await storage.getRestaurants(req.user.id);
      const restaurant = restaurants.find((r) => r.id === req.user!.currentRestaurantId) ?? restaurants[0] ?? null;

      let platforms: Record<string, { connected: boolean; hasApiKey: boolean }> = {};
      for (const p of ALL_PLATFORMS) platforms[p] = { connected: false, hasApiKey: false };

      if (restaurant) {
        const rows = await storage.listRestaurantPlatformConnections(restaurant.id);
        for (const row of rows) {
          platforms[row.platform] = { connected: row.connected, hasApiKey: !!row.apiKeyEncrypted };
        }
      }

      const step2Complete = Object.values(platforms).some((p) => p.connected);

      const favieDataServerId = await ensureFavieDataMcpServer();
      const favieCred = await storage.getUserMcpCredential(req.user.id, favieDataServerId);

      res.json({
        restaurant: restaurant ? { id: restaurant.id, name: restaurant.name, address: restaurant.address } : null,
        platforms,
        step2Complete,
        favieKeyConnected: !!favieCred,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to load onboarding status" });
    }
  });

  app.post("/api/onboarding/platform/:platform/verify", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { platform } = z.object({ platform: z.enum(PERMISSION_PLATFORMS) }).parse(req.params);
      const restaurants = await storage.getRestaurants(req.user.id);
      const restaurant = restaurants.find((r) => r.id === req.user!.currentRestaurantId) ?? restaurants[0];
      if (!restaurant) return res.status(400).json({ message: "Create a restaurant first" });

      // Mocked: real verification (checking UberEats/DoorDash/Chowbus/MenuSifu
      // for the restaurants@zoowork.ai grant) comes later. Always succeeds today.
      const row = await storage.upsertRestaurantPlatformConnection(restaurant.id, platform, {
        method: "permission",
        connected: true,
      });
      res.json({ connected: row.connected });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: "Unknown platform" });
      res.status(500).json({ message: err.message || "Verification failed" });
    }
  });

  app.post("/api/onboarding/platform/:platform/api-key", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { platform } = z.object({ platform: z.enum(API_KEY_PLATFORMS) }).parse(req.params);
      const { apiKey } = z.object({ apiKey: z.string().min(1) }).parse(req.body);
      const restaurants = await storage.getRestaurants(req.user.id);
      const restaurant = restaurants.find((r) => r.id === req.user!.currentRestaurantId) ?? restaurants[0];
      if (!restaurant) return res.status(400).json({ message: "Create a restaurant first" });

      const row = await storage.upsertRestaurantPlatformConnection(restaurant.id, platform, {
        method: "api_key",
        apiKeyEncrypted: encryptSecret(apiKey),
        connected: true,
      });
      res.json({ connected: row.connected });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors?.[0]?.message || "Invalid input" });
      res.status(500).json({ message: err.message || "Failed to save API key" });
    }
  });

  app.delete("/api/onboarding/platform/:platform", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { platform } = z.object({ platform: z.enum(ALL_PLATFORMS) }).parse(req.params);
      const restaurants = await storage.getRestaurants(req.user.id);
      const restaurant = restaurants.find((r) => r.id === req.user!.currentRestaurantId) ?? restaurants[0];
      if (!restaurant) return res.status(400).json({ message: "Create a restaurant first" });
      const method: "permission" | "api_key" = (PERMISSION_PLATFORMS as readonly string[]).includes(platform) ? "permission" : "api_key";
      await storage.upsertRestaurantPlatformConnection(restaurant.id, platform, { method, apiKeyEncrypted: null, connected: false });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // POST /api/onboarding/favie-key — validates + stores the Favie AI Key emailed
  // to the customer once Favie's own data pipeline finishes syncing their orders.
  // Stored as this user's MCP credential for the FavieData server (see
  // zoowork-admin.ts) so any agent bound to it can use it later.
  app.post("/api/onboarding/favie-key", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { apiKey } = z.object({ apiKey: z.string().min(1) }).parse(req.body);

      // Mocked: real validation (key correctness + "has the data pull finished")
      // comes later, once Favie's data backend exists. A short key is treated as
      // obviously wrong so the mock isn't a rubber stamp on empty input.
      if (apiKey.trim().length < 8) {
        return res.status(400).json({ valid: false, message: "That doesn't look like a valid Favie AI Key." });
      }

      const favieDataServerId = await ensureFavieDataMcpServer();
      await storage.upsertUserMcpCredential(req.user.id, favieDataServerId, encryptSecret(apiKey));
      res.json({ valid: true, dataSyncComplete: true });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors?.[0]?.message || "Invalid input" });
      res.status(500).json({ message: err.message || "Failed to validate key" });
    }
  });

  // POST /api/task-market/run — run a Task Market AI task
  app.post("/api/task-market/run", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { taskId, inputs } = z
        .object({ taskId: z.string(), inputs: z.record(z.string()) })
        .parse(req.body);

      const systemPrompts: Record<string, string> = {
        "labor-compliance": `You are a California labor law compliance expert specializing in restaurants. 
Provide thorough, accurate, and actionable compliance reports. 
Format your output with clear Markdown sections, bullet points, and tables where helpful.
Always include: current CA minimum wage rates, specific compliance checklist items, and a concise summary for accountants.
Be specific, practical, and reference current California labor codes where relevant.`,

        "food-cost-benchmark": `You are a restaurant financial analyst specializing in the Los Angeles dining market.
Provide detailed food cost benchmark analysis comparing against LA restaurant industry averages.
Format your output with Markdown sections, use tables to show comparisons, and give specific, actionable cost reduction strategies.
Include dollar amounts based on the revenue range provided. Be data-driven and practical.`,

        "menu-engineering": `You are a menu engineering consultant using the classic BCG-style restaurant matrix: Stars (high popularity, high margin), Plow Horses (high popularity, low margin), Puzzles (low popularity, high margin), and Dogs (low popularity, low margin).
Analyze the provided menu and categorize every item. Format your output as a clear Markdown report with:
1. A categorization table for all items
2. Specific pricing recommendations
3. Items to promote (Stars), reprice (Puzzles/Plow Horses), and consider removing (Dogs)
4. Overall menu optimization summary.`,

        "review-reply": `You are a restaurant customer relations expert skilled at crafting professional, empathetic review responses.
Given a negative review and desired tone, provide exactly 3 reply templates: Short (1-2 sentences), Medium (2-3 sentences), and Long (full paragraph).
Format clearly with headers for each template. Each reply should acknowledge the issue, apologize sincerely, and invite the customer back.`,

        "social-media-pack": `You are a restaurant social media manager specializing in Instagram and Facebook content for restaurants.
Create a complete 7-day content calendar. For each day provide:
- Platform (Instagram vs Facebook or both)
- Post copy (engaging, brand-voice appropriate)
- 5-10 relevant hashtags
- Recommended posting time
Format as a clean Markdown calendar with clear day headings. Include a mix of promotional, engaging, and story-driven content.`,

        "schedule-optimizer": `You are a restaurant operations and staffing expert.
Create an optimized weekly staff schedule based on the provided information. Your output should include:
1. A weekly schedule table (Mon-Sun) with shift assignments by role
2. Estimated total labor hours and cost per role
3. Overtime risk flags
4. Recommendations to improve efficiency and reduce labor cost
Format with clear Markdown tables and sections. Be specific and practical.`,

        "employee-handbook": `You are a California employment law specialist and HR consultant for restaurants.
Generate a comprehensive, California-compliant employee handbook. Structure it with clear Markdown sections covering: Welcome & Mission, At-Will Employment, Working Hours & Attendance, Dress Code & Personal Appearance, Tip Policy & Distribution, Meal & Rest Breaks (CA law), Paid Sick Leave, Anti-Harassment Policy, Disciplinary Procedures, and Technology & Social Media Use.
Tailor the content to the restaurant's size and service type (delivery/dine-in). Be thorough, professional, and legally accurate for California.`,

        "job-description": `You are an HR specialist who writes compelling job postings for restaurants.
Write a ready-to-publish job description optimized for Indeed and Craigslist. Include: Job Title, About the Restaurant (brief compelling pitch), Key Responsibilities (bullet list), Requirements (bullet list), What We Offer (benefits/perks), and How to Apply.
Keep the tone professional yet welcoming. Format cleanly in Markdown. Make it scannable and engaging for applicants.`,

        "disciplinary-warning": `You are a California employment law HR specialist for restaurants.
Draft a formal written disciplinary warning letter that is California-compliant and suitable for signing. Structure it as: Date & Header, Employee Information, Description of Violation, Previous Warnings (if any), Required Corrective Action, Consequences of Non-Compliance, Employee Acknowledgment signature block.
Be professional, factual, and legally precise. Format as a formal business letter in Markdown.`,

        "termination-checklist": `You are a California labor law compliance specialist.
Generate a comprehensive California termination compliance checklist. Cover all required steps including: Final paycheck timing (immediate for involuntary, 72 hrs for voluntary per CA Labor Code 201-202), COBRA notification (14-day window), Unemployment insurance notice (DE 2320), Return of company property, Benefit termination timelines, Reference policy, Record retention requirements.
Format as a detailed, numbered checklist with deadlines and relevant CA Labor Code citations. Include a section for voluntary vs. involuntary differences.`,

        "break-even": `You are a restaurant financial analyst and accountant.
Calculate the break-even point for the restaurant based on their fixed and variable costs. Your output should include:
1. Monthly fixed costs total
2. Variable cost percentage (food cost)
3. Contribution margin per dollar of revenue
4. Monthly break-even revenue needed
5. Daily break-even revenue
6. How many covers (table turns) needed per day at their average check
7. A clear, simple summary the owner can act on
Format with Markdown headers and a summary table. Use real dollar amounts throughout.`,

        "catering-quote": `You are a restaurant catering sales and pricing expert.
Generate a complete, professional catering quote. Include:
1. Per-person food cost breakdown
2. Total food cost
3. Recommended selling price (at 28-32% food cost target)
4. Gross profit and profit margin
5. Staffing estimate (servers/cooks needed)
6. Suggested contract terms (deposit %, cancellation policy, final headcount deadline)
7. A formatted quote summary suitable for sending to the client
Format professionally in Markdown. Be specific with dollar amounts.`,

        "price-increase-letter": `You are a restaurant communications specialist skilled at writing customer-facing announcements.
Write a warm, empathetic price increase notice that explains the reasons honestly without alienating loyal customers. The letter should:
- Thank loyal customers
- Acknowledge the price change directly (don't bury it)
- Explain the reasons briefly and honestly
- Emphasize the value and quality they receive
- Close warmly and invite them to continue their relationship
Provide two versions: one for social media (shorter, casual) and one for in-restaurant signage or email (slightly longer). Format in Markdown.`,

        "dish-cost-card": `You are a restaurant food cost analyst.
Calculate the full cost breakdown for this dish. Provide:
1. Cost per ingredient (quantity used × unit cost)
2. Total ingredient cost per serving
3. Recommended menu price (at 28-32% food cost)
4. Profit at current price vs. recommended price
5. Food cost percentage assessment (too high / on target / excellent)
6. Specific suggestions if the cost is too high
Format as a clean cost card in Markdown with a table for ingredients and a summary section.`,

        "recipe-scaler": `You are a professional chef and culinary math specialist.
Scale the provided recipe to the target number of portions. For each ingredient:
- Calculate the new quantity precisely
- Convert to the most practical unit (e.g., don't say 48 teaspoons, say 1 cup)
- Flag any ingredients that don't scale linearly (leavening agents, salt, spices)
Format as a clean, printable Markdown recipe card with the scaled ingredients and any scaling notes.`,

        "seasonal-menu": `You are a creative executive chef with deep knowledge of seasonal ingredients and restaurant menu development.
Create a seasonal menu proposal with 8-12 new dish suggestions. For each dish include:
- Dish name (creative and appetizing)
- 2-3 sentence description (menu-copy style)
- Core seasonal ingredients
- Estimated food cost per serving
- Suggested menu price
Keep the suggestions practical and achievable. Format as a clean Markdown menu proposal organized by course (appetizers, mains, desserts).`,

        "allergen-audit": `You are a food safety and allergen compliance specialist.
For each dish listed, identify which of the 8 major allergens are present: Milk, Eggs, Fish, Shellfish, Tree Nuts, Peanuts, Wheat/Gluten, Soybeans.
Provide:
1. An allergen matrix table (dish rows × allergen columns, ✓ or blank)
2. A plain-language allergen disclosure statement suitable for menus or websites
3. A list of dishes that are allergen-free or suitable for common dietary needs (GF, dairy-free, etc.)
Be thorough and conservative — flag potential cross-contamination risks. Format with clear Markdown tables.`,

        "staff-meal": `You are a restaurant operations specialist focused on practical staff feeding solutions.
Create a 5-day staff meal plan that uses common kitchen trim and leftover prep ingredients to minimize waste. For each day provide:
- Meal name and brief description
- Key ingredients (focus on what's already in the kitchen)
- Estimated cost per person
- Preparation notes (quick to make, uses downtime)
End with a total 5-day cost estimate and tips for keeping staff meals varied and satisfying. Format cleanly in Markdown.`,

        "menu-description": `You are a professional menu copywriter specializing in restaurant menus.
Write compelling, appetite-inspiring descriptions for each dish provided. Each description should be 1-3 sentences, vivid but concise, and make the dish sound irresistible.
Provide descriptions in the requested style. Format as a Markdown list: dish name as header, description below. Also provide 2-3 style notes at the end about the voice/tone used for consistency.`,

        "onboarding-schedule": `You are a restaurant operations and training specialist.
Create a detailed two-week new hire onboarding and training schedule. For each of the 14 days provide: Training focus for the day, Specific tasks/topics covered, Who leads the training (manager/senior staff/chef), Learning objectives, and any materials needed.
Tailor the schedule to the employee's role and department (kitchen or front-of-house). Format as a clean day-by-day Markdown table or schedule. Be practical and thorough.`,

        "faq-generator": `You are a restaurant marketing and customer experience specialist.
Generate a comprehensive FAQ page with 15-20 questions and answers tailored to the restaurant type and question topics provided.
Organize FAQs into logical sections (e.g., Reservations, Parking, Menu, Delivery, Events). Keep answers concise, warm, and customer-friendly.
Format cleanly in Markdown with section headers and Q&A pairs. Each answer should be 1-3 sentences.`,

        "complaint-email": `You are a restaurant customer relations expert specializing in professional complaint resolution.
Write a professional, empathetic email response to a customer complaint. The response should:
- Open with a sincere, specific apology (not generic)
- Acknowledge exactly what went wrong without making excuses
- Explain briefly what happened or why (if known)
- Offer a concrete remedy (refund, comp, invitation back)
- Close warmly and invite the customer to return
Strike the right balance: empathetic but not groveling, professional but not cold. Format as a proper email with subject line.`,

        "reservation-policy": `You are a restaurant operations specialist and legal writer.
Draft a clear, professional reservation and cancellation policy. Include: how to make reservations, party size limits, deposit requirements if any, cancellation window and fee policy, no-show policy, and late-arrival wait policy.
Format as polished, customer-facing policy text suitable for a website or email. Also provide a shorter 3-4 sentence version for confirmation texts.`,

        "loyalty-program": `You are a restaurant marketing strategist specializing in customer retention programs.
Design a practical, effective loyalty program. Include: program name and concept (points/stamp/tiers), how customers earn rewards, reward tiers and what they unlock, welcome bonus, digital vs. physical format suggestion, sample launch copy, and estimated cost per redemption.
Make it realistic for a single-location restaurant. Format in Markdown.`,

        "gbp-optimizer": `You are a local SEO and Google Business Profile specialist for restaurants.
Write an optimized Google Business Profile description (under 750 characters) that leads with the key differentiator, includes local keywords, and ends with a soft call-to-action.
Also provide: 5 suggested categories, 10 recommended attributes to enable, and 3 sample Google Posts ideas. Format in Markdown.`,

        "email-newsletter": `You are a restaurant email marketing specialist.
Write a complete monthly email newsletter with: 2 A/B subject line options, preview text (90 chars max), header greeting, featured story section, new dishes section, events/promos section, a CTA (reservation/order/social), and footer.
Keep the tone warm and on-brand. Format in Markdown.`,

        "grand-opening": `You are a restaurant PR and marketing specialist.
Create a multi-channel grand opening announcement package with: a social media post (Instagram/Facebook) with hashtags, in-store poster/flyer copy, a properly formatted local press release (headline, dateline, 3-4 paragraphs, boilerplate), and a Google Business post.
Format each section clearly in Markdown.`,

        "promo-designer": `You are a restaurant promotions strategist.
Design a complete promotional campaign. Include: concept and name, specific discount/offer structure, duration and timing, target channels with ready-to-use copy for each, expected business impact and ROI estimate, and metrics to track.
Format in Markdown.`,

        "open-close-checklist": `You are a restaurant operations expert.
Create detailed opening and closing checklists organized by staff role (Manager, Server, Kitchen, Bar). For each role provide opening and closing tasks in logical order as printable Markdown checklists with checkboxes (- [ ] Task).`,

        "health-inspection": `You are a restaurant health and safety compliance specialist with expertise in California health department inspections.
Generate a comprehensive pre-inspection checklist organized by inspection category (Food Temperature, Personal Hygiene, Cross-Contamination, Equipment Sanitation, Facility Maintenance, Pest Control, Documentation).
For each category list specific items inspectors check, common point deductions, and corrective action notes. Format as a detailed, actionable Markdown checklist.`,

        "vendor-rfq": `You are a restaurant procurement specialist.
Create a professional Request for Quotation (RFQ) document including: introduction paragraph, product specifications table, required vendor qualifications, pricing request format with volume discount tiers, payment terms, evaluation criteria, and submission deadline.
Format as a professional business document in Markdown.`,

        "pos-vendor-comparison": `You are a restaurant technology consultant specializing in POS system selection and vendor management.
Compare POS systems comprehensively for the restaurant described. Cover the top 10 most relevant platforms (Toast, Square, Lightspeed, Clover, TouchBistro, Revel, Aloha, SpotOn, Lavu, Upserve) across these criteria: monthly cost (hardware + software + processing), key features, delivery/online ordering integration, inventory management, reporting depth, ease of use, and customer support quality.
Provide: a scored comparison table (1–5 per criterion), a clear recommendation with rationale, estimated cost to switch, and a vendor negotiation checklist.
Format with clear Markdown tables and sections. Be specific and practical.`,

        "pricing-formula": `You are a restaurant revenue optimization consultant specializing in menu pricing strategy.
Apply the 4.8x revenue pricing formula combined with menu engineering principles. The 4.8x model sets menu prices at 4.8× the direct food cost to target a ~21% food cost ratio — the threshold for sustainable restaurant economics.
Using the data provided, produce: a pricing analysis showing ideal price targets versus current prices, a menu engineering matrix summary (Stars / Plow Horses / Puzzles / Dogs) for their current situation, specific price adjustment recommendations with projected margin impact, and a 6-month revenue projection if recommendations are implemented.
Format with clear Markdown sections and tables. Use actual dollar figures throughout.`,

        "labor-utilization": `You are a restaurant operations efficiency expert specializing in labor cost optimization.
Analyze the restaurant's labor utilization and produce a detailed efficiency report. Include:
1. Labor utilization assessment by role and time period (peak vs. off-peak vs. shoulder hours)
2. Overstaffed and understaffed time windows with specific hours
3. Recommended schedule adjustments to close the utilization gap
4. Current estimated labor cost % vs. target (industry benchmark: 28–35% for full-service)
5. Priority actions ranked by potential dollar savings, with estimated impact for each
Format as a professional operations report in Markdown with tables and specific action items.`,

        "supplier-comparison": `You are a restaurant procurement and vendor negotiation specialist.
Perform a comprehensive supplier comparison and negotiation analysis. Provide:
1. A side-by-side price comparison table for the product categories provided, benchmarked against typical wholesale market rates
2. Dollar-amount overpayment estimate vs. market rate
3. Alternative supplier options to consider (by category)
4. Specific negotiation talking points for each supplier relationship
5. A recommended negotiation sequence and timeline
6. A negotiation email/call script template ready to use immediately
Format professionally in Markdown with tables. Include specific dollar amounts and percentage gaps.`,

        "local-acquisition": `You are a restaurant growth strategist specializing in local market analysis and customer acquisition.
Create a hyper-local customer acquisition strategy based on the restaurant's location, cuisine, and demographic context. Provide:
1. Trade area demographic profile (estimated 0.5–1 mile radius): population density, age distribution, income level, daytime vs. residential traffic
2. Top 3 underserved customer segments in the area with acquisition rationale
3. Channel-by-channel acquisition tactics: local SEO, Google Business optimization, neighborhood social targeting, delivery platform placement, and community partnerships
4. 90-day acquisition plan with specific weekly tactics, timing, and expected reach per channel
5. Budget allocation recommendation across channels (with % split)
6. Key metrics to track at 30 / 60 / 90 days
Format as a strategic plan in Markdown.`,

        "channel-expansion": `You are a restaurant business development consultant specializing in revenue channel diversification.
Create a comprehensive expansion plan for takeout and private dining/banquet revenue. Include:
1. Market opportunity size assessment for each channel in the restaurant's local area
2. Step-by-step 90-day launch playbook for the primary channel
3. Pricing and packaging recommendations (e.g., banquet menus, takeout bundles, catering minimums)
4. Required operational adjustments: staffing, equipment, kitchen workflow, and packaging
5. Revenue projections — conservative / base / optimistic scenarios — for 6 months post-launch
6. Sales and marketing approach for each channel with specific outreach templates
7. Key milestones and KPIs to track weekly
Format as a professional expansion plan in Markdown with tables and a timeline.`,

        "lease-negotiation": `You are a commercial real estate advisor and restaurant lease negotiation specialist with deep knowledge of US retail lease law.
Create a comprehensive lease negotiation package. Provide:
1. Market context: how this rent compares to current market rates in the city/neighborhood, with a fair market range estimate
2. Negotiation leverage analysis: tenant's strongest and weakest points
3. Specific concessions to request, prioritized: rent reduction amount, rent-free period (months), TI allowance, renewal option terms, CAM charge caps, exclusivity clause
4. Word-for-word negotiation talking points for the landlord conversation
5. BATNA analysis: what to do if negotiations fail
6. Attorney review checklist: 12 critical lease clauses your lawyer must verify
Format as a professional negotiation brief in Markdown.`,
      };

      const userMessages: Record<string, string> = {
        "labor-compliance": `Please generate a California Labor Law Compliance Check for my restaurant.
Employee count: ${inputs.employeeCount}
Has tipped workers: ${inputs.hasTippedWorkers === "true" ? "Yes" : "No"}

Provide: current CA minimum wage (regular and tipped), which employees are affected, a compliance checklist, and a concise summary for my accountant.`,

        "food-cost-benchmark": `Please analyze my restaurant's food cost performance against LA industry benchmarks.
Current food cost percentage: ${inputs.foodCostPct}%
Monthly revenue range: ${inputs.monthlyRevenue}

Compare against LA restaurant averages for my revenue tier, calculate the dollar gap, and provide at least 5 specific cost reduction recommendations.`,

        "menu-engineering": `Please perform a Menu Engineering Analysis on my menu using the Star/Plow Horse/Puzzle/Dog matrix.

My menu:
${inputs.menuText}

Categorize every item, give pricing recommendations, and tell me which items to promote, reprice, or remove.`,

        "review-reply": `Please draft 3 reply templates for this customer review.
Review text: "${inputs.reviewText}"
Desired tone: ${inputs.tone}

Provide: Short (1-2 sentences), Medium (2-3 sentences), and Long (full paragraph) reply options.`,

        "social-media-pack": `Please create a 7-day social media content pack for my restaurant.
Featured dishes: ${inputs.featuredDishes}
This week's events/promotions: ${inputs.weeklyEvents}

Create 7 days of Instagram/Facebook posts with hashtags and optimal posting times.`,

        "schedule-optimizer": `Please create an optimized weekly staff schedule for my restaurant.
Team size and roles: ${inputs.teamInfo}
Operating hours: ${inputs.operatingHours}
Busiest periods: ${inputs.peakHours}

Provide: weekly schedule table, estimated labor cost, overtime warnings, and efficiency recommendations.`,

        "employee-handbook": `Please generate a California-compliant Employee Handbook for my restaurant.
Restaurant name: ${inputs.restaurantName}
Number of employees: ${inputs.employeeCount}
Service type: ${inputs.serviceType}

Create a comprehensive handbook with all essential California-required policies including attendance, dress code, tip policy, meal/rest breaks, and more.`,

        "job-description": `Please write a compelling, ready-to-post job description for my restaurant.
Job title: ${inputs.jobTitle}
Key responsibilities: ${inputs.responsibilities}
Salary range: ${inputs.salaryRange}

Format for posting on Indeed and Craigslist. Make it engaging and clear.`,

        "disciplinary-warning": `Please draft a formal California-compliant disciplinary warning letter.
Employee name: ${inputs.employeeName}
Violation/issue: ${inputs.violation}
Prior warnings: ${inputs.priorWarnings}

Create a professional, printable warning letter with an employee acknowledgment signature block.`,

        "termination-checklist": `Please generate a California termination compliance checklist for my restaurant.
Termination type: ${inputs.terminationType}
Employee type: ${inputs.employeeType}

Cover all required CA steps: final paycheck timing, COBRA, unemployment notice, property return, and all other legal obligations.`,

        "onboarding-schedule": `Please create a two-week new hire onboarding and training schedule.
Position: ${inputs.position}
Department: ${inputs.department}
Start date: ${inputs.startDate}

Create a detailed day-by-day training plan with tasks, trainer assignments, and learning objectives tailored to this role.`,

        "break-even": `Please calculate the break-even point for my restaurant.
Monthly rent / occupancy: ${inputs.monthlyRent}
Monthly labor cost: ${inputs.monthlyLabor}
Food cost percentage: ${inputs.foodCostPct}%
Average check per guest: ${inputs.avgCheck}

Calculate: monthly break-even revenue, daily break-even revenue, daily covers needed, and give me a clear action summary.`,

        "catering-quote": `Please build a catering quote for an event.
Number of guests: ${inputs.guestCount}
Menu style: ${inputs.menuStyle}
Menu details: ${inputs.menuDetails}
Client's target budget per person: ${inputs.budgetPerHead}

Generate a complete quote with per-person cost, total food cost, recommended selling price, profit margin, staffing estimate, and contract terms.`,

        "price-increase-letter": `Please write a price increase notice for my restaurant.
Price increase: ${inputs.increaseAmount}
Reasons: ${inputs.reasons}
Restaurant style: ${inputs.restaurantStyle}

Write two versions: short (for social media) and longer (for in-restaurant signage or email).`,

        "dish-cost-card": `Please calculate the cost card for this dish.
Dish name: ${inputs.dishName}
Ingredients and costs:
${inputs.ingredients}
${inputs.currentPrice ? `Current menu price: ${inputs.currentPrice}` : ""}

Calculate per-serving cost, recommended price, and assess whether the current pricing is on target.`,

        "recipe-scaler": `Please scale this recipe to the target number of portions.
Original recipe:
${inputs.originalRecipe}
Target portions: ${inputs.targetPortions}

Scale every ingredient, convert to practical units, and flag any ingredients that need special attention when scaling.`,

        "seasonal-menu": `Please create a seasonal menu proposal for my restaurant.
Cuisine type: ${inputs.cuisineType}
Current season: ${inputs.season}
Approximate ingredient budget per dish: ${inputs.budgetPerDish}

Suggest 8-12 new dishes with names, menu descriptions, core ingredients, estimated food cost, and suggested price.`,

        "allergen-audit": `Please perform an allergen audit on my menu.
My menu:
${inputs.menuText}

For each dish, identify all 8 major allergens present. Create an allergen matrix table and a compliance disclosure statement.`,

        "staff-meal": `Please create a 5-day staff meal plan for my restaurant team.
Team size: ${inputs.teamSize}
Commonly available ingredients / kitchen trim: ${inputs.availableIngredients}
Daily budget per person: ${inputs.dailyBudget}

Create 5 days of practical, satisfying staff meals that minimize waste and keep costs low.`,

        "menu-description": `Please write menu descriptions for my dishes.
Dishes: 
${inputs.dishList}
Desired style: ${inputs.style}

Write an appetizing 1-3 sentence description for each dish in the requested style. Include a brief style guide note at the end.`,

        "faq-generator": `Please generate an FAQ page for my restaurant.
Restaurant type: ${inputs.restaurantType}
FAQ topics to cover: ${inputs.faqTopics}

Create 15-20 questions and answers organized into sections. Keep answers concise and friendly.`,

        "complaint-email": `Please write a professional response to this customer complaint.
Original complaint: "${inputs.complaintText}"
What happened on our side: ${inputs.ourSideOfStory}

Write an empathetic, professional email response with a subject line. Include an apology, brief explanation, and a concrete remedy.`,

        "reservation-policy": `Please write a reservation and cancellation policy for my restaurant.
We accept reservations: ${inputs.acceptsReservations}
Maximum party size: ${inputs.maxPartySize}
No-show / late cancellation consequence: ${inputs.noShowPolicy}

Create a full customer-facing policy and a shorter version for confirmation texts.`,

        "loyalty-program": `Please design a loyalty program for my restaurant.
Average check per guest: ${inputs.avgCheck}
Repeat customer goal: ${inputs.repeatGoal}
Discount / reward budget: ${inputs.rewardBudget}

Design a practical points/stamp/tier program with reward thresholds, welcome bonus, launch copy, and estimated cost.`,

        "gbp-optimizer": `Please optimize my Google Business Profile description.
Restaurant description: ${inputs.restaurantDesc}
Signature features / specialties: ${inputs.specialties}
Neighborhood and surroundings: ${inputs.neighborhood}

Write an optimized GBP description (under 750 chars), suggest 5 categories, 10 attributes, and 3 Google Posts ideas.`,

        "email-newsletter": `Please write a monthly email newsletter for my restaurant.
New dishes this month: ${inputs.newDishes}
Events and promotions: ${inputs.events}
Story or highlight to feature: ${inputs.storyContent}

Write a complete newsletter with 2 A/B subject lines, all content sections, and a CTA.`,

        "grand-opening": `Please create a grand opening announcement package for my restaurant.
Opening date: ${inputs.openingDate}
Address: ${inputs.address}
Key selling points / what makes us special: ${inputs.keyPoints}

Provide: social media post, in-store poster copy, local press release, and a Google Business post.`,

        "promo-designer": `Please design a promotional campaign for my restaurant.
Promotion time slot: ${inputs.timeSlot}
Goal: ${inputs.promoGoal}

Design a complete campaign with concept, specific offer, timing, channel copy, ROI estimate, and success metrics.`,

        "open-close-checklist": `Please create opening and closing checklists for my restaurant.
Restaurant type: ${inputs.restaurantType}
Staff roles: ${inputs.staffRoles}

Create checklists organized by role with checkboxes. Format for printing.`,

        "health-inspection": `Please create a health inspection preparation checklist for my restaurant.
City / county: ${inputs.city}
Restaurant type: ${inputs.restaurantType}
Issues from last inspection (if any): ${inputs.previousIssues}

Create a comprehensive pre-inspection checklist organized by inspection category with common deductions and corrective actions.`,

        "vendor-rfq": `Please create a vendor Request for Quotation for my restaurant.
Product categories needed: ${inputs.productCategories}
Estimated monthly volume: ${inputs.monthlyVolume}

Create a professional RFQ document with specifications table, vendor requirements, pricing format, payment terms, and evaluation criteria.`,

        "pos-vendor-comparison": `Please compare POS systems for my restaurant and recommend the best fit.
Current POS system: ${inputs.currentPOS}
Monthly POS cost: $${inputs.monthlyCost}
Pain points with current system: ${inputs.painPoints}
Restaurant type: ${inputs.restaurantType}
Monthly transaction volume: ${inputs.transactionVolume}

Compare the top 10 POS platforms, give me a scored comparison table, a clear recommendation, and a vendor negotiation checklist.`,

        "pricing-formula": `Please apply the 4.8x pricing formula and menu engineering analysis to my restaurant.
Current average check per guest: $${inputs.currentAvgCheck}
Current food cost percentage: ${inputs.foodCostPct}%
Monthly revenue: ${inputs.monthlyRevenue}
Seating capacity: ${inputs.seatingCapacity} seats
Average weekly covers: ${inputs.weeklyCovers}

Show me my optimal price targets under the 4.8x model, my menu engineering matrix position, and specific price adjustments with projected revenue impact.`,

        "labor-utilization": `Please analyze my restaurant's labor utilization and give me scheduling adjustment recommendations.
Team and roles: ${inputs.teamInfo}
Operating hours: ${inputs.operatingHours}
Busiest periods: ${inputs.peakHours}
Current labor cost percentage: ${inputs.currentLaborPct}%

Produce a utilization efficiency report with overstaffed/understaffed windows, specific scheduling changes, and priority actions ranked by dollar savings.`,

        "supplier-comparison": `Please compare my suppliers and build a negotiation strategy.
Product category: ${inputs.productCategory}
Current supplier and pricing details:
${inputs.currentSupplierInfo}
Monthly purchase volume: ${inputs.monthlyVolume}
Target budget: ${inputs.targetBudget}

Compare against wholesale market benchmarks, estimate my overpayment, identify alternative suppliers, and give me a negotiation script ready to use.`,

        "local-acquisition": `Please create a local demographic acquisition strategy for my restaurant.
Restaurant address / neighborhood: ${inputs.restaurantAddress}
Cuisine type: ${inputs.cuisineType}
Price range: ${inputs.priceRange}
Current main customer profile: ${inputs.currentCustomerProfile}
Growth goal: ${inputs.growthGoal}

Build a hyper-local acquisition plan with demographic analysis, top 3 untapped customer segments, channel-by-channel tactics, and a 90-day plan with KPIs.`,

        "channel-expansion": `Please create a takeout and banquet/private dining expansion plan for my restaurant.
Current revenue mix: ${inputs.currentRevenueMix}
Seating capacity: ${inputs.seatingCapacity} seats
Kitchen capacity notes: ${inputs.kitchenCapacity}
Primary channel to grow: ${inputs.targetChannel}
Revenue growth target: ${inputs.targetRevenueIncrease}

Build a 90-day expansion playbook with pricing, operations adjustments, staffing requirements, and 6-month revenue projections.`,

        "lease-negotiation": `Please build a lease negotiation package for my restaurant.
Current monthly rent: $${inputs.currentRent}
Lease expiration: ${inputs.leaseEndDate}
Square footage: ${inputs.squareFootage} sq ft
City / market: ${inputs.propertyCity}
Comparable rents I've found: ${inputs.comparableRents || "Not yet researched — please provide market context based on city"}
Negotiation goal: ${inputs.negotiationGoal}

Create a full negotiation package: market analysis, leverage assessment, specific concessions to request, talking points, and attorney review checklist.`,
      };

      const systemPrompt = systemPrompts[taskId];
      const userMessage = userMessages[taskId];
      if (!systemPrompt || !userMessage) {
        return res.status(400).json({ message: "Unknown task" });
      }

      // Look up which agentId owns this task (falls back to "operation")
      const taskDefs = await storage.getTaskDefinitions();
      const taskDef = taskDefs.find(d => d.id === taskId);
      const taskAgentId = (taskDef?.agentId ?? "operation") as AgentId;

      const cfg = await storage.getSystemConfig();
      const restaurants = await storage.getRestaurants(req.user.id);
      const currentRestaurant = restaurants.find(r => r.id === req.user!.currentRestaurantId) ?? restaurants[0];
      const restaurantId = currentRestaurant?.id ?? "default";
      const restaurantInfo = currentRestaurant
        ? { name: currentRestaurant.name, cuisine: currentRestaurant.cuisine ?? null, address: currentRestaurant.address ?? null, rating: currentRestaurant.rating ?? null, reviewCount: currentRestaurant.reviewCount ?? null }
        : { name: "your restaurant", cuisine: null, address: null, rating: null, reviewCount: null };

      const oc = await getEffectiveOpenclawConfig(req.user.id);
      const appBaseUrl = cfg["app_base_url"] || DEFAULT_APP_BASE_URL;
      const ocId = await syncOpencrawAgent(req.user.id, restaurantId, taskAgentId, restaurantInfo.name, restaurantInfo.cuisine ?? "", systemPrompt, { ...oc, appBaseUrl });
      const enrichedPromptTask = withDeliveryInstructions(systemPrompt, req.user.id, taskAgentId, appBaseUrl, oc.apiKey);
      const text = await callOpenclaw(
        oc.baseUrl,
        oc.apiKey,
        ocId,
        req.user.id,
        enrichedPromptTask,
        [{ role: "user", content: userMessage }],
        4096,
      );

      // Save run to DB (non-blocking)
      storage.createTaskRun({
        userId: req.user.id,
        taskId,
        inputs,
        result: text,
      }).catch((e) => console.error("Task run save error:", e));

      res.json({ text });
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return res.status(400).json({ message: err.errors[0]?.message || "Invalid request" });
      }
      console.error("Task market error:", err);
      res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // GET /api/task-runs — fetch authenticated user's task run history
  app.get("/api/task-runs", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const runs = await storage.getTaskRuns(req.user.id);
      res.json(runs);
    } catch (err: any) {
      console.error("Task runs fetch error:", err);
      res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // GET /api/task-definitions — fetch all task definitions with agent associations
  app.get("/api/task-definitions", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const defs = await storage.getTaskDefinitions();
      res.json(defs);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // ─── Agent Market ──────────────────────────────────────────────────────────
  // Storefront for agentCatalog entries a sysadmin has flagged as individually
  // purchasable (visible + priced, and not already bundled into a package —
  // bundled agents come with a package subscription instead, see
  // sysadmin/products.tsx "可单独购买" column).

  // GET /api/agent-market — list agents purchasable à la carte, with the
  // current user's ownership status for each
  app.get("/api/agent-market", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const [catalog, packages, subscription] = await Promise.all([
        storage.listAgentCatalog(),
        storage.listAgentPackages(),
        storage.getSubscriptionByUser(req.user.id),
      ]);
      const bundledAgentIds = new Set(
        (await Promise.all(packages.map((p) => storage.getAgentPackageItemIds(p.id)))).flat(),
      );
      const ownedAgentIds = new Set(subscription?.addonAgentIds ?? []);
      const agents = catalog
        .filter((a) => a.visible && a.individualPriceCents > 0 && !bundledAgentIds.has(a.id))
        .map((a) => ({
          id: a.id,
          key: a.key,
          name: a.name,
          description: a.description,
          model: a.model,
          individualPriceCents: a.individualPriceCents,
          owned: ownedAgentIds.has(a.id),
        }));
      res.json({ agents });
    } catch (err: any) {
      console.error("Agent market fetch error:", err);
      res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // POST /api/agent-market/purchase — buy one à la carte agent. There's no
  // live payment gateway yet, so this mirrors the sysadmin
  // /api/sysadmin/payments/simulate mock: an "initiated" payment record then
  // a "succeeded" one — then grants the agent via subscriptions.addonAgentIds.
  app.post("/api/agent-market/purchase", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { agentId } = z.object({ agentId: z.string().min(1) }).parse(req.body);

      const agent = await storage.getAgentCatalogById(agentId);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const packages = await storage.listAgentPackages();
      const bundledAgentIds = new Set(
        (await Promise.all(packages.map((p) => storage.getAgentPackageItemIds(p.id)))).flat(),
      );
      if (!agent.visible || agent.individualPriceCents <= 0 || bundledAgentIds.has(agent.id)) {
        return res.status(400).json({ message: "This agent is not available for individual purchase" });
      }

      const subscription = await storage.getSubscriptionByUser(req.user.id);
      const ownedAgentIds: string[] = subscription?.addonAgentIds ?? [];
      if (ownedAgentIds.includes(agent.id)) {
        return res.status(400).json({ message: "You already own this agent" });
      }

      await storage.createPaymentRecord({
        userId: req.user.id,
        kind: "addon_purchase",
        packageId: null,
        agentId: agent.id,
        amountCents: agent.individualPriceCents,
        status: "initiated",
        failureReason: null,
      });
      const payment = await storage.createPaymentRecord({
        userId: req.user.id,
        kind: "addon_purchase",
        packageId: null,
        agentId: agent.id,
        amountCents: agent.individualPriceCents,
        status: "succeeded",
        failureReason: null,
      });

      const newSubscription = await storage.upsertSubscription(req.user.id, {
        packageId: subscription?.packageId ?? null,
        addonAgentIds: [...ownedAgentIds, agent.id],
        status: subscription?.status ?? "active",
      });

      res.status(201).json({ payment, subscription: newSubscription });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      console.error("Agent market purchase error:", err);
      res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // ─── UberEats OAuth & API ──────────────────────────────────────────────────

  // GET /api/ubereats/redirect-uri — return the exact redirect URI to register in UberEats dev portal
  app.get("/api/ubereats/redirect-uri", (_req, res) => {
    res.json({ redirectUri: getRedirectUri() });
  });

  // GET /api/ubereats/status — check if current user has a connected UberEats account
  app.get("/api/ubereats/status", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ connected: false });
    }
    const conn = await storage.getUberEatsConnection(req.user.id);
    if (!conn) return res.json({ connected: false });
    res.json({ connected: true, selectedStoreId: conn.selectedStoreId });
  });

  // GET /api/ubereats/oauth/start — redirect to UberEats authorization
  app.get("/api/ubereats/oauth/start", (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.redirect("/login?next=/ubereats-lab");
    }
    if (!process.env.UBEREATS_CLIENT_ID) {
      return res.redirect("/ubereats-lab?error=not_configured");
    }
    const authUrl = buildAuthUrl((req.user as any).id);
    console.log("[UberEats OAuth] Redirecting to:", authUrl);
    res.redirect(authUrl);
  });

  // GET /api/ubereats/oauth/callback — handle token exchange from UberEats
  app.get("/api/ubereats/oauth/callback", async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    if (error) {
      return res.redirect(`/ubereats-lab?error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      return res.redirect("/ubereats-lab?error=missing_params");
    }
    try {
      const tokens = await exchangeCodeForTokens(code);
      const userId = state;
      await storage.saveUberEatsConnection({
        userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: tokens.expires_in
          ? Math.floor(Date.now() / 1000) + tokens.expires_in
          : null,
        selectedStoreId: null,
      });
      res.redirect("/ubereats-lab?connected=true");
    } catch (err: any) {
      console.error("UberEats OAuth callback error:", err);
      res.redirect("/ubereats-lab?error=token_exchange_failed");
    }
  });

  // GET /api/ubereats/stores — list stores for the connected UberEats account
  app.get("/api/ubereats/stores", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const conn = await storage.getUberEatsConnection(req.user.id);
    if (!conn)
      return res.status(403).json({ message: "UberEats not connected" });
    try {
      const stores = await fetchStores(conn.accessToken);
      res.json({ stores });
    } catch (err: any) {
      console.error("UberEats stores error:", err);
      res
        .status(502)
        .json({ message: err.message || "Failed to fetch stores" });
    }
  });

  // PATCH /api/ubereats/stores/select — save selected store
  app.patch("/api/ubereats/stores/select", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const { storeId } = z
      .object({ storeId: z.string().min(1) })
      .parse(req.body);
    await storage.updateUberEatsConnection(req.user.id, {
      selectedStoreId: storeId,
    });
    res.json({ ok: true });
  });

  // GET /api/ubereats/store — get details for the selected/given store
  app.get("/api/ubereats/store", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const conn = await storage.getUberEatsConnection(req.user.id);
    if (!conn)
      return res.status(403).json({ message: "UberEats not connected" });
    const storeId = (req.query.storeId as string) || conn.selectedStoreId;
    if (!storeId) return res.status(400).json({ message: "No store selected" });
    try {
      const store = await fetchStoreDetails(conn.accessToken, storeId);
      res.json({ store });
    } catch (err: any) {
      console.error("UberEats store details error:", err);
      res.status(502).json({ message: err.message || "Failed to fetch store" });
    }
  });

  // POST /api/ubereats/agent/chat — Favie agent with real UberEats context
  app.post("/api/ubereats/agent/chat", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { messages, storeId } = z
        .object({
          messages: z
            .array(
              z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string(),
              }),
            )
            .min(1),
          storeId: z.string().optional(),
        })
        .parse(req.body);

      const conn = await storage.getUberEatsConnection(req.user.id);
      if (!conn)
        return res.status(403).json({ message: "UberEats not connected" });

      const targetStoreId = storeId || conn.selectedStoreId;
      let store = null;
      if (targetStoreId) {
        try {
          store = await fetchStoreDetails(conn.accessToken, targetStoreId);
        } catch (e) {
          console.warn("Could not fetch store details for Favie prompt:", e);
        }
      }

      const systemPrompt = buildFavieSystemPrompt(store);
      const cfg = await storage.getSystemConfig();
      const restaurants = await storage.getRestaurants(req.user.id);
      const currentRestaurant = restaurants.find(r => r.id === req.user!.currentRestaurantId) ?? restaurants[0];
      const restaurantId = currentRestaurant?.id ?? "default";
      const oc = await getEffectiveOpenclawConfig(req.user.id);
      const appBaseUrl = cfg["app_base_url"] || DEFAULT_APP_BASE_URL;
      const ocId = await syncOpencrawAgent(req.user.id, restaurantId, "operation", currentRestaurant?.name ?? "your restaurant", currentRestaurant?.cuisine ?? "", systemPrompt, { ...oc, appBaseUrl });
      const text = await callOpenclaw(
        oc.baseUrl,
        oc.apiKey,
        ocId,
        req.user.id,
        systemPrompt,
        messages,
        2048,
      );
      res.json({ text });
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return res
          .status(400)
          .json({ message: err.errors[0]?.message || "Invalid request" });
      }
      console.error("UberEats agent chat error:", err);
      res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // ─── Restaurants ─────────────────────────────────────────────────────────────

  app.get("/api/restaurants", async (req, res) => {
    if (!req.isAuthenticated() || !req.user)
      return res.status(401).json({ message: "Not authenticated" });
    const list = await storage.getRestaurants(req.user.id);
    res.json({ restaurants: list });
  });

  // Google Places text search proxy
  app.get("/api/places/search", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Not authenticated" });
    const query = req.query.query as string;
    if (!query) return res.status(400).json({ message: "query required" });
    try {
      const apiKey = process.env.GOOGLE_PLACES_API_KEY || "AIzaSyDOAK5YiHO6ljJOZ73AAbhuCxZE-UJeJ8U";
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.types",
        },
        body: JSON.stringify({ textQuery: query, includedType: "restaurant" }),
      });
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/restaurants", async (req, res) => {
    if (!req.isAuthenticated() || !req.user)
      return res.status(401).json({ message: "Not authenticated" });
    try {
      const { name, address, rating, reviewCount, googleUrl, yelpUrl } = z.object({
        name: z.string().min(2),
        address: z.string().min(5),
        rating: z.string().optional(),
        reviewCount: z.number().optional(),
        googleUrl: z.string().optional(),
        yelpUrl: z.string().optional(),
      }).parse(req.body);

      let restaurant;
      try {
        restaurant = await storage.createRestaurant({
          userId: req.user.id,
          name,
          address,
          rating: rating ?? null,
          reviewCount: reviewCount ?? null,
          ...(googleUrl ? { googleUrl } : {}),
          ...(yelpUrl ? { yelpUrl } : {}),
        });
      } catch (dbErr: any) {
        // Fallback: retry without URL fields if columns don't exist yet
        if (dbErr?.message?.includes("google_url") || dbErr?.message?.includes("yelp_url")) {
          restaurant = await storage.createRestaurant({
            userId: req.user.id,
            name,
            address,
            rating: rating ?? null,
            reviewCount: reviewCount ?? null,
          });
        } else {
          throw dbErr;
        }
      }

      await storage.updateUserCurrentRestaurant(req.user.id, restaurant.id);

      res.status(201).json({ restaurant });

      // Fire-and-forget: Expert Agent personalized onboarding questions
      storage.getSystemConfig().then((cfg) => {
        triggerExpertOnboarding(req.user!.id, restaurant, cfg).catch((e: Error) =>
          console.warn("[expert-onboard] failed:", e.message)
        );
      });
    } catch (err: any) {
      if (err?.name === "ZodError")
        return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  app.delete("/api/restaurants/:id", async (req, res) => {
    if (!req.isAuthenticated() || !req.user)
      return res.status(401).json({ message: "Not authenticated" });
    await storage.deleteRestaurant(req.params.id, req.user.id);

    const user = await storage.getUser(req.user.id);
    if (user?.currentRestaurantId === req.params.id) {
      const remaining = await storage.getRestaurants(req.user.id);
      if (remaining.length > 0) {
        await storage.updateUserCurrentRestaurant(req.user.id, remaining[0].id);
      }
    }

    res.json({ ok: true });
  });

  app.patch("/api/restaurants/current", async (req, res) => {
    if (!req.isAuthenticated() || !req.user)
      return res.status(401).json({ message: "Not authenticated" });
    try {
      const { restaurantId } = z.object({ restaurantId: z.string().min(1) }).parse(req.body);
      await storage.updateUserCurrentRestaurant(req.user.id, restaurantId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ message: "Invalid request" });
    }
  });

  // ─── System Config API ──────────────────────────────────────────────────────
  // Note: openclaw_base_url / openclaw_api_key are still readable here as the
  // GLOBAL fallback (used as placeholder/default when a user has no per-user
  // override). Per-user reads/writes go through /api/user/openclaw-settings.
  app.get("/api/system-config", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Not authenticated" });
    const cfg = await storage.getSystemConfig();
    // Merge DB values over env defaults so the form always shows effective config
    const effective: Record<string, string> = {
      app_base_url:      cfg["app_base_url"]       || DEFAULT_APP_BASE_URL,
      openclaw_base_url: cfg["openclaw_base_url"] || DEFAULT_OPENCLAW_BASE_URL,
      openclaw_api_key:  cfg["openclaw_api_key"]  ?? "",
    };
    if (effective["openclaw_api_key"]) {
      effective["openclaw_api_key"] = maskApiKey(effective["openclaw_api_key"]);
    }
    // Per-agent config — include defaults for role/rules if not overridden
    for (const id of Object.keys(AGENT_META) as AgentId[]) {
      effective[`agent_${id}_enabled`] = cfg[`agent_${id}_enabled`] ?? "true";
      effective[`agent_${id}_role`]    = cfg[`agent_${id}_role`]    ?? DEFAULT_ROLES[id];
      effective[`agent_${id}_rules`]   = cfg[`agent_${id}_rules`]   ?? DEFAULT_RULES[id];
    }
    res.json(effective);
  });

  app.post("/api/system-config", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Not authenticated" });
    try {
      const body = req.body as Record<string, string>;
      const updates: Record<string, string> = {};
      // app base URL
      if (body.app_base_url !== undefined) updates["app_base_url"] = body.app_base_url;
      // openclaw global settings — kept here so an admin can still seed the
      // global fallback. Per-user overrides should be set via
      // /api/user/openclaw-settings instead.
      if (body.openclaw_base_url)               updates["openclaw_base_url"] = body.openclaw_base_url;
      if (body.openclaw_api_key && !body.openclaw_api_key.startsWith("••••••")) {
        updates["openclaw_api_key"] = body.openclaw_api_key;
      }
      // Per-agent settings
      for (const id of Object.keys(AGENT_META) as AgentId[]) {
        const enabled = body[`agent_${id}_enabled`];
        const role    = body[`agent_${id}_role`];
        const rules   = body[`agent_${id}_rules`];
        if (enabled !== undefined) updates[`agent_${id}_enabled`] = enabled;
        if (role    !== undefined) updates[`agent_${id}_role`]    = role;
        if (rules   !== undefined) updates[`agent_${id}_rules`]   = rules;
      }
      await storage.setSystemConfig(updates);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid input" });
    }
  });

  // ─── Per-user Openclaw connection settings ────────────────────────────────
  // GET returns the current user's override (masked) plus the global fallback
  // (also masked) so the UI can render it as a placeholder.
  app.get("/api/user/openclaw-settings", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    const userId = req.user.id;
    const [userSettings, cfg] = await Promise.all([
      storage.getUserOpenclawSettings(userId),
      storage.getSystemConfig(),
    ]);
    const fallbackBaseUrl = cfg["openclaw_base_url"] || DEFAULT_OPENCLAW_BASE_URL;
    const fallbackApiKey  = cfg["openclaw_api_key"]  ?? "";
    res.json({
      baseUrl: userSettings?.baseUrl ?? "",
      apiKey: userSettings?.apiKey ? maskApiKey(userSettings.apiKey) : "",
      fallbackBaseUrl,
      fallbackApiKey: maskApiKey(fallbackApiKey),
    });
  });

  app.patch("/api/user/openclaw-settings", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      const body = z.object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
      }).parse(req.body);

      const updates: { baseUrl?: string | null; apiKey?: string | null } = {};
      if (body.baseUrl !== undefined) {
        const trimmed = body.baseUrl.trim();
        updates.baseUrl = trimmed === "" ? null : trimmed;
      }
      if (body.apiKey !== undefined) {
        // Skip if the value is just the masked placeholder being echoed back.
        if (!body.apiKey.startsWith("••••••")) {
          const trimmed = body.apiKey.trim();
          updates.apiKey = trimmed === "" ? null : trimmed;
        }
      }
      if (Object.keys(updates).length > 0) {
        await storage.setUserOpenclawSettings(req.user.id, updates);
      }
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(400).json({ message: err.message || "Invalid input" });
    }
  });

  // ─── ZooWork channel binding (feishu / slack / wecom / weixin) ───────────────
  // See server/zoowork-channels.ts. Once bound, ZooWork itself owns the
  // conversation on that platform — there is no webhook to receive here.

  function channelErrorResponse(res: import("express").Response, err: any) {
    if (err instanceof ChannelApiError) return res.status(err.status).json({ message: err.message });
    console.error("[zoowork-channel] error:", err?.stack ?? err?.message ?? JSON.stringify(err));
    res.status(500).json({ message: err?.message || "Internal server error" });
  }

  app.get("/api/agent/:slot/channels", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      res.json(await zwChannels.listChannels(req.user.id, req.params.slot));
    } catch (err: any) {
      channelErrorResponse(res, err);
    }
  });

  // POST start a QR setup session (feishu / wecom / weixin)
  app.post("/api/agent/:slot/channels/:platform/setup", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      const { brand, dm_policy, group_policy } = (req.body ?? {}) as Record<string, string>;
      const session = await zwChannels.startSetup(req.user.id, req.params.slot, req.params.platform, {
        brand: brand === "lark" ? "lark" : undefined,
        dm_policy,
        group_policy,
      });
      // The gateway hands back a bare URI (feishu) or a URL/data-URI (wecom/weixin) — render
      // server-side to a data-URL PNG so the frontend can treat it exactly like the old
      // WeChat/WhatsApp QR flow's `imgContent` field. WeChat's own payload may already be a
      // data:image URI — pass it through unchanged in that case.
      const raw = session.verification_uri_complete ?? session.qrcode_url ?? "";
      let imgContent = raw;
      if (raw && !raw.startsWith("data:image")) {
        const qrDataUrl = await QRCode.toDataURL(raw, { width: 256, margin: 2 });
        imgContent = qrDataUrl.replace(/^data:image\/png;base64,/, "");
      } else if (raw.startsWith("data:image")) {
        imgContent = raw.replace(/^data:image\/[a-z]+;base64,/, "");
      }
      res.json({
        sessionId: session.session_id,
        imgContent,
        expiresIn: session.expires_in,
        pollInterval: session.poll_interval ?? null,
      });
    } catch (err: any) {
      channelErrorResponse(res, err);
    }
  });

  app.get("/api/agent/:slot/channels/:platform/setup/:sessionId", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    try {
      res.json(await zwChannels.pollSetup(req.user.id, req.params.slot, req.params.platform, req.params.sessionId));
    } catch (err: any) {
      channelErrorResponse(res, err);
    }
  });

  app.delete("/api/agent/:slot/channels/:platform/setup/:sessionId", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      await zwChannels.cancelSetup(req.user.id, req.params.slot, req.params.platform, req.params.sessionId);
      res.json({ ok: true });
    } catch (err: any) {
      channelErrorResponse(res, err);
    }
  });

  // POST bind via explicit credentials (Slack's only path)
  app.post("/api/agent/:slot/channels/:platform", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      const channel = await zwChannels.addChannelExplicit(req.user.id, req.params.slot, req.params.platform, req.body ?? {});
      res.status(201).json(channel);
    } catch (err: any) {
      channelErrorResponse(res, err);
    }
  });

  app.patch("/api/agent/:slot/channels/:platform", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      const channel = await zwChannels.updateChannel(req.user.id, req.params.slot, req.params.platform, req.body ?? {});
      res.json(channel);
    } catch (err: any) {
      channelErrorResponse(res, err);
    }
  });

  app.delete("/api/agent/:slot/channels/:platform", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      await zwChannels.removeChannel(req.user.id, req.params.slot, req.params.platform);
      res.json({ ok: true });
    } catch (err: any) {
      channelErrorResponse(res, err);
    }
  });

  // ─── Admin: view recent server logs ──────────────────────────────────────────
  app.get("/api/admin/logs", async (req, res) => {
    // Auth: session OR ?key= matching openclaw_api_key
    const cfg = await storage.getSystemConfig();
    const apiKey = (cfg["openclaw_api_key"] ?? "").trim();
    const qKey = ((req.query.key as string) ?? "").trim();
    const authed = (req.isAuthenticated() && req.user) || (apiKey && qKey === apiKey);
    if (!authed) {
      console.log(`[admin/logs] 401: apiKey.len=${apiKey.length} qKey.len=${qKey.length} match=${qKey === apiKey} last6=${apiKey.slice(-6)}`);
      return res.status(401).json({ message: "Not authenticated" });
    }
    const last = Math.min(Number(req.query.last) || 200, 500);
    const filter = (req.query.filter as string) || "";
    let lines = getLogs(last);
    if (filter) lines = lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
    res.type("text/plain").send(lines.join("\n"));
  });

  // ─── Dev: manually trigger memory sync for current user ──────────────────────
  app.get("/api/shared-memory/trigger-sync", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) return res.status(401).json({ error: "unauthorized" });
    const userId = (req.user as any).id as string;
    // Use epoch 0 so all chat history is included in the manual trigger.
    // runMemorySyncForUser resolves per-user Openclaw config internally.
    runMemorySyncForUser(userId, new Date(0))
      .then(() => console.log(`[memsync] manual trigger done for ${userId}`))
      .catch((e: Error) => console.warn(`[memsync] manual trigger failed:`, e.message));
    res.json({ ok: true, message: "Memory sync triggered, running in background." });
  });

  // ─── Daily cron: 03:30 AM incremental shared memory sync ─────────────────────
  cron.schedule("30 3 * * *", async () => {
    console.log("[memsync] Starting incremental memory sync...");
    try {
      const cfg = await storage.getSystemConfig();
      const lastRunStr = cfg["memory_sync_last_run"];
      const since = lastRunStr
        ? new Date(lastRunStr)
        : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

      const allUsers = await storage.getAllUsers();
      await Promise.all(allUsers.map((user) =>
        runMemorySyncForUser(user.id, since).catch((e: Error) =>
          console.warn(`[memsync] failed for ${user.id}:`, e.message)
        )
      ));

      await storage.setSystemConfig({ memory_sync_last_run: new Date().toISOString() });
      console.log("[memsync] Done.");
    } catch (e: any) {
      console.warn("[memsync] cron error:", e.message);
    }
  });

  return httpServer;
}
