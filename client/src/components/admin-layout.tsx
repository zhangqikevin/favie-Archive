import { Link, useLocation } from "wouter";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Users2, FolderOpen, Settings, Link2,
  Utensils, LogOut, Menu, ChevronDown, Check, Building2,
  ChefHat, Headphones, Plus, Loader2, ShoppingBag, Store,
  DollarSign, Star, ClipboardList, Megaphone, Scale, Bot,
} from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { Restaurant } from "@shared/schema";
import OnboardingModal from "@/components/onboarding-modal";
import RestaurantOnboardingModal from "@/components/restaurant-onboarding-modal";

interface NavItemDef {
  labelKey: string;
  /** Literal label, for sysadmin-authored text with no translation (e.g. a generic
   * catalog product's own name). Takes priority over labelKey when set. */
  label?: string;
  href: string;
  icon: React.ElementType;
  dot?: string;
}

interface NavSection {
  sectionLabelKey?: string;
  items: NavItemDef[];
}

// Fixed metadata for the 7 possible agent tabs. Which ones actually show up in the
// sidebar is driven by the user's subscription (GET /api/agent/my-agents), not this
// list — this is just icon/label/color, keyed by the same slot id used everywhere
// else (agent_catalog.key, chat routes, etc).
const AGENT_TAB_META: Record<string, NavItemDef> = {
  expert:   { labelKey: "admin.expert",           href: "/admin/agents/expert",    icon: Star,          dot: "bg-rose-500" },
  chef:     { labelKey: "admin.chef",             href: "/admin/agents/chef",      icon: ChefHat,       dot: "bg-amber-500" },
  customer: { labelKey: "admin.customer_service", href: "/admin/agents/customer",  icon: Headphones,    dot: "bg-teal-500" },
  finance:  { labelKey: "admin.finance",          href: "/admin/agents/finance",   icon: DollarSign,    dot: "bg-emerald-500" },
  operation:{ labelKey: "admin.operation",        href: "/admin/agents/operation", icon: ClipboardList, dot: "bg-sky-500" },
  social:   { labelKey: "admin.marketing",        href: "/admin/agents/social",    icon: Megaphone,     dot: "bg-purple-500" },
  legal:    { labelKey: "admin.legal_hr",         href: "/admin/agents/legal",     icon: Scale,         dot: "bg-slate-500" },
};
// Stable display order, independent of whatever order the API returns entitled slots in.
const AGENT_TAB_ORDER = ["expert", "chef", "customer", "finance", "operation", "social", "legal"];

const navSections: NavSection[] = [
  {
    sectionLabelKey: "admin.section_tasks",
    items: [
      { labelKey: "admin.task_market", href: "/admin/task-market", icon: ShoppingBag },
    ],
  },
  {
    sectionLabelKey: "admin.section_agent_market",
    items: [
      { labelKey: "admin.agent_market", href: "/admin/agent-market", icon: Store },
    ],
  },
  {
    items: [
      { labelKey: "admin.files",      href: "/admin/files",      icon: FolderOpen },
      { labelKey: "admin.connectors", href: "/admin/connectors", icon: Link2 },
      { labelKey: "admin.settings",   href: "/admin/settings",   icon: Settings },
    ],
  },
];

function NavItem({ href, icon: Icon, labelKey, label: literalLabel, dot }: NavItemDef) {
  const [location] = useLocation();
  const { t } = useTranslation();
  const active = location === href;
  const label = literalLabel ?? t(labelKey);
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      )}
      data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
    >
      <div className="relative flex-shrink-0">
        <Icon className="w-4 h-4" />
        {dot && !active && (
          <span className={cn("absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-card", dot)} />
        )}
      </div>
      <span>{label}</span>
    </Link>
  );
}

interface EntitledAgent { key: string; name: string; description: string | null }

function AgentNavSection() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery<{ agents: EntitledAgent[] }>({
    queryKey: ["/api/agent/my-agents"],
  });

  const agents = data?.agents ?? [];
  const byKey = new Map(agents.map((a) => [a.key, a]));

  // Known tabs (with curated icon/label) first, in a stable order; any other
  // entitled catalog product — sysadmin's own name, a generic icon — after.
  const known: NavItemDef[] = AGENT_TAB_ORDER.filter((slot) => byKey.has(slot)).map((slot) => AGENT_TAB_META[slot]);
  const generic: NavItemDef[] = agents
    .filter((a) => !AGENT_TAB_META[a.key])
    .map((a) => ({ label: a.name, href: `/admin/agents/${a.key}`, icon: Bot, labelKey: "" }));
  const items = [...known, ...generic];

  return (
    <div>
      <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1.5">
        {t("admin.section_agents")}
      </p>
      <div className="space-y-0.5">
        {isLoading ? (
          <div className="px-3 py-2">
            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
          </div>
        ) : items.length > 0 ? (
          items.map((item) => <NavItem key={item.href} {...item} />)
        ) : (
          <Link
            href="/admin/agent-market"
            className="block px-3 py-2 text-sm text-muted-foreground italic hover:text-foreground transition-colors"
          >
            {t("admin.no_agents_yet")}
          </Link>
        )}
      </div>
      <div className="border-t border-border mt-3" />
    </div>
  );
}

