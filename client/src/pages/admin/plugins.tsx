import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Loader2, Plug, Search } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

interface CatalogToolkit {
  slug: string;
  name: string;
  logo: string | null;
  description: string | null;
  connected: boolean;
}
interface CatalogPage {
  items: CatalogToolkit[];
  nextCursor: string | null;
}
interface ConnectedItem {
  mcpServerId: string;
  key: string;
  name: string;
  description: string | null;
}
interface Category {
  id: string;
  name: string;
}

// Toolkits the user just hit "Connect" on — polled until they go ACTIVE at Composio.
function useConnectingPoll(onSettled: (slug: string) => void) {
  const [connecting, setConnecting] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (connecting.size === 0) return;
    const interval = setInterval(async () => {
      for (const slug of Array.from(connecting)) {
        const res = await fetch(`/api/connectors/catalog/${slug}/status`);
        if (!res.ok) continue;
        const status: { connected: boolean; pending: boolean } = await res.json();
        if (status.connected || !status.pending) {
          setConnecting((s) => {
            const next = new Set(s);
            next.delete(slug);
            return next;
          });
          onSettled(slug);
        }
      }
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connecting]);

  return {
    connecting,
    start: (slug: string) => setConnecting((s) => new Set(s).add(slug)),
  };
}

function BrowseTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [pages, setPages] = useState<CatalogToolkit[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const { start, connecting } = useConnectingPoll(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/connectors/catalog"] });
    queryClient.invalidateQueries({ queryKey: ["/api/connectors/connected"] });
  });

  const { data: categoriesData } = useQuery<{ items: Category[] }>({ queryKey: ["/api/connectors/categories"] });
  const categories = categoriesData?.items ?? [];

  const params = new URLSearchParams();
  if (debouncedSearch) params.set("search", debouncedSearch);
  if (category) params.set("category", category);
  if (cursor) params.set("cursor", cursor);
  const queryKey = ["/api/connectors/catalog", debouncedSearch, category, cursor];
  const { data, isLoading, isFetching } = useQuery<CatalogPage>({
    queryKey,
    queryFn: () => fetch(`/api/connectors/catalog?${params.toString()}`).then((r) => r.json()),
  });

  // Reset the accumulated list whenever the search term or category changes (not on load-more).
  useEffect(() => {
    setCursor(undefined);
    setPages([]);
  }, [debouncedSearch, category]);

  useEffect(() => {
    if (data?.items) setPages((prev) => (cursor ? [...prev, ...data.items] : data.items));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const connectMutation = useMutation({
    mutationFn: (toolkit: CatalogToolkit) =>
      apiRequest("POST", `/api/connectors/catalog/${toolkit.slug}/connect`, {
        name: toolkit.name,
        description: toolkit.description,
      }).then((r) => r.json()) as Promise<{ redirectUrl: string }>,
    onSuccess: ({ redirectUrl }, toolkit) => {
      window.open(redirectUrl, "_blank", "noopener,noreferrer");
      start(toolkit.slug);
    },
  });

  return (
    <div>
      <div className="relative mb-4">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("connectors_page.search_placeholder")}
          className="pl-9"
          data-testid="input-connector-search"
        />
      </div>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <button
            onClick={() => setCategory(undefined)}
            className={cn(
              "px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
              !category ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
            data-testid="category-all"
          >
            {t("connectors_page.category_all")}
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setCategory(cat.id === category ? undefined : cat.id)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium capitalize transition-colors",
                category === cat.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
              data-testid={`category-${cat.id}`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      ) : pages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("connectors_page.empty")}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {pages.map((toolkit) => {
            const isConnecting = connecting.has(toolkit.slug);
            const isThisMutationPending = connectMutation.isPending && connectMutation.variables?.slug === toolkit.slug;
            return (
              <div
                key={toolkit.slug}
                className="rounded-xl border border-border bg-card p-3.5 flex items-start gap-3"
                data-testid={`row-toolkit-${toolkit.slug}`}
              >
                {toolkit.logo ? (
                  <img src={toolkit.logo} alt="" className="w-8 h-8 rounded-md flex-shrink-0 object-contain" />
                ) : (
                  <div className="w-8 h-8 rounded-md flex-shrink-0 bg-muted flex items-center justify-center">
                    <Link2 className="w-4 h-4 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{toolkit.name}</p>
                  {toolkit.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{toolkit.description}</p>
                  )}
                </div>
                <div className="flex-shrink-0">
                  {toolkit.connected ? (
                    <span className="text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded">
                      {t("connectors_page.status_connected")}
                    </span>
                  ) : isConnecting ? (
                    <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t("connectors_page.status_pending")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isThisMutationPending}
                      onClick={() => connectMutation.mutate(toolkit)}
                      data-testid={`button-connect-${toolkit.slug}`}
                    >
                      {isThisMutationPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("connectors_page.button_connect")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data?.nextCursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => setCursor(data.nextCursor!)}>
            {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("connectors_page.load_more")}
          </Button>
        </div>
      )}
    </div>
  );
}

function ConnectedList({
  queryKey,
  emptyKey,
  disconnectInvalidateKeys,
}: {
  queryKey: string;
  emptyKey: string;
  disconnectInvalidateKeys: string[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ items: ConnectedItem[] }>({ queryKey: [queryKey] });
  const items = data?.items ?? [];

  const disconnectMutation = useMutation({
    mutationFn: (mcpServerId: string) => apiRequest("DELETE", `/api/mcp/connect/${mcpServerId}`),
    onSuccess: () => {
      for (const key of disconnectInvalidateKeys) queryClient.invalidateQueries({ queryKey: [key] });
    },
  });

  if (isLoading) return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t(emptyKey)}</p>;

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item.mcpServerId} className="rounded-xl border border-border bg-card overflow-hidden" data-testid={`row-connected-${item.key}`}>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <Link2 className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">{item.name}</p>
              {item.description && <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>}
            </div>
            <span className="text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded flex-shrink-0">
              {t("connectors_page.status_connected")}
            </span>
          </div>
          <AgentAccessSelector mcpServerId={item.mcpServerId} />
          <div className="px-4 pb-3 flex justify-end">
            <button
              onClick={() => disconnectMutation.mutate(item.mcpServerId)}
              disabled={disconnectMutation.isPending}
              className="text-xs text-destructive hover:underline"
              data-testid={`button-disconnect-${item.key}`}
            >
              {disconnectMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : t("connectors_page.button_disconnect")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

interface MyAgent {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

// Lets the customer pick which of their own agents can use one self-serve connection —
// sysadmin-managed servers never show up here at all (see server/zoowork-admin.ts).
function AgentAccessSelector({ mcpServerId }: { mcpServerId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const agentsKey = "/api/agent/my-agents";
  const bindingsKey = `/api/connectors/${mcpServerId}/agents`;
  const { data: myAgentsData } = useQuery<{ agents: MyAgent[] }>({ queryKey: [agentsKey] });
  const { data: enabledData, isLoading } = useQuery<{ agentCatalogIds: string[] }>({ queryKey: [bindingsKey] });
  const agents = myAgentsData?.agents ?? [];
  const enabled = new Set(enabledData?.agentCatalogIds ?? []);

  const toggleMutation = useMutation({
    mutationFn: (agentCatalogIds: string[]) => apiRequest("PUT", bindingsKey, { agentCatalogIds }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [bindingsKey] }),
  });

  if (agents.length === 0) return null;

  const toggle = (agentId: string) => {
    const next = new Set(enabled);
    if (next.has(agentId)) next.delete(agentId);
    else next.add(agentId);
    toggleMutation.mutate(Array.from(next));
  };

  return (
    <div className="px-4 pb-3 pt-0.5">
      <p className="text-xs font-medium text-muted-foreground mb-1.5">{t("connectors_page.available_to_agents")}</p>
      <div className="flex flex-wrap gap-1.5">
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
        ) : (
          agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => toggle(agent.id)}
              disabled={toggleMutation.isPending}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
                enabled.has(agent.id) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
              data-testid={`agent-toggle-${agent.id}`}
            >
              {agent.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ConnectorsSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"browse" | "connected">("browse");

  return (
    <div>
      <div className="flex gap-1 mb-5">
        {(["browse", "connected"] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              tab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
            )}
            data-testid={`tab-${key}`}
          >
            {t(`connectors_page.tab_${key}`)}
          </button>
        ))}
      </div>
      {tab === "browse" ? (
        <BrowseTab />
      ) : (
        <ConnectedList
          queryKey="/api/connectors/connected"
          emptyKey="connectors_page.none_connected"
          disconnectInvalidateKeys={["/api/connectors/connected", "/api/connectors/catalog"]}
        />
      )}
    </div>
  );
}

function AddCustomMcpForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [authHeaderName, setAuthHeaderName] = useState("Authorization");
  const [authScheme, setAuthScheme] = useState("Bearer ");
  const [apiKey, setApiKey] = useState("");

  const addMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/mcps/custom", {
        name,
        description: description || null,
        targetUrl,
        authHeaderName,
        authScheme,
        apiKey,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mcps/custom"] });
      onDone();
    },
  });

  const canSubmit = name.trim() && targetUrl.trim() && apiKey.trim();

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3 mb-4">
      <div>
        <label className="text-xs font-medium text-muted-foreground">{t("mcps_page.field_name")}</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-8 text-sm" data-testid="input-mcp-name" />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">{t("mcps_page.field_description")}</label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 h-8 text-sm" data-testid="input-mcp-description" />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">{t("mcps_page.field_url")}</label>
        <Input
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          placeholder="https://example.com/mcp"
          className="mt-1 h-8 text-sm font-mono"
          data-testid="input-mcp-url"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t("mcps_page.field_auth_header")}</label>
          <Input value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} className="mt-1 h-8 text-sm font-mono" data-testid="input-mcp-auth-header" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t("mcps_page.field_auth_scheme")}</label>
          <Input value={authScheme} onChange={(e) => setAuthScheme(e.target.value)} className="mt-1 h-8 text-sm font-mono" data-testid="input-mcp-auth-scheme" />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">{t("mcps_page.field_api_key")}</label>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="mt-1 h-8 text-sm font-mono" data-testid="input-mcp-api-key" />
      </div>
      {addMutation.isError && <p className="text-xs text-destructive">{(addMutation.error as Error)?.message}</p>}
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="outline" size="sm" onClick={onDone}>
          {t("mcps_page.cancel")}
        </Button>
        <Button size="sm" disabled={!canSubmit || addMutation.isPending} onClick={() => addMutation.mutate()} data-testid="button-submit-mcp">
          {addMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("mcps_page.add_submit")}
        </Button>
      </div>
    </div>
  );
}

