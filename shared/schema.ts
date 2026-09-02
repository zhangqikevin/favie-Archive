import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, numeric, jsonb, serial, index, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  selectedPlan: text("selected_plan"),
  currentRestaurantId: varchar("current_restaurant_id"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const loginSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export const registerSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().min(6, "Please confirm your password"),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export type LoginForm = z.infer<typeof loginSchema>;
export type RegisterForm = z.infer<typeof registerSchema>;

export const bookCallSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Please enter a valid email"),
  restaurantName: z.string().min(1, "Restaurant or business name is required"),
  city: z.string().min(1, "City is required"),
  primaryChallenge: z.string().min(1, "Please select your primary challenge"),
});

export type BookCallForm = z.infer<typeof bookCallSchema>;

export const contactFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Please enter a valid email"),
  restaurantName: z.string().min(1, "Restaurant or business name is required"),
  phone: z.string().optional(),
  primaryChallenge: z.string().min(1, "Please select your primary challenge"),
  message: z.string().min(10, "Please share at least a sentence about your restaurant"),
});

export type ContactForm = z.infer<typeof contactFormSchema>;

// ─── UberEats OAuth connections ───────────────────────────────────────────────

export const uberEatsConnections = pgTable("ubereats_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
  selectedStoreId: text("selected_store_id"),
});

export type UberEatsConnection = typeof uberEatsConnections.$inferSelect;
export type InsertUberEatsConnection = typeof uberEatsConnections.$inferInsert;

// ─── Restaurants ──────────────────────────────────────────────────────────────

