import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Bot, Store, CreditCard, Lock, CheckCircle2, Loader2 } from "lucide-react";

interface MarketAgent {
  id: string;
  key: string;
  name: string;
  description: string | null;
  model: string | null;
  individualPriceCents: number;
  owned: boolean;
}

const PALETTE = [
  { accent: "#0d9488", iconBg: "rgba(13,148,136,0.13)" },
  { accent: "#db2777", iconBg: "rgba(219,39,119,0.13)" },
  { accent: "#2563eb", iconBg: "rgba(37,99,235,0.13)" },
  { accent: "#059669", iconBg: "rgba(5,150,105,0.13)" },
  { accent: "#ea580c", iconBg: "rgba(234,88,12,0.13)" },
  { accent: "#7c3aed", iconBg: "rgba(124,58,237,0.13)" },
];

function PurchaseModal({ agent, onClose, onSuccess }: {
  agent: MarketAgent;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [paid, setPaid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [card, setCard] = useState({ number: "", expiry: "", cvc: "", name: "" });
  const priceLabel = (agent.individualPriceCents / 100).toFixed(2);

  const formatCard = (v: string) => v.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
  const formatExpiry = (v: string) => {
    const d = v.replace(/\D/g, "").slice(0, 4);
    return d.length >= 3 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  };

  const handlePay = async () => {
    setLoading(true);
    try {
      await apiRequest("POST", "/api/agent-market/purchase", { agentId: agent.id });
      setPaid(true);
      setTimeout(() => onSuccess(), 1400);
    } catch (err: any) {
      toast({
        title: t("agent_market.error"),
        description: err.message || t("agent_market.purchase_failed"),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={!paid ? onClose : undefined} />

      <div className="relative z-10 bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        {!paid ? (
          <>
            <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-border">
              <div>
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">{t("agent_market.monthly_addon")}</p>
                <p className="text-base font-bold text-foreground leading-snug">{agent.name}</p>
              </div>
              <div className="text-right flex-shrink-0 ml-4">
                <p className="text-2xl font-bold text-primary">${priceLabel}</p>
                <p className="text-xs text-muted-foreground">{t("agent_market.per_month")}</p>
              </div>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <Label className="text-sm text-muted-foreground mb-1.5 block">{t("agent_market.card_number")}</Label>
                <div className="relative">
                  <Input
                    data-testid="input-agent-card-number"
                    placeholder="1234 5678 9012 3456"
                    value={card.number}
                    onChange={e => setCard(c => ({ ...c, number: formatCard(e.target.value) }))}
                    className="pr-10 font-mono text-sm"
                    maxLength={19}
                  />
                  <CreditCard className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-sm text-muted-foreground mb-1.5 block">{t("agent_market.card_expiry")}</Label>
                  <Input
                    data-testid="input-agent-card-expiry"
                    placeholder="MM/YY"
                    value={card.expiry}
                    onChange={e => setCard(c => ({ ...c, expiry: formatExpiry(e.target.value) }))}
                    className="font-mono text-sm"
                    maxLength={5}
                  />
                </div>
                <div>
                  <Label className="text-sm text-muted-foreground mb-1.5 block">{t("agent_market.card_cvc")}</Label>
                  <Input
                    data-testid="input-agent-card-cvc"
                    placeholder="123"
                    value={card.cvc}
                    onChange={e => setCard(c => ({ ...c, cvc: e.target.value.replace(/\D/g, "").slice(0, 3) }))}
                    className="font-mono text-sm"
                    maxLength={3}
                  />
                </div>
              </div>
              <div>
                <Label className="text-sm text-muted-foreground mb-1.5 block">{t("agent_market.card_name")}</Label>
                <Input
                  data-testid="input-agent-card-name"
                  placeholder="Jane Smith"
                  value={card.name}
                  onChange={e => setCard(c => ({ ...c, name: e.target.value }))}
                  className="text-sm"
                />
              </div>
            </div>

            <div className="px-6 pb-6 space-y-3">
              <button
                data-testid="button-agent-pay"
                onClick={handlePay}
                disabled={loading}
                className="w-full rounded-xl bg-primary text-primary-foreground text-sm font-semibold py-3 hover:bg-primary/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-70"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                {loading ? t("agent_market.processing") : t("agent_market.pay_btn", { amount: priceLabel })}
              </button>
              <p className="text-center text-sm text-muted-foreground flex items-center justify-center gap-1">
                <Lock className="w-3 h-3" /> {t("agent_market.secured_encryption")}
              </p>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-9 h-9 text-green-600" />
            </div>
            <div>
              <p className="text-base font-bold text-foreground">{t("agent_market.payment_successful")}</p>
              <p className="text-sm text-muted-foreground mt-1">{t("agent_market.agent_unlocked")}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BrowseView({ agents, onSelect }: { agents: MarketAgent[]; onSelect: (agent: MarketAgent) => void }) {
  const { t } = useTranslation();

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center h-full py-24 gap-2">
        <Store className="w-10 h-10 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">{t("agent_market.empty_title")}</p>
        <p className="text-sm text-muted-foreground max-w-sm">{t("agent_market.empty_subtitle")}</p>
      </div>
    );
  }

  return (
    <div className="px-6 py-6 overflow-y-auto h-full">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {agents.map((agent, i) => {
          const pal = PALETTE[i % PALETTE.length];
          return (
            <div
              key={agent.id}
              data-testid={`card-agent-market-${agent.key}`}
              className="bg-white rounded-2xl p-4 flex flex-col gap-3 relative transition-all duration-200 hover:-translate-y-0.5"
              style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.05)" }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.boxShadow = `0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px ${pal.accent}33`;
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.05)";
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: agent.owned ? "rgba(22,163,74,0.13)" : pal.iconBg }}
                >
                  <Bot size={18} style={{ color: agent.owned ? "#16a34a" : pal.accent }} />
                </div>
                {agent.owned ? (
                  <span className="text-xs font-semibold text-green-600 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 leading-none">
                    {t("agent_market.owned_badge")}
                  </span>
                ) : (
                  <span className="text-sm font-bold tabular-nums leading-none" style={{ color: pal.accent }}>
                    ${(agent.individualPriceCents / 100).toFixed(2)}{t("agent_market.per_month")}
                  </span>
                )}
              </div>

              <p className="text-sm font-semibold text-gray-800 leading-snug">{agent.name}</p>
              <p className="text-xs text-gray-400 leading-relaxed line-clamp-2 flex-1">{agent.description}</p>

              <Button
                data-testid={`button-buy-agent-${agent.key}`}
                size="sm"
                variant={agent.owned ? "secondary" : "default"}
                disabled={agent.owned}
                onClick={() => onSelect(agent)}
              >
                {agent.owned ? t("agent_market.owned_btn") : t("agent_market.buy_btn")}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AgentMarket() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [purchaseTarget, setPurchaseTarget] = useState<MarketAgent | null>(null);

  const { data, isLoading } = useQuery<{ agents: MarketAgent[] }>({ queryKey: ["/api/agent-market"] });
  const agents = data?.agents ?? [];

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/agent-market"] });
    setPurchaseTarget(null);
  };

  return (
    <AdminLayout>
      <div className="border-b border-border bg-card px-6 py-4 flex items-center gap-2.5 flex-shrink-0">
        <Store className="w-5 h-5 text-primary" />
        <div>
          <h1 className="font-serif text-xl font-bold text-foreground leading-tight">{t("agent_market.page_title")}</h1>
          <p className="text-sm text-muted-foreground">{t("agent_market.page_subtitle")}</p>
        </div>
      </div>

      <div className="flex-1 overflow-hidden relative" style={{ height: "calc(100vh - 72px)" }}>
        {purchaseTarget && (
          <PurchaseModal
            agent={purchaseTarget}
            onClose={() => setPurchaseTarget(null)}
            onSuccess={handleSuccess}
          />
        )}
        {isLoading ? (
          <div className="px-6 py-6">
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-40 rounded-2xl" />
              ))}
            </div>
          </div>
        ) : (
          <BrowseView agents={agents} onSelect={setPurchaseTarget} />
        )}
      </div>
    </AdminLayout>
  );
}
