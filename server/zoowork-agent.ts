/**
 * Each of the 7 Favie agent tabs (operation/chef/social/customer/finance/legal/
 * expert) is backed by its own agent_catalog row (sysadmin-defined, bundled into
 * subscription packages) and its own per-user ZooWork agent instance, synced via
 * server/zoowork-admin.ts. Which tabs a given user can actually talk to is
 * gated by their subscription — see server/agent-entitlements.ts.
 */
import { ZooworkError, assistantText, isRunFinished, runOutcome, toolCall } from "@zoowork-ai/sdk";
import { zc } from "./zoowork-client";
import { storage } from "./storage";
import { getEntitledEntry } from "./agent-entitlements";
import { syncUserAgentToZoowork } from "./zoowork-admin";
import type { AgentCatalogEntry } from "@shared/schema";

const CHAT_TIMEOUT_MS = 2 * 60 * 1000;

// Surfaced to the client so the chat UI can render tool activity the way
// Claude Code does — one line per call, collapsed by default. Start/end events
// for the same toolCallId are merged into a single step.
export interface ChatToolStep {
  toolName: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  resultPreview?: string;
}

export interface ChatResult {
  text: string;
  steps: ChatToolStep[];
}

export class NotEntitledError extends Error {
  constructor(slot: string) {
    super(`Not entitled to agent "${slot}"`);
    this.name = "NotEntitledError";
  }
}

// key: `${userId}:${slot}` -> ZooWork session id
const sessions = new Map<string, string>();
// key: `${userId}:${slot}` -> last-seen stream cursor for that session. streamEvents()
// replays a session's *entire* persistent event log from the start when called with no
// cursor — without this, every turn after the first would re-stream turn 1's events, hit
// turn 1's run.finished first, and return turn 1's answer again instead of the new turn's.
const cursors = new Map<string, string>();

/** User-initiated chat — requires the user's subscription to actually entitle them to `slot`. */
export async function chatWithAgentSlot(
  userId: string,
  slot: string,
  userMessage: string,
): Promise<ChatResult> {
  const catalogEntry = await getEntitledEntry(userId, slot);
  if (!catalogEntry) throw new NotEntitledError(slot);
  return chatWithCatalogEntry(userId, slot, catalogEntry, userMessage);
}

/**
 * System-triggered flows (e.g. the automated "Expert" onboarding greeting sent right after a
 * restaurant is created) run before a subscription necessarily exists, so they look up the
 * catalog entry directly by key rather than going through entitlement — unlike
 * chatWithAgentSlot, which gates ordinary user-initiated chat.
 */
export async function chatWithCatalogKeyUnchecked(
  userId: string,
  key: string,
  userMessage: string,
): Promise<ChatResult> {
  const catalogEntry = await storage.getAgentCatalogByKey(key);
  if (!catalogEntry) throw new Error(`No agent_catalog entry for key "${key}"`);
  return chatWithCatalogEntry(userId, key, catalogEntry, userMessage);
}

async function chatWithCatalogEntry(
  userId: string,
  sessionSlot: string,
  catalogEntry: AgentCatalogEntry,
  userMessage: string,
): Promise<ChatResult> {
  const agentId = await syncUserAgentToZoowork(userId, catalogEntry);

  const key = `${userId}:${sessionSlot}`;
  let sessionId = sessions.get(key);

  if (!sessionId) {
    const session = await zc.createSession(agentId, {
      initial_events: [{ type: "user.message", content: userMessage }],
    });
    sessionId = session.session_id;
    sessions.set(key, sessionId);
  } else {
    await zc.postEvents(agentId, sessionId, [{ type: "user.message", content: userMessage }]);
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHAT_TIMEOUT_MS);
  let cursor = cursors.get(key);
  try {
    let text = "";
    // toolCallId -> in-progress step; 'start' seeds it (toolName, args), 'end'
    // fills in the outcome. Order of completion (not of the 'start' events) is
    // what the UI sees, which matches how Claude Code lists finished calls.
    const stepsById = new Map<string, ChatToolStep>();
    const stepOrder: string[] = [];
    for await (const ev of zc.streamEvents(agentId, sessionId, cursor ? { cursor, signal: ctl.signal } : { signal: ctl.signal })) {
      cursor = ev.cursor ?? cursor;
      text += assistantText(ev);
      const call = toolCall(ev);
      if (call) {
        if (call.phase === "start") {
          stepsById.set(call.toolCallId, { toolName: call.toolName, args: call.args });
          stepOrder.push(call.toolCallId);
        } else if (call.phase === "end") {
          const existing = stepsById.get(call.toolCallId) ?? { toolName: call.toolName };
          stepsById.set(call.toolCallId, { ...existing, isError: call.isError, resultPreview: call.resultPreview });
        }
      }
      if (isRunFinished(ev)) {
        const outcome = runOutcome(ev);
        if (outcome !== "succeeded") throw new Error(`zoowork run ${outcome}`);
        break;
      }
    }
    const steps = stepOrder.map((id) => stepsById.get(id)!).filter(Boolean);
    return { text, steps };
  } catch (err) {
    if (err instanceof ZooworkError) {
      throw new Error(`ZooWork error ${err.status} ${err.type ?? ""}: ${err.message}`);
    }
    throw err;
  } finally {
    if (cursor) cursors.set(key, cursor);
    clearTimeout(timer);
  }
}
