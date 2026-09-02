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
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Composio API ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
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
): Promise<{ status: string } | undefined> {
  const data = await composioFetch(
    apiKey,
    `/connected_accounts?user_ids=${encodeURIComponent(userId)}&auth_config_ids=${encodeURIComponent(authConfigId)}`,
  );
  const items = (data.items ?? []) as { status: string; updated_at: string }[];
  if (items.length === 0) return undefined;
  return items.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}
