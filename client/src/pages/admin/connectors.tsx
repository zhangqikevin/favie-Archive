import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Loader2 } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";

interface McpServerAvailable {
  id: string;
  key: string;
  name: string;
  description: string | null;
  authStyle: "header_secret" | "query_param_shared_key";
  connected: boolean;
  pending: boolean;
}

export default function AdminConnectors() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiKeyDraftId, setApiKeyDraftId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");

  const { data, isLoading } = useQuery<{ mcpServers: McpServerAvailable[] }>({
    queryKey: ["/api/mcp/available"],
    // Pending OAuth connections resolve on Composio's side, outside this tab —
    // poll while any row is mid-flight so the badge flips without a manual refresh.
    refetchInterval: (query) => (query.state.data?.mcpServers.some((s) => s.pending) ? 3000 : false),
  });
  const servers = data?.mcpServers ?? [];

  const connectApiKeyMutation = useMutation({
    mutationFn: (mcpServerId: string) => apiRequest("POST", "/api/mcp/connect", { mcpServerId, apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mcp/available"] });
      setApiKeyDraftId(null);
      setApiKey("");
    },
  });
  const connectOAuthMutation = useMutation({
    mutationFn: (mcpServerId: string) =>
      apiRequest("POST", "/api/mcp/connect-oauth", { mcpServerId }).then((r) => r.json()) as Promise<{ redirectUrl: string }>,
    onSuccess: ({ redirectUrl }) => {
      window.open(redirectUrl, "_blank", "noopener,noreferrer");
      queryClient.invalidateQueries({ queryKey: ["/api/mcp/available"] });
    },
  });
  const disconnectMutation = useMutation({
    mutationFn: (mcpServerId: string) => apiRequest("DELETE", `/api/mcp/connect/${mcpServerId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/mcp/available"] }),
  });

  return (
    <AdminLayout>
      <div className="border-b border-border bg-card px-6 py-5">
        <h1 className="font-serif text-2xl font-bold text-foreground">{t("connectors_page.title")}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t("connectors_page.subtitle")}</p>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-8">
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("connectors_page.empty")}</p>
        ) : (
          <div className="space-y-3">
            {servers.map((s) => {
              const isOAuth = s.authStyle === "query_param_shared_key";
              const isDraftingKey = apiKeyDraftId === s.id;
              return (
                <div key={s.id} className="rounded-xl border border-border bg-card overflow-hidden" data-testid={`row-connector-${s.key}`}>
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <Link2 className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">{s.name}</p>
                      {s.description && <p className="text-xs text-muted-foreground mt-0.5">{s.description}</p>}
                    </div>
                    {s.connected ? (
                      <span className="text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded flex-shrink-0">
                        {t("connectors_page.status_connected")}
                      </span>
                    ) : s.pending ? (
                      <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded flex items-center gap-1 flex-shrink-0">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t("connectors_page.status_pending")}
                      </span>
                    ) : isOAuth ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={connectOAuthMutation.isPending}
                        onClick={() => connectOAuthMutation.mutate(s.id)}
                        data-testid={`button-connect-${s.key}`}
                      >
                        {connectOAuthMutation.isPending && connectOAuthMutation.variables === s.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          t("connectors_page.button_connect")
                        )}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { setApiKeyDraftId(isDraftingKey ? null : s.id); setApiKey(""); }}
                        data-testid={`button-connect-${s.key}`}
                      >
                        {t("connectors_page.button_connect")}
                      </Button>
                    )}
                  </div>

                  {s.connected && (
                    <div className="px-4 pb-3 flex justify-end">
                      <button
                        onClick={() => disconnectMutation.mutate(s.id)}
                        disabled={disconnectMutation.isPending}
                        className="text-xs text-destructive hover:underline"
                        data-testid={`button-disconnect-${s.key}`}
                      >
                        {disconnectMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : t("connectors_page.button_disconnect")}
                      </button>
                    </div>
                  )}

                  {isDraftingKey && !isOAuth && (
                    <div className="px-4 pb-3.5 space-y-2 border-t border-border pt-3">
                      <Input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={t("connectors_page.paste_key_placeholder")}
                        className="text-sm font-mono h-8"
                      />
                      <Button
                        size="sm"
                        className="w-full h-8"
                        disabled={connectApiKeyMutation.isPending || !apiKey.trim()}
                        onClick={() => connectApiKeyMutation.mutate(s.id)}
                      >
                        {connectApiKeyMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("connectors_page.paste_key_connect")}
                      </Button>
                      {connectApiKeyMutation.isError && (
                        <p className="text-xs text-destructive">{(connectApiKeyMutation.error as Error)?.message}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