export const restaurants = pgTable("restaurants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  phone: text("phone"),
  cuisine: text("cuisine"),
  rating: text("rating"),
  reviewCount: integer("review_count"),
  googleUrl: text("google_url"),
  yelpUrl: text("yelp_url"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertRestaurantSchema = createInsertSchema(restaurants).omit({
  id: true,
  createdAt: true,
});

export type InsertRestaurant = z.infer<typeof insertRestaurantSchema>;
export type Restaurant = typeof restaurants.$inferSelect;

// ─── Task Market ───────────────────────────────────────────────────────────────

export const taskDefinitions = pgTable("task_definitions", {
  id: varchar("id", { length: 100 }).primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  shortDesc: text("short_desc").notNull(),
  agentId: varchar("agent_id", { length: 50 }),
});

export type TaskDefinition = typeof taskDefinitions.$inferSelect;
export type InsertTaskDefinition = typeof taskDefinitions.$inferInsert;

export const taskRuns = pgTable("task_runs", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 100 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  taskId: varchar("task_id", { length: 100 }).notNull().references(() => taskDefinitions.id),
  inputs: jsonb("inputs"),
  result: text("result"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type TaskRun = typeof taskRuns.$inferSelect;
export type InsertTaskRun = typeof taskRuns.$inferInsert;

// ─── Agent Chat History ────────────────────────────────────────────────────────

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  agentId: varchar("agent_id", { length: 50 }).notNull(),
  role: text("role").notNull(),
  text: text("text").notNull(),
  ts: text("ts").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [index("chat_user_agent_idx").on(t.userId, t.agentId)]);

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({ id: true, createdAt: true });
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;

// ─── System Config ─────────────────────────────────────────────────────────────

export const systemConfig = pgTable("system_config", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type SystemConfig = typeof systemConfig.$inferSelect;

// ─── Per-user Openclaw connection settings ─────────────────────────────────────
// Each user can override the global Openclaw base URL / API key for their own
// agents, channel deliveries, and webhook auth. NULL columns mean "inherit
// global system_config value (or hardcoded default)".

export const userOpenclawSettings = pgTable("user_openclaw_settings", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserOpenclawSettingsSchema = createInsertSchema(userOpenclawSettings).omit({ updatedAt: true });
export type InsertUserOpenclawSettings = z.infer<typeof insertUserOpenclawSettingsSchema>;
export type UserOpenclawSettings = typeof userOpenclawSettings.$inferSelect;

// ─── System Admin ──────────────────────────────────────────────────────────────
// Separate credential space from customer `users` — deliberately not the same
// table, so a bug in customer auth can never grant back-office access.

export const adminUsers = pgTable("admin_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AdminUser = typeof adminUsers.$inferSelect;
export type InsertAdminUser = typeof adminUsers.$inferInsert;

// ─── Agent Catalog ─────────────────────────────────────────────────────────────
// Our own record of each sellable agent. `zooworkAgentId` is filled in once the
// underlying ZooWork Managed Agent has been created/synced from this row.

export const agentCatalog = pgTable("agent_catalog", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: varchar("key", { length: 50 }).notNull().unique(), // stable slug, e.g. "general"
  name: text("name").notNull(),
  description: text("description"),
  model: text("model"),                          // e.g. "litellm/claude-sonnet-5"
  personaPrompt: text("persona_prompt").notNull().default(""),
  skillIds: jsonb("skill_ids").notNull().default(sql`'[]'::jsonb`), // ZooWork skill ids attached (desired state, applied per-user on sync)
  visible: boolean("visible").notNull().default(true),      // shown to customers in storefront
  individualPriceCents: integer("individual_price_cents").notNull().default(0), // à la carte monthly add-on price
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAgentCatalogSchema = createInsertSchema(agentCatalog).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertAgentCatalog = z.infer<typeof insertAgentCatalogSchema>;
export type AgentCatalogEntry = typeof agentCatalog.$inferSelect;

// Every ZooWork agent is now per-customer (MCP credentials are per-customer, and
// `mcp`/`persona`/`model` are agent-level fields on the ZooWork side — there is no
// way to vary them per session of a shared agent). `userId` NULL is reserved for
// the System Admin "preview" instance seeded at boot, used to test-sync a catalog
// entry without needing a real customer.
export const userAgentInstances = pgTable("user_agent_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  agentCatalogId: varchar("agent_catalog_id").notNull().references(() => agentCatalog.id, { onDelete: "cascade" }),
  zooworkAgentId: text("zoowork_agent_id"),
  syncedHash: text("synced_hash"), // hash of (model, personaPrompt, skillIds, mcp config) last pushed
  // Persisted so a server restart doesn't orphan the user's conversation — the session's
  // full event log lives on ZooWork, but only reachable by session_id, and streamEvents()
  // replays that whole log from the top without a cursor. Losing either in memory (e.g. a
  // process restart) previously made the agent start a brand-new, context-free session.
  zooworkSessionId: text("zoowork_session_id"),
  streamCursor: text("stream_cursor"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("user_agent_instances_user_catalog_idx").on(t.userId, t.agentCatalogId),
]);

export type UserAgentInstance = typeof userAgentInstances.$inferSelect;
export type InsertUserAgentInstance = typeof userAgentInstances.$inferInsert;

// ─── MCP Servers ────────────────────────────────────────────────────────────────
// Admin-configured "real" MCP servers that require auth. Favie hosts a public,
// unauthenticated proxy (server/mcp-proxy.ts) that ZooWork's `mcp` field points
// at instead; the proxy injects each customer's own key server-side.

export const mcpServers = pgTable("mcp_servers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: varchar("key", { length: 50 }).notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  targetUrl: text("target_url").notNull(),                 // the real, authenticated MCP server
  transport: varchar("transport", { length: 20 }).notNull().default("streamable-http"),
  authHeaderName: varchar("auth_header_name", { length: 100 }).notNull().default("Authorization"),
  authScheme: varchar("auth_scheme", { length: 20 }).notNull().default("Bearer "), // prefix before the key, e.g. "Bearer "
  // "header_secret": each user's own encryptedKey is the header value (e.g. a personal GitHub PAT).
  // "query_param_shared_key": encryptedAdminKey is the header value for every user of this server
  // (e.g. a Composio project key); each user's encryptedKey is instead appended as ?user_id=
  // on targetUrl to select which connected account the call runs as.
  authStyle: varchar("auth_style", { length: 30 }).notNull().default("header_secret"),
  encryptedAdminKey: text("encrypted_admin_key"),           // only set when authStyle is query_param_shared_key
  oauthConfigId: text("oauth_config_id"),                   // Composio auth_config_id, used to start a new OAuth connection
  // Who/what created this row, NOT whether an admin happened to bind it to an agent — a
  // sysadmin-created server can be unbound (e.g. FavieData) and must still stay off the
  // customer-facing Plug-ins page. "sysadmin": system-level, defined in /sysadmin/mcp-servers,
  // baked into agents as baseline capability, never shown to customers. "composio_catalog":
  // provisioned on demand from the Connectors "Browse" tab (server/connectors-service.ts).
  // "user_custom": a customer's own MCP server, added via the Plug-ins "MCPs" tab.
  source: varchar("source", { length: 20 }).notNull().default("sysadmin"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertMcpServerSchema = createInsertSchema(mcpServers).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertMcpServer = z.infer<typeof insertMcpServerSchema>;
export type McpServer = typeof mcpServers.$inferSelect;

// Which MCP servers a given agent template offers (desired state; each customer
// still needs their own credential before it's actually attached to their agent).
export const agentMcpBindings = pgTable("agent_mcp_bindings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentCatalogId: varchar("agent_catalog_id").notNull().references(() => agentCatalog.id, { onDelete: "cascade" }),
  mcpServerId: varchar("mcp_server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
}, (t) => [
  index("agent_mcp_bindings_catalog_idx").on(t.agentCatalogId),
]);

export type AgentMcpBinding = typeof agentMcpBindings.$inferSelect;

// One customer's own key for one MCP server. `encryptedKey` is AES-256-GCM
// ciphertext (see server/crypto.ts) — never stored or returned in plaintext.
// `proxyToken` is the unguessable path segment ZooWork's `mcp.url` points at;
// stable across re-syncs so the ZooWork agent config doesn't change when the
// key itself is rotated.
export const userMcpCredentials = pgTable("user_mcp_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mcpServerId: varchar("mcp_server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  proxyToken: varchar("proxy_token", { length: 64 }).notNull().unique(),
  encryptedKey: text("encrypted_key").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("user_mcp_credentials_user_idx").on(t.userId, t.mcpServerId),
]);

export type UserMcpCredential = typeof userMcpCredentials.$inferSelect;
export type InsertUserMcpCredential = typeof userMcpCredentials.$inferInsert;

// Which of a customer's own agents can use one of their self-serve connections
// (mcpServers.source "composio_catalog" or "user_custom" — see server/connectors-service.ts).
// The customer picks this themselves on the Plug-ins page's Connected view; it has no
// bearing on sysadmin-managed servers, which stay governed by agentMcpBindings alone.
export const userMcpAgentBindings = pgTable("user_mcp_agent_bindings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mcpServerId: varchar("mcp_server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  agentCatalogId: varchar("agent_catalog_id").notNull().references(() => agentCatalog.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("user_mcp_agent_bindings_user_server_idx").on(t.userId, t.mcpServerId),
  index("user_mcp_agent_bindings_user_agent_idx").on(t.userId, t.agentCatalogId),
]);

export type UserMcpAgentBinding = typeof userMcpAgentBindings.$inferSelect;

// ─── Restaurant Data Onboarding ─────────────────────────────────────────────────
// Step 2 of the post-login restaurant wizard: at least one of these six rows must
// end up `connected` before the customer can move on. `permission` platforms
// (ubereats, doordash, chowbus, menusifu) are verified with a mock check for now;
// `api_key` platforms (toast, square) are considered connected once a key is saved.

export const restaurantPlatformConnections = pgTable("restaurant_platform_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
  platform: varchar("platform", { length: 20 }).notNull(), // ubereats | doordash | toast | square | chowbus | menusifu
  method: varchar("method", { length: 20 }).notNull(),     // permission | api_key
  apiKeyEncrypted: text("api_key_encrypted"),
  connected: boolean("connected").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("restaurant_platform_connections_restaurant_idx").on(t.restaurantId, t.platform),
]);

export type RestaurantPlatformConnection = typeof restaurantPlatformConnections.$inferSelect;
export type InsertRestaurantPlatformConnection = typeof restaurantPlatformConnections.$inferInsert;

// ─── Agent Packages (subscription bundles) ─────────────────────────────────────

export const agentPackages = pgTable("agent_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  priceCents: integer("price_cents").notNull().default(0),        // monthly price of the bundle
  monthlyTokenQuota: integer("monthly_token_quota").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAgentPackageSchema = createInsertSchema(agentPackages).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertAgentPackage = z.infer<typeof insertAgentPackageSchema>;
export type AgentPackage = typeof agentPackages.$inferSelect;

export const agentPackageItems = pgTable("agent_package_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  packageId: varchar("package_id").notNull().references(() => agentPackages.id, { onDelete: "cascade" }),
  agentId: varchar("agent_id").notNull().references(() => agentCatalog.id, { onDelete: "cascade" }),
}, (t) => [
  index("agent_package_items_package_idx").on(t.packageId),
]);

export type AgentPackageItem = typeof agentPackageItems.$inferSelect;

// ─── Customer Subscriptions ─────────────────────────────────────────────────────
// Assignable from System Admin, or self-serve via the Agent Market
// (POST /api/agent-market/purchase) for à la carte agents.

export const subscriptions = pgTable("subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  packageId: varchar("package_id").references(() => agentPackages.id, { onDelete: "set null" }),
  addonAgentIds: jsonb("addon_agent_ids").notNull().default(sql`'[]'::jsonb`).$type<string[]>(), // extra à la carte agent ids
  status: varchar("status", { length: 20 }).notNull().default("active"), // active | canceled
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type InsertSubscription = typeof subscriptions.$inferInsert;

// ─── Payment Records (mocked — no live payment gateway yet) ────────────────────

export const paymentRecords = pgTable("payment_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 30 }).notNull(),      // package_subscribe | addon_purchase | renewal
  packageId: varchar("package_id").references(() => agentPackages.id, { onDelete: "set null" }),
  agentId: varchar("agent_id").references(() => agentCatalog.id, { onDelete: "set null" }),
  amountCents: integer("amount_cents").notNull(),
  status: varchar("status", { length: 20 }).notNull(),  // initiated | succeeded | failed
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("payment_records_user_idx").on(t.userId),
]);

export type PaymentRecord = typeof paymentRecords.$inferSelect;
export type InsertPaymentRecord = typeof paymentRecords.$inferInsert;
