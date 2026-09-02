/**
 * ZooWork native channel binding (feishu / slack / wecom / weixin), scoped to one
 * of the 7 agent tabs. Each tab already has its own ZooWork agent instance (see
 * server/agent-entitlements.ts, server/zoowork-admin.ts) — a channel binds to
 * that agent directly via the SDK, and ZooWork itself owns the conversation on
 * that platform from then on (no webhook, nothing for us to store beyond what
 * `listChannels` already reports live).
 *
 * App-level policy (not an SDK constraint): only one platform may be bound to a
 * given agent at a time. The SDK itself would happily let feishu + slack + wecom
 * all sit on the same agent — we reject a second platform here and ask the
 * caller to remove the existing one first.
 */
import { ZooworkError } from "@zoowork-ai/sdk";
import type { AgentChannel, ChannelPollResult, ChannelSetupSession } from "@zoowork-ai/sdk";
import { zc } from "./zoowork-client";
import { getEntitledEntry } from "./agent-entitlements";
import { syncUserAgentToZoowork } from "./zoowork-admin";

export const GUIDED_SETUP_PLATFORMS = ["feishu", "wecom", "weixin"] as const;
export type GuidedSetupPlatform = (typeof GUIDED_SETUP_PLATFORMS)[number];

export const EXPLICIT_CONFIG_PLATFORMS = ["slack"] as const;
export type ExplicitConfigPlatform = (typeof EXPLICIT_CONFIG_PLATFORMS)[number];

export class ChannelApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChannelApiError";
    this.status = status;
  }
}

function isGuidedSetupPlatform(p: string): p is GuidedSetupPlatform {
  return (GUIDED_SETUP_PLATFORMS as readonly string[]).includes(p);
}

function isExplicitConfigPlatform(p: string): p is ExplicitConfigPlatform {
  return (EXPLICIT_CONFIG_PLATFORMS as readonly string[]).includes(p);
}

/** Translate a raw ZooworkError into a clean, user-facing {status, message} pair. */
function mapZooworkError(err: unknown): ChannelApiError {
  if (err instanceof ZooworkError) {
    switch (err.type) {
      case "channel.conflict":
        return new ChannelApiError(409, "This account is already connected to another agent — disconnect it there first, or choose a different account.");
      case "channel.pairing_unsupported":
        return new ChannelApiError(400, "This platform does not support pairing mode here.");
      case "channel.weixin_setup_required":
        return new ChannelApiError(400, "WeChat can only be connected via the QR scan flow.");
      case "channel.allowlist_unsupported":
        return new ChannelApiError(400, "This platform does not support an allowlist reachability policy.");
      case "channel.invalid_request":
        return new ChannelApiError(400, "Invalid channel request.");
      case "channel.not_found":
        return new ChannelApiError(404, "No such channel binding.");
      case "not_found":
        return new ChannelApiError(503, "Channel binding isn't available on this deployment yet.");
      default:
        if (typeof err.type === "string" && err.type.endsWith("_session_not_found")) {
          return new ChannelApiError(404, "This setup session has expired or was cancelled — start again.");
        }
        return new ChannelApiError(err.status || 500, err.message);
    }
  }
  return new ChannelApiError(500, err instanceof Error ? err.message : String(err));
}

async function resolveAgentId(userId: string, slot: string): Promise<string> {
  const entry = await getEntitledEntry(userId, slot);
  if (!entry) throw new ChannelApiError(403, `Not entitled to agent "${slot}"`);
  return syncUserAgentToZoowork(userId, entry);
}

/**
 * The channel `account` name for this agent's bindings. Per the SDK's own guidance, an agent id
 * is a good default: it matches the required `^[a-z0-9][a-z0-9_-]{0,63}$` pattern and is unique
 * per agent by construction, so no separate naming table is needed.
 */
function accountFor(zooworkAgentId: string): string {
  return zooworkAgentId;
}

function assertNoOtherPlatformBound(channels: AgentChannel[], platform: string) {
  const other = channels.find((c) => c.platform !== platform && c.enabled !== false);
  if (other) {
    throw new ChannelApiError(
      409,
      `${other.platform} is already connected to this agent — disconnect it before connecting ${platform}.`,
    );
  }
}

export async function listChannels(userId: string, slot: string): Promise<AgentChannel[]> {
  const agentId = await resolveAgentId(userId, slot);
  try {
    return await zc.listChannels(agentId);
  } catch (err) {
    throw mapZooworkError(err);
  }
}

export async function startSetup(
  userId: string,
  slot: string,
  platform: string,
  opts: { brand?: "feishu" | "lark"; dm_policy?: string; group_policy?: string } = {},
): Promise<ChannelSetupSession> {
  if (!isGuidedSetupPlatform(platform)) {
    throw new ChannelApiError(400, `"${platform}" does not support the QR setup flow.`);
  }
  const agentId = await resolveAgentId(userId, slot);
  try {
    const channels = await zc.listChannels(agentId);
    assertNoOtherPlatformBound(channels, platform);
    return await zc.startChannelSetup(agentId, platform, {
      account: accountFor(agentId),
      ...opts,
    });
  } catch (err) {
    throw err instanceof ChannelApiError ? err : mapZooworkError(err);
  }
}

export async function pollSetup(
  userId: string,
  slot: string,
  platform: string,
  sessionId: string,
): Promise<ChannelPollResult> {
  if (!isGuidedSetupPlatform(platform)) {
    throw new ChannelApiError(400, `"${platform}" does not support the QR setup flow.`);
  }
  const agentId = await resolveAgentId(userId, slot);
  try {
    return await zc.pollChannelSetup(agentId, platform, sessionId);
  } catch (err) {
    throw mapZooworkError(err);
  }
}

export async function cancelSetup(
  userId: string,
  slot: string,
  platform: string,
  sessionId: string,
): Promise<void> {
  if (!isGuidedSetupPlatform(platform)) {
    throw new ChannelApiError(400, `"${platform}" does not support the QR setup flow.`);
  }
  const agentId = await resolveAgentId(userId, slot);
  try {
    await zc.cancelChannelSetup(agentId, platform, sessionId);
  } catch (err) {
    throw mapZooworkError(err);
  }
}

export async function addChannelExplicit(
  userId: string,
  slot: string,
  platform: string,
  config: Record<string, unknown>,
): Promise<AgentChannel> {
  if (!isExplicitConfigPlatform(platform)) {
    throw new ChannelApiError(400, `"${platform}" must be connected via the QR setup flow, not explicit config.`);
  }
  const agentId = await resolveAgentId(userId, slot);
  try {
    const channels = await zc.listChannels(agentId);
    assertNoOtherPlatformBound(channels, platform);
    return await zc.addChannel(agentId, { platform, account: accountFor(agentId), config });
  } catch (err) {
    throw err instanceof ChannelApiError ? err : mapZooworkError(err);
  }
}

export async function updateChannel(
  userId: string,
  slot: string,
  platform: string,
  patch: { enabled?: boolean; dm_policy?: string; group_policy?: string },
): Promise<AgentChannel> {
  const agentId = await resolveAgentId(userId, slot);
  try {
    return await zc.updateChannel(agentId, platform, { account: accountFor(agentId), ...patch });
  } catch (err) {
    throw mapZooworkError(err);
  }
}

export async function removeChannel(userId: string, slot: string, platform: string): Promise<void> {
  const agentId = await resolveAgentId(userId, slot);
  try {
    await zc.removeChannel(agentId, platform, { account: accountFor(agentId) });
  } catch (err) {
    throw mapZooworkError(err);
  }
}
