/**
 * Thin wrapper around the bits of the Composio REST API the OAuth-style
 * "Connectors" flow needs: start a hosted connection (connected_accounts/link)
 * and check on one already in flight. Each mcpServers row using authStyle
 * "query_param_shared_key" carries its own encryptedAdminKey — that's the
 * project-wide Composio key these calls authenticate with.
 */
const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3";

async function composioFetch(apiKey: string, path: string, init?: RequestInit) {
  const res = await fetch(`${COMPOSIO_BASE_URL}${path}`, {
    ...init,
    headers: { "x-api-key": apiKey, "content-type": "application/json", ...init?.headers },
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Composio API ${path} failed: ${res.status} ${raw}`);
  }
  return raw ? JSON.parse(raw) : undefined;
}

export interface ComposioLinkResult {
  redirectUrl: string;
  connectedAccountId: string;
  expiresAt: string;
}

export async function startComposioConnection(
  apiKey: string,
  authConfigId: string,
  userId: string,
  callbackUrl: string,
): Promise<ComposioLinkResult> {
  const data = await composioFetch(apiKey, "/connected_accounts/link", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, auth_config_id: authConfigId, callback_url: callbackUrl }),
  });
  return { redirectUrl: data.redirect_url, connectedAccountId: data.connected_account_id, expiresAt: data.expires_at };
}

/** Most recent connected account for this (userId, authConfigId) pair, if any. */
export async function findComposioConnection(
  apiKey: string,
  authConfigId: string,
  userId: string,
): Promise<{ id: string; status: string } | undefined> {
  const data = await composioFetch(
    apiKey,
    `/connected_accounts?user_ids=${encodeURIComponent(userId)}&auth_config_ids=${encodeURIComponent(authConfigId)}`,
  );
  const items = (data.items ?? []) as { id: string; status: string; updated_at: string }[];
  if (items.length === 0) return undefined;
  return items.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

/**
 * Deletes the connected account at Composio (and asks it to revoke the upstream OAuth
 * grant too). Without this, "Disconnect" only removes our own local credential row —
 * findComposioConnection would still see the same connection ACTIVE on Composio's side
 * and the self-heal in GET /api/mcp/available would silently recreate it right away.
 */
export async function deleteComposioConnection(apiKey: string, connectedAccountId: string): Promise<void> {
  await composioFetch(apiKey, `/connected_accounts/${encodeURIComponent(connectedAccountId)}?revoke_on_delete=true`, {
    method: "DELETE",
  });
}
