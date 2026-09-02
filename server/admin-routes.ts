import type { Express } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { hashPassword, verifyPassword } from "./auth";
import { requireAdmin } from "./admin-auth";
import { insertAgentCatalogSchema, insertAgentPackageSchema, insertMcpServerSchema } from "@shared/schema";
import {
  listModels, listOrgSkills, syncUserAgentToZoowork, ensurePreviewUser,
} from "./zoowork-admin";

export function registerAdminRoutes(app: Express) {
  // ── Admin auth ──────────────────────────────────────────────────────────

  app.post("/api/sysadmin/login", async (req, res) => {
    try {
      const { email, password } = z
        .object({ email: z.string().email(), password: z.string().min(1) })
        .parse(req.body);
      const admin = await storage.getAdminByEmail(email);
      if (!admin || !verifyPassword(password, admin.password)) {
        return res.status(401).json({ message: "Invalid credentials." });
      }
      req.session.adminUserId = admin.id;
      res.json({ admin: { id: admin.id, email: admin.email } });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  app.post("/api/sysadmin/logout", (req, res) => {
    req.session.adminUserId = undefined;
    res.json({ message: "Logged out" });
  });

  app.get("/api/sysadmin/me", requireAdmin, (req, res) => {
    const admin = (req as any).admin;
    res.json({ admin: { id: admin.id, email: admin.email } });
  });

  // ── Customers ───────────────────────────────────────────────────────────

  app.get("/api/sysadmin/customers", requireAdmin, async (_req, res) => {
    const users = await storage.getAllUsers();
    const customers = await Promise.all(
      users.map(async (u) => {
        const [subscription, restaurants] = await Promise.all([
          storage.getSubscriptionByUser(u.id),
          storage.getRestaurants(u.id),
        ]);
        const { password, ...safeUser } = u;
        return { ...safeUser, subscription: subscription ?? null, restaurantCount: restaurants.length };
      }),
    );
    res.json({ customers });
  });

  app.put("/api/sysadmin/customers/:userId/subscription", requireAdmin, async (req, res) => {
    try {
      const { packageId, addonAgentIds, status } = z
        .object({
          packageId: z.string().nullable(),
          addonAgentIds: z.array(z.string()).default([]),
          status: z.enum(["active", "canceled"]).default("active"),
        })
        .parse(req.body);
      const sub = await storage.upsertSubscription(String(req.params.userId), { packageId, addonAgentIds, status });
      res.json({ subscription: sub });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // ── Agent catalog ───────────────────────────────────────────────────────

  app.get("/api/sysadmin/agents", requireAdmin, async (_req, res) => {
    res.json({ agents: await storage.listAgentCatalog() });
  });

  app.post("/api/sysadmin/agents", requireAdmin, async (req, res) => {
    try {
      const data = insertAgentCatalogSchema.parse(req.body);
      const entry = await storage.createAgentCatalogEntry(data);
      res.status(201).json({ agent: entry });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  app.patch("/api/sysadmin/agents/:id", requireAdmin, async (req, res) => {
    try {
      const patch = insertAgentCatalogSchema.partial().omit({ key: true }).parse(req.body);
      const entry = await storage.updateAgentCatalogEntry(String(req.params.id), patch);
      res.json({ agent: entry });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  app.delete("/api/sysadmin/agents/:id", requireAdmin, async (req, res) => {
    await storage.deleteAgentCatalogEntry(String(req.params.id));
    res.json({ ok: true });
  });

  // Test-syncs against a reserved preview user (never a real customer), so
  // trying out a prompt/model/skill/MCP change never touches paying customers'
  // ZooWork agents. Real customers sync lazily on their next chat turn.
  app.post("/api/sysadmin/agents/:id/sync", requireAdmin, async (req, res) => {
    try {
      const entry = await storage.getAgentCatalogById(String(req.params.id));
      if (!entry) return res.status(404).json({ message: "Agent not found" });
      const previewUserId = await ensurePreviewUser();
      const zooworkAgentId = await syncUserAgentToZoowork(previewUserId, entry);
      res.json({ agent: entry, zooworkAgentId });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Sync failed" });
    }
  });

  // Skills are declared state on the catalog row — each customer's own ZooWork
  // agent picks up the change lazily on their next chat turn (see
  // syncUserAgentToZoowork), so this never calls ZooWork directly.
  app.put("/api/sysadmin/agents/:id/skills", requireAdmin, async (req, res) => {
    try {
      const { skillIds } = z.object({ skillIds: z.array(z.string()) }).parse(req.body);
      const entry = await storage.updateAgentCatalogEntry(String(req.params.id), { skillIds });
      res.json({ agent: entry });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // MCP servers this agent template offers — a customer still needs their own
  // saved credential (see /api/mcp-credentials) before it's actually attached.
  app.put("/api/sysadmin/agents/:id/mcp-servers", requireAdmin, async (req, res) => {
    try {
      const { mcpServerIds } = z.object({ mcpServerIds: z.array(z.string()) }).parse(req.body);
      await storage.setAgentMcpBindings(String(req.params.id), mcpServerIds);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  app.get("/api/sysadmin/agents/:id/mcp-servers", requireAdmin, async (req, res) => {
    res.json({ mcpServerIds: await storage.getAgentMcpServerIds(String(req.params.id)) });
  });

  app.get("/api/sysadmin/agents/:id/preview-status", requireAdmin, async (req, res) => {
    const previewUserId = await ensurePreviewUser();
    const instance = await storage.getUserAgentInstance(previewUserId, String(req.params.id));
    res.json({ zooworkAgentId: instance?.zooworkAgentId ?? null });
  });

  // ── ZooWork passthrough (for the agent editor's dropdowns) ─────────────

  app.get("/api/sysadmin/zoowork/models", requireAdmin, async (_req, res) => {
    try {
      res.json({ models: await listModels() });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to list models" });
    }
  });

  app.get("/api/sysadmin/zoowork/skills", requireAdmin, async (_req, res) => {
    try {
      res.json({ skills: await listOrgSkills() });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to list skills" });
    }
  });

  // ── Agent packages (products) ───────────────────────────────────────────

  app.get("/api/sysadmin/packages", requireAdmin, async (_req, res) => {
    const packages = await storage.listAgentPackages();
    const withItems = await Promise.all(
      packages.map(async (p) => ({ ...p, agentIds: await storage.getAgentPackageItemIds(p.id) })),
    );
    res.json({ packages: withItems });
  });

  app.post("/api/sysadmin/packages", requireAdmin, async (req, res) => {
    try {
      const { agentIds, ...rest } = z
        .object({ agentIds: z.array(z.string()).default([]) })
        .and(insertAgentPackageSchema)
        .parse(req.body);
      const pkg = await storage.createAgentPackage(rest);
      await storage.setAgentPackageItems(pkg.id, agentIds);
      res.status(201).json({ package: { ...pkg, agentIds } });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  app.patch("/api/sysadmin/packages/:id", requireAdmin, async (req, res) => {
    try {
      const { agentIds, ...rest } = z
        .object({ agentIds: z.array(z.string()).optional() })
        .and(insertAgentPackageSchema.partial())
        .parse(req.body);
      const pkg = await storage.updateAgentPackage(String(req.params.id), rest);
      if (agentIds) await storage.setAgentPackageItems(pkg.id, agentIds);
      res.json({ package: { ...pkg, agentIds: agentIds ?? (await storage.getAgentPackageItemIds(pkg.id)) } });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  app.delete("/api/sysadmin/packages/:id", requireAdmin, async (req, res) => {
    await storage.deleteAgentPackage(String(req.params.id));
    res.json({ ok: true });
  });

  // ── Payment records (mocked) ────────────────────────────────────────────

  app.get("/api/sysadmin/payments", requireAdmin, async (req, res) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const [payments, users] = await Promise.all([
      storage.listPaymentRecords({ userId, limit: 200 }),
      storage.getAllUsers(),
    ]);
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    res.json({ payments: payments.map((p) => ({ ...p, userEmail: emailById.get(p.userId) ?? p.userId })) });
  });

  app.post("/api/sysadmin/payments/simulate", requireAdmin, async (req, res) => {
    try {
      const input = z
        .object({
          userId: z.string().min(1),
          kind: z.enum(["package_subscribe", "addon_purchase", "renewal"]),
          packageId: z.string().nullable().optional(),
          agentId: z.string().nullable().optional(),
          amountCents: z.number().int().nonnegative(),
          outcome: z.enum(["succeeded", "failed"]),
          failureReason: z.string().optional(),
        })
        .parse(req.body);

      await storage.createPaymentRecord({
        userId: input.userId,
        kind: input.kind,
        packageId: input.packageId ?? null,
        agentId: input.agentId ?? null,
        amountCents: input.amountCents,
        status: "initiated",
        failureReason: null,
      });
      const final = await storage.createPaymentRecord({
        userId: input.userId,
        kind: input.kind,
        packageId: input.packageId ?? null,
        agentId: input.agentId ?? null,
        amountCents: input.amountCents,
        status: input.outcome,
        failureReason: input.outcome === "failed" ? (input.failureReason || "card_declined") : null,
      });
      res.status(201).json({ payment: final });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  // ── MCP servers ─────────────────────────────────────────────────────────
  // Admin-managed "real" MCP server records. The actual URL declared to
  // ZooWork is always our own public proxy (server/mcp-proxy.ts), never
  // targetUrl directly — that only appears here and inside the proxy.

  app.get("/api/sysadmin/mcp-servers", requireAdmin, async (_req, res) => {
    res.json({ mcpServers: await storage.listMcpServers() });
  });

  app.post("/api/sysadmin/mcp-servers", requireAdmin, async (req, res) => {
    try {
      const data = insertMcpServerSchema.parse(req.body);
      const server = await storage.createMcpServer(data);
      res.status(201).json({ mcpServer: server });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ message: err.errors[0]?.message || "Invalid input" });
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  app.patch("/api/sysadmin/mcp-servers/:id", requireAdmin, async (req, res) => {
    try {
      const patch = insertMcpServerSchema.partial().omit({ key: true }).parse(req.body);
      const server = await storage.updateMcpServer(String(req.params.id), patch);
      res.json({ mcpServer: server });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Invalid request" });
    }
  });

  app.delete("/api/sysadmin/mcp-servers/:id", requireAdmin, async (req, res) => {
    await storage.deleteMcpServer(String(req.params.id));
    res.json({ ok: true });
  });
}