function McpsSection() {
  const { t } = useTranslation();
  const [showForm, setShowForm] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">{t("mcps_page.subtitle")}</p>
        {!showForm && (
          <Button size="sm" onClick={() => setShowForm(true)} data-testid="button-add-mcp">
            <Plug className="w-3.5 h-3.5 mr-1.5" />
            {t("mcps_page.add_button")}
          </Button>
        )}
      </div>
      {showForm && <AddCustomMcpForm onDone={() => setShowForm(false)} />}
      <ConnectedList
        queryKey="/api/mcps/custom"
        emptyKey="mcps_page.empty"
        disconnectInvalidateKeys={["/api/mcps/custom"]}
      />
    </div>
  );
}

export default function AdminPlugins() {
  const { t } = useTranslation();
  const [section, setSection] = useState<"connectors" | "mcps">("connectors");

  return (
    <AdminLayout>
      <div className="border-b border-border bg-card px-6 py-5">
        <h1 className="font-serif text-2xl font-bold text-foreground">{t("plugins_page.title")}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t("plugins_page.subtitle")}</p>
        <div className="flex gap-1 mt-4">
          {(["connectors", "mcps"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors",
                section === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
              data-testid={`section-${key}`}
            >
              {t(`plugins_page.section_${key}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-8">
        {section === "connectors" ? <ConnectorsSection /> : <McpsSection />}
      </div>
    </AdminLayout>
  );
}
