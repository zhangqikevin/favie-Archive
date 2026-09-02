/**
 * Resolves which agent_catalog products a user is actually entitled to, from
 * their subscription's package items plus any à-la-carte addon agents — both of
 * which point at agent_catalog rows (see shared/schema.ts). Any catalog key
 * sysadmin has bundled into the user's package/addons counts, not just the
 * original 7 tabs — see KNOWN_AGENT_IDS below for that distinction.
 */
import { storage } from "./storage";
import type { AgentCatalogEntry } from "@shared/schema";

/**
 * The original 7 Favie tabs, which still have bespoke marketing copy, task
 * menus, and chat UI hardcoded in client/src/pages/admin/agents.tsx. Any other
 * entitled catalog key renders through that file's generic fallback page
 * instead of the curated per-tab experience. Purely a UI distinction — it has
 * no bearing on entitlement itself.
 */
export const KNOWN_AGENT_IDS = ["operation", "chef", "social", "customer", "finance", "legal", "expert"] as const;
export type KnownAgentId = (typeof KNOWN_AGENT_IDS)[number];

const KNOWN_SET: ReadonlySet<string> = new Set(KNOWN_AGENT_IDS);

export function isKnownAgentId(value: string): value is KnownAgentId {
  return KNOWN_SET.has(value);
}

export interface EntitledSlot {
  slot: string;
  entry: AgentCatalogEntry;
}

export async function getEntitledSlots(userId: string): Promise<EntitledSlot[]> {
  const subscription = await storage.getSubscriptionByUser(userId);
  if (!subscription || subscription.status !== "active") return [];

  const catalogIds = new Set<string>(subscription.addonAgentIds ?? []);
  if (subscription.packageId) {
    const itemIds = await storage.getAgentPackageItemIds(subscription.packageId);
    for (const id of itemIds) catalogIds.add(id);
  }
  if (catalogIds.size === 0) return [];

  const entries = await Promise.all(
    Array.from(catalogIds).map((id) => storage.getAgentCatalogById(id)),
  );

  return entries
    .filter((entry): entry is AgentCatalogEntry => !!entry)
    .map((entry) => ({ slot: entry.key, entry }));
}

export async function getEntitledSlotKeys(userId: string): Promise<string[]> {
  return (await getEntitledSlots(userId)).map((s) => s.slot);
}

/** The entitled catalog entry for one slot, or undefined if the user doesn't own it. */
export async function getEntitledEntry(userId: string, slot: string): Promise<AgentCatalogEntry | undefined> {
  const slots = await getEntitledSlots(userId);
  return slots.find((s) => s.slot === slot)?.entry;
}
