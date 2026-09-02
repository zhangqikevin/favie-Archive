import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import AdminLayout from "@/components/admin-layout";
import {
  User, CreditCard, CheckCircle2, AlertCircle,
  Circle, Building2, Plus, Trash2, Loader2, MapPin, ChevronDown, ChevronRight, Link2,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SiUbereats, SiDoordash, SiInstagram, SiTiktok, SiGoogle, SiYelp, SiTelegram } from "react-icons/si";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import RestaurantSetupFlow from "@/components/restaurant-setup-flow";
import type { Restaurant } from "@shared/schema";
import { getPlanById, ACTIVE_PLAN_ID } from "@/data/plans";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "@/components/language-switcher";

// ─── Connections data ──────────────────────────────────────────────────────────

const CONNECTIONS = [
  {
    id: "ubereats",
    name: "Uber Eats",
    detail: "Storefront + Ads",
    detailKey: "settings.conn_storefront_ads",
    category: "Delivery",
    status: "connected",
    icon: SiUbereats,
    iconBg: "bg-[#06C167]/10",
    iconColor: "#06C167",
  },
  {
    id: "doordash",
    name: "DoorDash",
    detail: "Storefront + Ads",
    detailKey: "settings.conn_storefront_ads",
    category: "Delivery",
    status: "connected",
    icon: SiDoordash,
    iconBg: "bg-[#FF3008]/10",
    iconColor: "#FF3008",
  },
  {
    id: "instagram",
    name: "Instagram",
    detail: "@goldenwok_dtw",
    category: "Social",
    status: "connected",
    icon: SiInstagram,
    iconBg: "bg-pink-50",
    iconColor: "#E1306C",
  },
  {
    id: "tiktok",
    name: "TikTok",
    detail: "@goldenwok",
    category: "Social",
    status: "connected",
    icon: SiTiktok,
    iconBg: "bg-slate-100",
    iconColor: "#000000",
  },
  {
    id: "google",
    name: "Google Business",
    detail: "Review monitoring active",
    detailKey: "settings.conn_review_monitoring",
    category: "Reputation",
    status: "connected",
    icon: SiGoogle,
    iconBg: "bg-blue-50",
    iconColor: "#4285F4",
  },
  {
    id: "yelp",
    name: "Yelp",
    detail: "Re-authentication required",
    detailKey: "settings.conn_reauth_required",
    category: "Reputation",
    status: "warning",
    icon: SiYelp,
    iconBg: "bg-red-50",
    iconColor: "#D32323",
  },
  {
    id: "telegram",
    name: "Telegram",
    detail: "Not connected",
    detailKey: "settings.conn_not_connected",
    category: "Messaging",
    status: "disconnected",
    icon: SiTelegram,
    iconBg: "bg-sky-50",
    iconColor: "#229ED9",
  },
];

