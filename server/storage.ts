import { drizzle } from "drizzle-orm/node-postgres";
import { eq, desc, asc, and, gte, sql } from "drizzle-orm";
import pg from "pg";
import { randomBytes } from "crypto";
import {
  users, type User, type InsertUser,
  uberEatsConnections, type UberEatsConnection, type InsertUberEatsConnection,
  restaurants, type Restaurant, type InsertRestaurant,
  taskDefinitions, type TaskDefinition, type InsertTaskDefinition,
  taskRuns, type TaskRun, type InsertTaskRun,
  chatMessages, type ChatMessage, type InsertChatMessage,
  systemConfig,
  userOpenclawSettings, type UserOpenclawSettings,
  adminUsers, type AdminUser,
  agentCatalog, type AgentCatalogEntry, type InsertAgentCatalog,
  agentPackages, type AgentPackage, type InsertAgentPackage,
  agentPackageItems,
  subscriptions, type Subscription,
  paymentRecords, type PaymentRecord, type InsertPaymentRecord,
  userAgentInstances, type UserAgentInstance,
  mcpServers, type McpServer, type InsertMcpServer,
  agentMcpBindings,
  userMcpCredentials, type UserMcpCredential,
  restaurantPlatformConnections, type RestaurantPlatformConnection,
} from "@shared/schema";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserPlan(id: string, planId: string): Promise<User>;
  updateUserCurrentRestaurant(id: string, restaurantId: string): Promise<User>;
  getUberEatsConnection(userId: string): Promise<UberEatsConnection | undefined>;
  saveUberEatsConnection(data: InsertUberEatsConnection): Promise<UberEatsConnection>;
  updateUberEatsConnection(userId: string, updates: Partial<UberEatsConnection>): Promise<void>;
  getRestaurants(userId: string): Promise<Restaurant[]>;
  createRestaurant(data: InsertRestaurant): Promise<Restaurant>;
  deleteRestaurant(id: string, userId: string): Promise<void>;
  seedTaskDefinitions(tasks: InsertTaskDefinition[]): Promise<void>;
  getTaskDefinitions(): Promise<TaskDefinition[]>;
  createTaskRun(data: InsertTaskRun): Promise<TaskRun>;
  getTaskRuns(userId: string): Promise<(TaskRun & { task: TaskDefinition | null })[]>;
  getChatHistory(userId: string, agentId: string, limit?: number, beforeId?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }>;
  saveChatMessage(data: InsertChatMessage): Promise<ChatMessage>;
  saveChatMessages(data: InsertChatMessage[]): Promise<void>;
  clearChatHistory(userId: string, agentId: string): Promise<void>;
  deleteChatMessage(userId: string, agentId: string, messageId: number): Promise<boolean>;
  getSystemConfig(): Promise<Record<string, string>>;
  setSystemConfig(updates: Record<string, string>): Promise<void>;
  getUserOpenclawSettings(userId: string): Promise<UserOpenclawSettings | undefined>;
  setUserOpenclawSettings(userId: string, updates: { baseUrl?: string | null; apiKey?: string | null }): Promise<void>;
  getAllUsers(): Promise<User[]>;
  getAllChatHistorySince(userId: string, since: Date): Promise<ChatMessage[]>;

  // ── System Admin ──
  getAdminByEmail(email: string): Promise<AdminUser | undefined>;
  getAdminById(id: string): Promise<AdminUser | undefined>;
  countAdminUsers(): Promise<number>;
  createAdminUser(data: { email: string; password: string }): Promise<AdminUser>;

  listAgentCatalog(): Promise<AgentCatalogEntry[]>;
  getAgentCatalogById(id: string): Promise<AgentCatalogEntry | undefined>;
  getAgentCatalogByKey(key: string): Promise<AgentCatalogEntry | undefined>;
  createAgentCatalogEntry(data: InsertAgentCatalog): Promise<AgentCatalogEntry>;
  updateAgentCatalogEntry(id: string, patch: Partial<InsertAgentCatalog>): Promise<AgentCatalogEntry>;
  deleteAgentCatalogEntry(id: string): Promise<void>;

  listAgentPackages(): Promise<AgentPackage[]>;
  getAgentPackage(id: string): Promise<AgentPackage | undefined>;
  createAgentPackage(data: InsertAgentPackage): Promise<AgentPackage>;
  updateAgentPackage(id: string, patch: Partial<InsertAgentPackage>): Promise<AgentPackage>;
  deleteAgentPackage(id: string): Promise<void>;
  getAgentPackageItemIds(packageId: string): Promise<string[]>;
  setAgentPackageItems(packageId: string, agentIds: string[]): Promise<void>;

  getSubscriptionByUser(userId: string): Promise<Subscription | undefined>;
  upsertSubscription(userId: string, data: { packageId: string | null; addonAgentIds: string[]; status: string }): Promise<Subscription>;

  createPaymentRecord(data: InsertPaymentRecord): Promise<PaymentRecord>;
  listPaymentRecords(opts?: { userId?: string; limit?: number }): Promise<PaymentRecord[]>;

  getUserAgentInstance(userId: string, agentCatalogId: string): Promise<UserAgentInstance | undefined>;
  upsertUserAgentInstanceSync(userId: string, agentCatalogId: string, zooworkAgentId: string, syncedHash: string): Promise<void>;

  listMcpServers(): Promise<McpServer[]>;
  getMcpServer(id: string): Promise<McpServer | undefined>;
  createMcpServer(data: InsertMcpServer): Promise<McpServer>;
  updateMcpServer(id: string, patch: Partial<InsertMcpServer>): Promise<McpServer>;
  deleteMcpServer(id: string): Promise<void>;

  getAgentMcpServerIds(agentCatalogId: string): Promise<string[]>;
  setAgentMcpBindings(agentCatalogId: string, mcpServerIds: string[]): Promise<void>;
  getMcpServersForAgent(agentCatalogId: string): Promise<McpServer[]>;

  getUserMcpCredential(userId: string, mcpServerId: string): Promise<UserMcpCredential | undefined>;
  getUserMcpCredentialByToken(proxyToken: string): Promise<UserMcpCredential | undefined>;
  listUserMcpCredentials(userId: string): Promise<UserMcpCredential[]>;
  upsertUserMcpCredential(userId: string, mcpServerId: string, encryptedKey: string): Promise<UserMcpCredential>;
  deleteUserMcpCredential(userId: string, mcpServerId: string): Promise<void>;

  listRestaurantPlatformConnections(restaurantId: string): Promise<RestaurantPlatformConnection[]>;
  upsertRestaurantPlatformConnection(
    restaurantId: string,
    platform: string,
    patch: { method: string; apiKeyEncrypted?: string | null; connected: boolean },
  ): Promise<RestaurantPlatformConnection>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values({ ...insertUser, email: insertUser.email.toLowerCase() })
      .returning();
    return user;
  }

  async updateUserPlan(id: string, planId: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ selectedPlan: planId })
      .where(eq(users.id, id))
      .returning();
    if (!user) throw new Error("User not found");
    return user;
  }

  async updateUserCurrentRestaurant(id: string, restaurantId: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ currentRestaurantId: restaurantId })
      .where(eq(users.id, id))
      .returning();
    if (!user) throw new Error("User not found");
    return user;
  }

  async getUberEatsConnection(userId: string): Promise<UberEatsConnection | undefined> {
    const [conn] = await db
      .select()
      .from(uberEatsConnections)
      .where(eq(uberEatsConnections.userId, userId));
    return conn;
  }

  async saveUberEatsConnection(data: InsertUberEatsConnection): Promise<UberEatsConnection> {
    const existing = await this.getUberEatsConnection(data.userId);
    if (existing) {
      const [updated] = await db
        .update(uberEatsConnections)
        .set(data)
        .where(eq(uberEatsConnections.userId, data.userId))
        .returning();
      return updated;
    }
    const [created] = await db
      .insert(uberEatsConnections)
      .values(data)
      .returning();
    return created;
  }

  async updateUberEatsConnection(userId: string, updates: Partial<UberEatsConnection>): Promise<void> {
    await db
      .update(uberEatsConnections)
      .set(updates)
      .where(eq(uberEatsConnections.userId, userId));
  }

  async getRestaurants(userId: string): Promise<Restaurant[]> {
    return db
      .select()
      .from(restaurants)
      .where(eq(restaurants.userId, userId))
      .orderBy(restaurants.createdAt);
  }

  async createRestaurant(data: InsertRestaurant): Promise<Restaurant> {
    const [restaurant] = await db
      .insert(restaurants)
      .values(data)
      .returning();
    return restaurant;
  }

  async deleteRestaurant(id: string, userId: string): Promise<void> {
    await db
      .delete(restaurants)
      .where(eq(restaurants.id, id));
  }

  async seedTaskDefinitions(tasks: InsertTaskDefinition[]): Promise<void> {
    for (const task of tasks) {
      await db
        .insert(taskDefinitions)
        .values(task)
        .onConflictDoUpdate({
          target: taskDefinitions.id,
          set: {
            title: task.title,
            category: task.category,
            price: task.price,
            shortDesc: task.shortDesc,
            agentId: task.agentId,
          },
        });
    }
  }

  async getTaskDefinitions(): Promise<TaskDefinition[]> {
    return db.select().from(taskDefinitions);
  }

  async createTaskRun(data: InsertTaskRun): Promise<TaskRun> {
    const [run] = await db.insert(taskRuns).values(data).returning();
    return run;
  }

  async getTaskRuns(userId: string): Promise<(TaskRun & { task: TaskDefinition | null })[]> {
    const runs = await db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.userId, userId))
      .orderBy(desc(taskRuns.createdAt));

    const taskIds = [...new Set(runs.map((r) => r.taskId))];
    const defs = taskIds.length
      ? await db.select().from(taskDefinitions).where(
          taskIds.length === 1
            ? eq(taskDefinitions.id, taskIds[0])
            : taskDefinitions.id.in(taskIds)
        )
      : [];
    const defMap = Object.fromEntries(defs.map((d) => [d.id, d]));
    return runs.map((r) => ({ ...r, task: defMap[r.taskId] ?? null }));
  }

  // Cutoff: hide all messages before 2026-04-17 00:00:00 PDT (= 2026-04-17 07:00:00 UTC)
  private static readonly CHAT_CUTOFF = new Date("2026-04-17T07:00:00Z");

  async getChatHistory(userId: string, agentId: string, limit = 20, beforeId?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const conditions = [
      eq(chatMessages.userId, userId),
      eq(chatMessages.agentId, agentId),
      gte(chatMessages.createdAt, DatabaseStorage.CHAT_CUTOFF),
    ];
    if (beforeId) {
      conditions.push(sql`${chatMessages.id} < ${beforeId}`);
    }
    // Fetch limit+1 to detect hasMore, ordered DESC to get latest first
    const rows = await db
      .select()
      .from(chatMessages)
      .where(and(...conditions))
      .orderBy(desc(chatMessages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Return in chronological order (ASC)
    page.reverse();
    return { messages: page, hasMore };
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async getAllChatHistorySince(userId: string, since: Date): Promise<ChatMessage[]> {
    return db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.userId, userId), gte(chatMessages.createdAt, since)))
      .orderBy(chatMessages.id);
  }

  async saveChatMessage(data: InsertChatMessage): Promise<ChatMessage> {
    const [msg] = await db.insert(chatMessages).values(data).returning();
    return msg;
  }

  async saveChatMessages(data: InsertChatMessage[]): Promise<void> {
    if (!data.length) return;
    await db.insert(chatMessages).values(data);
  }

  async clearChatHistory(userId: string, agentId: string): Promise<void> {
    await db
      .delete(chatMessages)
      .where(and(eq(chatMessages.userId, userId), eq(chatMessages.agentId, agentId)));
  }

  async deleteChatMessage(userId: string, agentId: string, messageId: number): Promise<boolean> {
    const result = await db
      .delete(chatMessages)
      .where(and(
        eq(chatMessages.id, messageId),
        eq(chatMessages.userId, userId),
        eq(chatMessages.agentId, agentId),
      ))
      .returning({ id: chatMessages.id });
    return result.length > 0;
  }

  async getSystemConfig(): Promise<Record<string, string>> {
    const rows = await db.select().from(systemConfig);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setSystemConfig(updates: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(updates)) {
      await db
        .insert(systemConfig)
        .values({ key, value })
        .onConflictDoUpdate({ target: systemConfig.key, set: { value, updatedAt: new Date() } });
    }
  }

  async getUserOpenclawSettings(userId: string): Promise<UserOpenclawSettings | undefined> {
    const [row] = await db.select().from(userOpenclawSettings).where(eq(userOpenclawSettings.userId, userId));
    return row;
  }

  async setUserOpenclawSettings(
    userId: string,
    updates: { baseUrl?: string | null; apiKey?: string | null },
  ): Promise<void> {
    const existing = await this.getUserOpenclawSettings(userId);
    const next = {
      baseUrl: updates.baseUrl !== undefined ? updates.baseUrl : (existing?.baseUrl ?? null),
      apiKey:  updates.apiKey  !== undefined ? updates.apiKey  : (existing?.apiKey  ?? null),
    };
    if (existing) {
      await db.update(userOpenclawSettings)
        .set({ baseUrl: next.baseUrl, apiKey: next.apiKey, updatedAt: new Date() })
        .where(eq(userOpenclawSettings.userId, userId));
    } else {
      await db.insert(userOpenclawSettings).values({
        userId,
        baseUrl: next.baseUrl,
        apiKey: next.apiKey,
      });
    }
  }

  // ── System Admin ──────────────────────────────────────────────────────────

  async getAdminByEmail(email: string): Promise<AdminUser | undefined> {
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
    return row;
  }

  async getAdminById(id: string): Promise<AdminUser | undefined> {
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, id));
    return row;
  }

  async countAdminUsers(): Promise<number> {
    const rows = await db.select().from(adminUsers);
    return rows.length;
  }

  async createAdminUser(data: { email: string; password: string }): Promise<AdminUser> {
    const [row] = await db.insert(adminUsers).values(data).returning();
    return row;
  }

  async listAgentCatalog(): Promise<AgentCatalogEntry[]> {
    return db.select().from(agentCatalog).orderBy(asc(agentCatalog.createdAt));
  }

  async getAgentCatalogById(id: string): Promise<AgentCatalogEntry | undefined> {
    const [row] = await db.select().from(agentCatalog).where(eq(agentCatalog.id, id));
    return row;
  }

  async getAgentCatalogByKey(key: string): Promise<AgentCatalogEntry | undefined> {
    const [row] = await db.select().from(agentCatalog).where(eq(agentCatalog.key, key));
    return row;
  }

  async createAgentCatalogEntry(data: InsertAgentCatalog): Promise<AgentCatalogEntry> {
    const [row] = await db.insert(agentCatalog).values(data).returning();
    return row;
  }

  async updateAgentCatalogEntry(id: string, patch: Partial<InsertAgentCatalog>): Promise<AgentCatalogEntry> {
    const [row] = await db
      .update(agentCatalog)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentCatalog.id, id))
      .returning();
    return row;
  }

  async deleteAgentCatalogEntry(id: string): Promise<void> {
    await db.delete(agentCatalog).where(eq(agentCatalog.id, id));
  }

  async listAgentPackages(): Promise<AgentPackage[]> {
    return db.select().from(agentPackages).orderBy(asc(agentPackages.createdAt));
  }

  async getAgentPackage(id: string): Promise<AgentPackage | undefined> {
    const [row] = await db.select().from(agentPackages).where(eq(agentPackages.id, id));
    return row;
  }

  async createAgentPackage(data: InsertAgentPackage): Promise<AgentPackage> {
    const [row] = await db.insert(agentPackages).values(data).returning();
    return row;
  }

  async updateAgentPackage(id: string, patch: Partial<InsertAgentPackage>): Promise<AgentPackage> {
    const [row] = await db
      .update(agentPackages)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentPackages.id, id))
      .returning();
    return row;
  }

  async deleteAgentPackage(id: string): Promise<void> {
    await db.delete(agentPackages).where(eq(agentPackages.id, id));
  }

  async getAgentPackageItemIds(packageId: string): Promise<string[]> {
    const rows = await db
      .select()
      .from(agentPackageItems)
      .where(eq(agentPackageItems.packageId, packageId));
    return rows.map((r) => r.agentId);
  }

  async setAgentPackageItems(packageId: string, agentIds: string[]): Promise<void> {
    await db.delete(agentPackageItems).where(eq(agentPackageItems.packageId, packageId));
    if (agentIds.length > 0) {
      await db.insert(agentPackageItems).values(agentIds.map((agentId) => ({ packageId, agentId })));
    }
  }

  async getSubscriptionByUser(userId: string): Promise<Subscription | undefined> {
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    return row;
  }

  async upsertSubscription(
    userId: string,
    data: { packageId: string | null; addonAgentIds: string[]; status: string },
  ): Promise<Subscription> {
    const existing = await this.getSubscriptionByUser(userId);
    if (existing) {
      const [row] = await db
        .update(subscriptions)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(subscriptions.userId, userId))
        .returning();
      return row;
    }
    const [row] = await db.insert(subscriptions).values({ userId, ...data }).returning();
    return row;
  }

  async createPaymentRecord(data: InsertPaymentRecord): Promise<PaymentRecord> {
    const [row] = await db.insert(paymentRecords).values(data).returning();
    return row;
  }

  async listPaymentRecords(opts?: { userId?: string; limit?: number }): Promise<PaymentRecord[]> {
    const conditions = opts?.userId ? [eq(paymentRecords.userId, opts.userId)] : [];
    const q = db.select().from(paymentRecords)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(paymentRecords.createdAt));
    return opts?.limit ? q.limit(opts.limit) : q;
  }

  async getUserAgentInstance(userId: string, agentCatalogId: string): Promise<UserAgentInstance | undefined> {
    const [row] = await db
      .select()
      .from(userAgentInstances)
      .where(and(eq(userAgentInstances.userId, userId), eq(userAgentInstances.agentCatalogId, agentCatalogId)));
    return row;
  }

  async upsertUserAgentInstanceSync(userId: string, agentCatalogId: string, zooworkAgentId: string, syncedHash: string): Promise<void> {
    const existing = await this.getUserAgentInstance(userId, agentCatalogId);
    if (existing) {
      await db
        .update(userAgentInstances)
        .set({ zooworkAgentId, syncedHash, updatedAt: new Date() })
        .where(eq(userAgentInstances.id, existing.id));
      return;
    }
    await db.insert(userAgentInstances).values({ userId, agentCatalogId, zooworkAgentId, syncedHash });
  }

  async listMcpServers(): Promise<McpServer[]> {
    return db.select().from(mcpServers).orderBy(asc(mcpServers.createdAt));
  }

  async getMcpServer(id: string): Promise<McpServer | undefined> {
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
    return row;
  }

  async createMcpServer(data: InsertMcpServer): Promise<McpServer> {
    const [row] = await db.insert(mcpServers).values(data).returning();
    return row;
  }

  async updateMcpServer(id: string, patch: Partial<InsertMcpServer>): Promise<McpServer> {
    const [row] = await db
      .update(mcpServers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(mcpServers.id, id))
      .returning();
    return row;
  }

  async deleteMcpServer(id: string): Promise<void> {
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
  }

  async getAgentMcpServerIds(agentCatalogId: string): Promise<string[]> {
    const rows = await db.select().from(agentMcpBindings).where(eq(agentMcpBindings.agentCatalogId, agentCatalogId));
    return rows.map((r) => r.mcpServerId);
  }

  async setAgentMcpBindings(agentCatalogId: string, mcpServerIds: string[]): Promise<void> {
    await db.delete(agentMcpBindings).where(eq(agentMcpBindings.agentCatalogId, agentCatalogId));
    if (mcpServerIds.length > 0) {
      await db.insert(agentMcpBindings).values(mcpServerIds.map((mcpServerId) => ({ agentCatalogId, mcpServerId })));
    }
  }

  async getMcpServersForAgent(agentCatalogId: string): Promise<McpServer[]> {
    const ids = await this.getAgentMcpServerIds(agentCatalogId);
    if (ids.length === 0) return [];
    const all = await this.listMcpServers();
    const idSet = new Set(ids);
    return all.filter((s) => idSet.has(s.id));
  }

  async getUserMcpCredential(userId: string, mcpServerId: string): Promise<UserMcpCredential | undefined> {
    const [row] = await db
      .select()
      .from(userMcpCredentials)
      .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.mcpServerId, mcpServerId)));
    return row;
  }

  async getUserMcpCredentialByToken(proxyToken: string): Promise<UserMcpCredential | undefined> {
    const [row] = await db.select().from(userMcpCredentials).where(eq(userMcpCredentials.proxyToken, proxyToken));
    return row;
  }

  async listUserMcpCredentials(userId: string): Promise<UserMcpCredential[]> {
    return db.select().from(userMcpCredentials).where(eq(userMcpCredentials.userId, userId));
  }

  async upsertUserMcpCredential(userId: string, mcpServerId: string, encryptedKey: string): Promise<UserMcpCredential> {
    const existing = await this.getUserMcpCredential(userId, mcpServerId);
    if (existing) {
      const [row] = await db
        .update(userMcpCredentials)
        .set({ encryptedKey, updatedAt: new Date() })
        .where(eq(userMcpCredentials.id, existing.id))
        .returning();
      return row;
    }
    const proxyToken = randomBytes(24).toString("hex");
    const [row] = await db
      .insert(userMcpCredentials)
      .values({ userId, mcpServerId, proxyToken, encryptedKey })
      .returning();
    return row;
  }

  async deleteUserMcpCredential(userId: string, mcpServerId: string): Promise<void> {
    await db
      .delete(userMcpCredentials)
      .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.mcpServerId, mcpServerId)));
  }

  async listRestaurantPlatformConnections(restaurantId: string): Promise<RestaurantPlatformConnection[]> {
    return db
      .select()
      .from(restaurantPlatformConnections)
      .where(eq(restaurantPlatformConnections.restaurantId, restaurantId));
  }

  async upsertRestaurantPlatformConnection(
    restaurantId: string,
    platform: string,
    patch: { method: string; apiKeyEncrypted?: string | null; connected: boolean },
  ): Promise<RestaurantPlatformConnection> {
    const [existing] = await db
      .select()
      .from(restaurantPlatformConnections)
      .where(and(
        eq(restaurantPlatformConnections.restaurantId, restaurantId),
        eq(restaurantPlatformConnections.platform, platform),
      ));
    if (existing) {
      const [row] = await db
        .update(restaurantPlatformConnections)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(restaurantPlatformConnections.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db
      .insert(restaurantPlatformConnections)
      .values({ restaurantId, platform, ...patch })
      .returning();
    return row;
  }
}

export const storage = new DatabaseStorage();
