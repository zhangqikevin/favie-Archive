/**
 * Resolves which of the 7 fixed agent tabs a user is actually entitled to, from
 * their subscription's package items plus any à-la-carte addon agents — both of
 * which point at `agent_catalog` rows (see shared/schema.ts).
 *
 * A catalog row only backs a live tab if its `key` matches one of AGENT_SLOTS;
 * anything else (e.g. a catalog row sysadmin hasn't wired to a tab yet) is
 * ignored here rather than erroring, since agent_catalog can hold rows that
 * aren't meant to be chat tabs at all.
 */
import { storage } from "./storage";
import type { AgentCatalogEntry } from "@shared/schema";

export const AGENT_SLOTS = ["operation", "chef", "social", "customer", "finance", "legal", "expert"] as const;
export type AgentSlot = (typeof AGENT_SLOTS)[number];

const SLOT_SET: ReadonlySet<string> = new Set(AGENT_SLOTS);

export function isAgentSlot(value: string): value is AgentSlot {
  return SLOT_SET.has(value);
}

export interface EntitledSlot {
  slot: AgentSlot;
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

  const slots: EntitledSlot[] = [];
  for (const entry of entries) {
    if (entry && isAgentSlot(entry.key)) slots.push({ slot: entry.key, entry });
  }
  return slots;
}

export async function getEntitledSlotKeys(userId: string): Promise<AgentSlot[]> {
  return (await getEntitledSlots(userId)).map((s) => s.slot);
}

/** The entitled catalog entry for one slot, or undefined if the user doesn't own it. */
export async function getEntitledEntry(userId: string, slot: string): Promise<AgentCatalogEntry | undefined> {
  if (!isAgentSlot(slot)) return undefined;
  const slots = await getEntitledSlots(userId);
  return slots.find((s) => s.slot === slot)?.entry;
}