function RestaurantDropdown() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const { data, isLoading } = useQuery<{ restaurants: Restaurant[] }>({
    queryKey: ["/api/restaurants"],
  });

  const switchMutation = useMutation({
    mutationFn: async (restaurantId: string) => {
      await apiRequest("PATCH", "/api/restaurants/current", { restaurantId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
    },
  });

  const restaurants = data?.restaurants ?? [];
  const currentId = user?.currentRestaurantId;
  const current = restaurants.find((r) => r.id === currentId) ?? restaurants[0];

  if (isLoading) {
    return (
      <div className="px-3 py-2 flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
        <span className="text-sm text-muted-foreground">Loading…</span>
      </div>
    );
  }

  if (restaurants.length === 0) {
    return (
      <div className="px-3 py-2">
        <p className="text-sm text-muted-foreground italic">{t("admin.no_restaurant")}</p>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="w-full flex items-center justify-between gap-2 text-sm font-medium text-foreground bg-muted hover:bg-muted/80 px-3 py-2 rounded-lg transition-colors"
          data-testid="button-restaurant-selector"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Building2 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 self-start mt-0.5" />
            <div className="text-left min-w-0">
              <p className="text-sm font-medium text-foreground truncate leading-tight">
                {current?.name ?? "Select restaurant"}
              </p>
              {current?.address && (
                <p className="text-xs text-muted-foreground leading-tight truncate max-w-[140px]">
                  {current.address}
                </p>
              )}
            </div>
          </div>
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {restaurants.map((r) => (
          <DropdownMenuItem
            key={r.id}
            onClick={() => switchMutation.mutate(r.id)}
            className="flex items-center justify-between gap-2 text-foreground"
            data-testid={`option-restaurant-${r.id}`}
          >
            <div className="min-w-0">
              <p className="text-sm text-foreground leading-tight">{r.name}</p>
              {r.address && (
                <p className="text-xs text-muted-foreground leading-tight truncate max-w-[180px]">{r.address}</p>
              )}
            </div>
            {r.id === (current?.id) && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/admin/settings#restaurants" className="flex items-center gap-2 text-muted-foreground cursor-pointer">
            <Plus className="w-3.5 h-3.5" />
            <span className="text-sm">{t("admin.manage_restaurants")}</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarContent({ onNavigate, onShowOnboarding }: { onNavigate?: () => void; onShowOnboarding?: () => void }) {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { t } = useTranslation();

  const handleLogout = async () => {
    await logout();
    navigate("/");
    onNavigate?.();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-border flex-shrink-0">
        <Link href="/" className="flex items-center gap-2" onClick={onNavigate}>
          <Utensils className="w-4 h-4 text-primary" />
          <span className="font-serif text-lg font-bold text-foreground">Favie</span>
        </Link>
        <p className="text-xs text-muted-foreground mt-0.5 uppercase tracking-wider">AI Restaurant Growth</p>
      </div>

      {/* Restaurant dropdown */}
      <div className="px-3 py-3 border-b border-border flex-shrink-0">
        <p className="text-sm text-muted-foreground uppercase tracking-wider mb-1.5 px-1">{t("admin.restaurant_label")}</p>
        <RestaurantDropdown />
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 space-y-4 overflow-y-auto" onClick={onNavigate}>
        <AgentNavSection />
        {navSections.map((section, si) => (
          <div key={si}>
            {section.sectionLabelKey && (
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1.5">
                {t(section.sectionLabelKey)}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavItem key={item.href} {...item} />
              ))}
            </div>
            {si < navSections.length - 1 && <div className="border-t border-border mt-3" />}
          </div>
        ))}
      </nav>

      {/* User + logout */}
      <div className="px-4 py-4 border-t border-border flex-shrink-0">
        <p className="text-sm text-muted-foreground truncate mb-2">{user?.email}</p>
        <div className="flex items-center justify-between">
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="button-sidebar-logout"
          >
            <LogOut className="w-3.5 h-3.5" />
            {t("admin.sign_out")}
          </button>
          <button
            onClick={onShowOnboarding}
            className="text-xs text-muted-foreground/40 hover:text-primary transition-colors border border-dashed border-muted-foreground/20 hover:border-primary/40 rounded px-1.5 py-0.5"
            data-testid="button-debug-onboarding"
            title="Preview onboarding"
          >
            {t("admin.onboarding")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AdminLayoutProps {
  children: React.ReactNode;
  chatMode?: boolean;
}

export default function AdminLayout({ children, chatMode }: AdminLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [debugOnboarding, setDebugOnboarding] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop fixed sidebar */}
      <aside className="hidden lg:flex flex-col w-60 flex-shrink-0 border-r border-border bg-card fixed top-0 left-0 h-screen z-30">
        <SidebarContent onShowOnboarding={() => setDebugOnboarding(true)} />
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          <button
            className="lg:hidden fixed top-3 left-3 z-50 p-2 rounded-md bg-card border border-border shadow-sm"
            aria-label="Open menu"
            data-testid="button-mobile-menu"
          >
            <Menu className="w-5 h-5 text-foreground" />
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="w-60 p-0 bg-card">
          <SidebarContent onNavigate={() => setMobileOpen(false)} onShowOnboarding={() => setDebugOnboarding(true)} />
        </SheetContent>
      </Sheet>

      {/* Main content area */}
      <div className={cn(
        "lg:ml-60 flex-1",
        chatMode ? "overflow-hidden flex flex-col" : "overflow-y-auto"
      )}>
        {children}
      </div>

      {/* Post-login onboarding modal */}
      <OnboardingModal debugOpen={debugOnboarding} onDebugClose={() => setDebugOnboarding(false)} />
      {/* Restaurant data-sync wizard — steps 2 & 3 once a restaurant exists.
          Step 1 (no restaurant yet) is still handled by each page's own gate. */}
      <RestaurantOnboardingModal />
    </div>
  );
}