function ConnectionCard({ conn }: { conn: typeof CONNECTIONS[0] }) {
  const { t } = useTranslation();
  const Icon = conn.icon;
  return (
    <div
      className="flex items-center gap-3 bg-background rounded-xl border border-border p-3"
      data-testid={`card-connection-${conn.id}`}
    >
      <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", conn.iconBg)}>
        <Icon size={18} color={conn.iconColor} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground leading-tight">{conn.name}</p>
        <p className="text-sm text-muted-foreground mt-0.5 truncate">{conn.detailKey ? t(conn.detailKey) : conn.detail}</p>
      </div>
      <div className="flex-shrink-0">
        {conn.status === "connected" && (
          <div className="flex items-center gap-1 bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
            <CheckCircle2 className="w-3 h-3" />
            <span className="text-sm font-semibold">{t("settings.status_connected")}</span>
          </div>
        )}
        {conn.status === "warning" && (
          <div className="flex items-center gap-1 bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
            <AlertCircle className="w-3 h-3" />
            <span className="text-sm font-semibold">{t("settings.status_action_needed")}</span>
          </div>
        )}
        {conn.status === "disconnected" && (
          <div className="flex items-center gap-1 bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
            <Circle className="w-3 h-3" />
            <span className="text-sm font-semibold">{t("settings.status_not_connected")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Restaurant Management ────────────────────────────────────────────────────

function RestaurantManagementSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ restaurants: Restaurant[] }>({
    queryKey: ["/api/restaurants"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/restaurants/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
    },
  });

  const restaurants = data?.restaurants ?? [];
  const connectedCount = CONNECTIONS.filter(c => c.status === "connected").length;
  // ≤3 restaurants → always show connections inline; >3 → collapsible toggle
  const inlineConnections = restaurants.length <= 3;

  return (
    <div
      id="restaurants"
      className="bg-card border border-border rounded-xl overflow-hidden"
      data-testid="section-settings-restaurants"
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <Building2 className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-sm text-foreground">{t("settings.restaurants_title")}</span>
          {restaurants.length > 0 && (
            <span className="text-sm text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              {restaurants.length}
            </span>
          )}
        </div>
        {!showAddForm && (
          <Button
            size="sm"
            variant="outline"
            className="text-sm gap-1.5"
            onClick={() => setShowAddForm(true)}
            data-testid="button-add-restaurant"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("settings.add_restaurant")}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
        </div>
      ) : (
        <div>
          {restaurants.length === 0 && !showAddForm && (
            <div className="px-5 py-8 text-center">
              <Building2 className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">{t("settings.no_restaurants")}</p>
              <button
                className="text-sm text-primary hover:underline mt-1"
                onClick={() => setShowAddForm(true)}
              >
                {t("settings.add_first_restaurant")}
              </button>
            </div>
          )}

          {restaurants.length > 0 && (
            <ul className="divide-y divide-border">
              {restaurants.map((r) => {
                const isExpanded = expandedId === r.id;
                return (
                  <li key={r.id} data-testid={`item-restaurant-${r.id}`}>
                    {/* Restaurant row */}
                    <div className="flex items-center gap-3 px-5 py-3.5">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Building2 className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground leading-tight">{r.name}</p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <MapPin className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                          <p className="text-sm text-muted-foreground truncate">{r.address}</p>
                        </div>
                        {r.rating && (
                          <p className="text-sm text-muted-foreground mt-0.5">
                            ★ {r.rating}
                            {r.reviewCount ? ` · ${r.reviewCount} reviews` : ""}
                          </p>
                        )}
                      </div>
                      {/* Connections toggle — only when >3 restaurants */}
                      {!inlineConnections && (
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : r.id)}
                          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-2.5 py-1.5 rounded-lg hover:bg-muted flex-shrink-0"
                          data-testid={`button-toggle-connections-${r.id}`}
                        >
                          <Link2 className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">{connectedCount} {t("settings.connections_label")}</span>
                          {isExpanded
                            ? <ChevronDown className="w-3.5 h-3.5" />
                            : <ChevronRight className="w-3.5 h-3.5" />
                          }
                        </button>
                      )}
                      {/* Delete */}
                      <button
                        onClick={() => deleteMutation.mutate(r.id)}
                        disabled={deleteMutation.isPending}
                        className="p-1.5 text-muted-foreground hover:text-destructive transition-colors rounded-md hover:bg-destructive/10 flex-shrink-0"
                        title="Remove restaurant"
                        data-testid={`button-delete-restaurant-${r.id}`}
                      >
                        {deleteMutation.isPending
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />
                        }
                      </button>
                    </div>

                    {/* Connections panel — always visible when ≤3, else collapsible */}
                    {(inlineConnections || isExpanded) && (
                      <div className="border-t border-border bg-muted/30 px-5 py-4" data-testid={`panel-connections-${r.id}`}>
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
                            <span className="text-sm font-semibold text-foreground">{t("settings.connections_section")}</span>
                          </div>
                          <span className="text-sm text-muted-foreground">
                            {connectedCount} {t("settings.of")} {CONNECTIONS.length} {t("settings.connected_count_label")}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          {CONNECTIONS.map((conn) => (
                            <ConnectionCard key={conn.id} conn={conn} />
                          ))}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {showAddForm && (
            <div className="px-5 py-5 border-t border-border">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-semibold text-foreground">{t("settings.add_new_restaurant")}</p>
                <button
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowAddForm(false)}
                >
                  {t("settings.cancel")}
                </button>
              </div>
              <RestaurantSetupFlow
                compact
                onComplete={() => {
                  queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
                  setTimeout(() => setShowAddForm(false), 1400);
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Settings sections ─────────────────────────────────────────────────────────

// Sections are built inside the component using t() for i18n

export default function AdminSettings() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const activePlan = getPlanById(ACTIVE_PLAN_ID);
  const activePlanLabel = activePlan
    ? `${activePlan.name} · ${activePlan.price}${t("common.month")}`
    : "—";

  const sections = [
    {
      id: "account",
      icon: User,
      title: t("settings.section_account"),
      fields: [
        { label: t("settings.field_email"), value: user?.email ?? "—" },
        { label: t("settings.field_role"), value: "Owner" },
      ],
    },
    {
      id: "billing",
      icon: CreditCard,
      title: t("settings.section_billing"),
      fields: [
        { label: t("settings.field_active_plan"), value: activePlanLabel },
        { label: t("settings.field_next_billing"), value: "April 1, 2026" },
        { label: t("settings.field_payment_method"), value: "Visa ending in 4242" },
      ],
    },
  ];

  return (
    <AdminLayout>
      <div className="border-b border-border bg-card px-6 py-5">
        <h1 className="font-serif text-2xl font-bold text-foreground">{t("settings.page_title")}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t("settings.page_subtitle")}</p>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6 pb-16">

        {/* Restaurant Management — connections nested per restaurant */}
        <RestaurantManagementSection />

        {/* Language & Region */}
        <div className="bg-card border border-border rounded-xl overflow-hidden" data-testid="section-settings-language">
          <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
            <Globe className="w-4 h-4 text-muted-foreground" />
            <span className="font-semibold text-sm text-foreground">{t("settings.language_section")}</span>
          </div>
          <div className="px-5 py-5 space-y-3">
            <div>
              <p className="text-sm text-muted-foreground mb-3">{t("settings.language_desc")}</p>
              <LanguageSwitcher />
            </div>
          </div>
        </div>

        {/* All other settings sections */}
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <div key={section.id} className="bg-card border border-border rounded-xl overflow-hidden" data-testid={`section-settings-${section.id}`}>
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <div className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 text-muted-foreground" />
                  <span className="font-semibold text-sm text-foreground">{section.title}</span>
                </div>
                <Button size="sm" variant="outline" className="text-sm">{t("settings.edit")}</Button>
              </div>
              <ul className="divide-y divide-border">
                {section.fields.map((f) => (
                  <li key={f.label} className="flex items-center justify-between px-5 py-3">
                    <span className="text-sm text-muted-foreground">{f.label}</span>
                    <span className="text-sm font-medium text-foreground">{f.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </AdminLayout>
  );
}
