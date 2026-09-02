import { useState, useRef, useEffect, type ComponentType, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useParams, useSearch } from "wouter";
import AdminLayout from "@/components/admin-layout";
import { useAuth } from "@/lib/auth-context";
import RestaurantSetupFlow from "@/components/restaurant-setup-flow";
import type { Restaurant } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip as UITooltip,
  TooltipTrigger as UITooltipTrigger,
  TooltipContent as UITooltipContent,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { ChatMarkdown } from "@/components/chat-markdown";
import { MessageBubble } from "@/components/message-bubble";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { SiWechat, SiSlack } from "react-icons/si";
import {
  Send, ChevronLeft, Briefcase, ChefHat, Megaphone, Headphones,
  ArrowUpRight, ArrowDownRight, Minus, Zap, CheckCircle2, AlertCircle,
  Star, TrendingUp, ImageIcon, Camera, FileText, DollarSign, Scale,
  Bell, ShieldAlert, BarChart2, ListChecks, RefreshCw, MessageSquare,
  CreditCard, Lock, Loader2, PenLine, AlertTriangle, ClipboardList,
  GraduationCap, Building2, BarChart3, Tag, CalendarDays, Users, Video, Trash2,
  Link2, X, ChevronDown, ChevronUp, Paperclip,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentId = "operation" | "chef" | "social" | "customer" | "finance" | "legal" | "expert";

// Only these 7 have curated marketing copy/task menus below (AGENT_CONFIGS, AGENT_TASKS,
// etc). Any other agent_catalog key a subscription entitles the user to (see
// server/agent-entitlements.ts) still routes here, but useAgentConfig gives it a plain,
// generic config instead of pretending it's one of these seven.
const KNOWN_AGENT_IDS = new Set<string>(["operation", "chef", "social", "customer", "finance", "legal", "expert"]);
function isKnownAgentId(id: string): id is AgentId {
  return KNOWN_AGENT_IDS.has(id);
}

interface EntitledAgent { key: string; name: string; description: string | null }

interface ToolStep {
  toolName: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  resultPreview?: string;
}

interface ChatMsg {
  id: string;
  role: "ai" | "user";
  text: string;
  content?: React.ReactNode;
  ts: string;
  steps?: ToolStep[];
  attachmentUrl?: string;
}

interface ChipDef {
  label: string;
  response: { text: string; content?: React.ReactNode };
}

// ─── Tool Steps (Claude Code–style) ─────────────────────────────────────────────

function formatToolArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  const parts = Object.values(args).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  const joined = parts.join(", ");
  return joined.length > 60 ? `${joined.slice(0, 60)}…` : joined;
}

function ToolStepRow({ step }: { step: ToolStep }) {
  const [expanded, setExpanded] = useState(false);
  const hasPreview = !!step.resultPreview;
  return (
    <div className="font-mono text-xs leading-relaxed">
      <button
        type="button"
        onClick={() => hasPreview && setExpanded((v) => !v)}
        className={cn(
          "flex items-start gap-1.5 w-full text-left",
          hasPreview ? "cursor-pointer" : "cursor-default"
        )}
      >
        <span className={cn("mt-0.5 flex-shrink-0", step.isError ? "text-destructive" : "text-muted-foreground")}>●</span>
        <span className="flex-1 min-w-0 truncate">
          <span className="text-foreground font-medium">{step.toolName}</span>
          <span className="text-muted-foreground">({formatToolArgs(step.args)})</span>
        </span>
        {hasPreview && (
          expanded
            ? <ChevronUp className="w-3 h-3 text-muted-foreground flex-shrink-0 mt-1" />
            : <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0 mt-1" />
        )}
      </button>
      {hasPreview && (
        <div className="flex items-start gap-1.5 pl-4">
          <span className="text-muted-foreground flex-shrink-0">⎿</span>
          <span className={cn(
            "text-muted-foreground",
            expanded ? "whitespace-pre-wrap break-words" : "truncate"
          )}>
            {step.resultPreview}
          </span>
        </div>
      )}
    </div>
  );
}

function ToolStepsBlock({ steps }: { steps: ToolStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mb-2 rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-1.5">
      {steps.map((step, i) => <ToolStepRow key={i} step={step} />)}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId() { return Math.random().toString(36).slice(2); }
function nowStr() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

function Delta({ v, up }: { v: string; up: boolean | null }) {
  return (
    <div className="flex items-center gap-1 mt-0.5">
      {up === true && <ArrowUpRight className="w-3 h-3 text-green-600" />}
      {up === false && <ArrowDownRight className="w-3 h-3 text-red-500" />}
      {up === null && <Minus className="w-3 h-3 text-muted-foreground" />}
      <span className={cn("text-sm font-semibold", up === true ? "text-green-600" : up === false ? "text-red-500" : "text-muted-foreground")}>{v}</span>
    </div>
  );
}

// ─── OPERATION AGENT BLOCKS ───────────────────────────────────────────────────

const revenueChart = [
  { week: "W1", orders: 280, revenue: 6200, spend: 280 },
  { week: "W2", orders: 301, revenue: 6680, spend: 310 },
  { week: "W3", spend: 295, orders: 314, revenue: 6960 },
  { week: "W4", spend: 330, orders: 389, revenue: 8620 },
];

function OpGrowthSnapshot() {
  const { t } = useTranslation();
  const kpis = [
    { label: t("agents_page.op_kpi_total_orders"), value: "1,284", delta: "+12.4%", up: true, sub: t("agents_page.vs_last_month") },
    { label: t("agents_page.op_kpi_online_revenue"), value: "$28,460", delta: "+8.7%", up: true, sub: t("agents_page.vs_last_month") },
    { label: t("agents_page.op_kpi_avg_order_value"), value: "$22.17", delta: "+3.2%", up: true, sub: t("agents_page.vs_last_month") },
    { label: t("agents_page.op_kpi_repeat_rate"), value: "31%", delta: "+2.1pp", up: true, sub: t("agents_page.vs_last_month") },
  ];
  return (
    <div className="mt-3 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {kpis.map((k) => (
          <div key={k.label} className="bg-background border border-border rounded-xl p-3.5">
            <p className="text-sm text-muted-foreground">{k.label}</p>
            <p className="font-serif text-xl font-bold text-foreground mt-1">{k.value}</p>
            <Delta v={k.delta} up={k.up} />
            <p className="text-sm text-muted-foreground mt-0.5">{k.sub}</p>
          </div>
        ))}
      </div>
      <div className="bg-background border border-border rounded-xl p-4">
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("agents_page.op_chart_label")}</p>
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={revenueChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(21,55%,50%)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="hsl(21,55%,50%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="week" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Area type="monotone" dataKey="revenue" stroke="hsl(21,55%,50%)" fill="url(#gRev)" strokeWidth={2} name="Revenue ($)" />
            <Area type="monotone" dataKey="orders" stroke="hsl(128,15%,59%)" fill="none" strokeWidth={2} name="Orders" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function OpDeliveryComparison() {
  const { t } = useTranslation();
  const rows = [
    [t("agents_page.op_row_ad_spend"), "$1,420", "$980"],
    [t("agents_page.op_row_orders"), "739", "545"],
    [t("agents_page.op_row_revenue"), "$17,240", "$11,220"],
    [t("agents_page.op_row_roas"), "3.1x", "2.8x"],
    [t("agents_page.op_row_cost_per_order"), "$1.81", "$1.98"],
    [t("agents_page.op_row_conversion_rate"), "6.9%", "6.0%"],
    [t("agents_page.op_row_rating"), "4.8 ★", "4.3 ★"],
    [t("agents_page.op_row_order_trend"), "+15.8%", "−7.5%"],
  ];
  const orderTrendLabel = t("agents_page.op_row_order_trend");
  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      <div className="grid grid-cols-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground px-4 py-2.5 border-b border-border bg-muted/40">
        <span>{t("agents_page.op_col_metric")}</span>
        <span className="text-green-700">Uber Eats</span>
        <span className="text-red-600">DoorDash</span>
      </div>
      {rows.map(([label, ue, dd]) => (
        <div key={label} className="grid grid-cols-3 items-center px-4 py-3 border-b border-border last:border-0">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className="text-sm font-semibold text-foreground">{ue}</span>
          <span className={cn("text-sm font-semibold", label === orderTrendLabel ? "text-red-500" : "text-foreground")}>{dd}</span>
        </div>
      ))}
    </div>
  );
}

function OpBudgetRec() {
  const { t } = useTranslation();
  const [applied, setApplied] = useState(false);
  return (
    <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="w-3.5 h-3.5 text-amber-600" />
        <span className="text-sm font-semibold text-amber-700">{t("agents_page.op_budget_title")}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          [t("agents_page.op_budget_current_cap"), "$1,300", t("agents_page.op_budget_current_cap_sub")],
          [t("agents_page.op_budget_recommended_cap"), "$700", t("agents_page.op_budget_recommended_cap_sub")],
          [t("agents_page.op_budget_estimated_savings"), "$600/mo", t("agents_page.op_budget_estimated_savings_sub")],
        ].map(([l, v, s]) => (
          <div key={l} className="text-center bg-white/70 rounded-lg p-2.5">
            <p className="text-sm text-muted-foreground mb-1">{l}</p>
            <p className="text-base font-bold text-foreground font-serif">{v}</p>
            <p className="text-sm text-muted-foreground mt-0.5">{s}</p>
          </div>
        ))}
      </div>
      <p className="text-sm text-foreground/70 mb-3">{t("agents_page.op_budget_desc")}</p>
      {applied
        ? <span className="flex items-center gap-1.5 text-sm text-green-700 font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> {t("agents_page.op_budget_applied")}</span>
        : <div className="flex gap-2">
            <Button size="sm" onClick={() => setApplied(true)} className="bg-amber-600 hover:bg-amber-700 text-white border-0">{t("agents_page.op_budget_apply_btn")}</Button>
            <Button size="sm" variant="outline">{t("agents_page.op_budget_view_breakdown")}</Button>
          </div>
      }
    </div>
  );
}

function OpPromoMix() {
  const { t } = useTranslation();
  const promos = [
    { type: "BOGO", platform: "Uber Eats", item: "Spring Roll Set", active: true, result: "+34 orders" },
    { type: "Combo Deal", platform: "Both", item: "Wok & Roll Bundle $28.50", active: true, result: "+61 orders" },
    { type: "Spend Threshold", platform: "DoorDash", item: "Free delivery on $30+", active: true, result: "+18 orders" },
    { type: "% Discount", platform: "Uber Eats", item: "15% off lunch 12–2 PM", active: false, result: "—" },
  ];
  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-blue-50">
        <p className="text-sm font-semibold text-blue-700 uppercase tracking-wider">{t("agents_page.op_promo_mix_title")}</p>
      </div>
      {promos.map((p, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-sm font-semibold text-muted-foreground uppercase">{p.type}</span>
              <span className="text-sm text-muted-foreground">· {p.platform}</span>
            </div>
            <p className="text-sm font-medium text-foreground">{p.item}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <span className={cn("text-sm font-semibold px-2 py-0.5 rounded-full", p.active ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground")}>{p.active ? t("agents_page.promo_status_active") : t("agents_page.promo_status_paused")}</span>
            <p className="text-sm font-semibold text-green-600 mt-0.5">{p.result}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── CHEF AGENT BLOCKS ────────────────────────────────────────────────────────

function ChefDishIdeas() {
  const ideas = [
    { name: "Mango Chicken Rice Bowl", emoji: "🥭", trend: "Trending on TikTok", reason: "Mango + savory protein combos are surging in food content this month. High photogenic appeal. Matches your existing prep skills.", readiness: "High", img: "https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?w=100&q=80" },
    { name: "Spicy Garlic Wings", emoji: "🍗", trend: "Summer heat wave demand", reason: "Wings are among the top 3 searched snack items in your delivery zone. Spicy garlic is the #1 flavor variant. Easy prep, high margin.", readiness: "High", img: "https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=100&q=80" },
    { name: "Cold Sesame Noodle Bowl", emoji: "🍜", trend: "Seasonal — summer light meals", reason: "Cold noodle dishes spike in searches each June–August. Your existing sesame noodle sauce can be adapted. Great for photo content.", readiness: "Medium", img: "https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=100&q=80" },
    { name: "Crispy Tofu Bento Box", emoji: "🍱", trend: "Health-conscious audience", reason: "Bento-format meals have 2.3x higher Instagram share rates than standard plates. Targets a customer segment not currently served in your zone.", readiness: "Medium", img: "https://images.unsplash.com/photo-1547592180-85f173990554?w=100&q=80" },
  ];
  return (
    <div className="mt-3 space-y-2">
      <div className="px-4 py-2.5 rounded-t-xl bg-amber-50 border border-amber-200 border-b-0">
        <p className="text-sm font-semibold text-amber-700 uppercase tracking-wider">New Dish Opportunities</p>
      </div>
      {ideas.map((d, i) => (
        <div key={i} className={cn("border border-border rounded-xl p-4 flex gap-3 bg-background", i === 0 && "rounded-tl-none rounded-tr-none border-t-0")}>
          <img src={d.img} alt={d.name} className="w-14 h-14 rounded-lg object-cover flex-shrink-0 bg-muted" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-1">
              <p className="text-sm font-semibold text-foreground">{d.name}</p>
              <span className={cn("text-sm font-semibold px-2 py-0.5 rounded-full flex-shrink-0", d.readiness === "High" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700")}>
                {d.readiness} readiness
              </span>
            </div>
            <p className="text-sm font-medium text-primary mb-1">{d.trend}</p>
            <p className="text-sm text-muted-foreground leading-snug">{d.reason}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function ChefPhotoReview() {
  const items = [
    { name: "Steamed Fish Fillet", score: 3, issue: "Dark background, no garnish visible. Click-through rate 18% below average.", fix: "Shoot on natural wood board with herb garnish and steam effect." },
    { name: "Hot & Sour Soup", score: 3, issue: "Photo shows bowl from too far. Texture and color of broth aren't visible.", fix: "Close-up overhead shot with visible ingredients floating. Add steam." },
    { name: "Beef Broccoli Rice Box", score: 4, issue: "Good composition but the broccoli looks overcooked in the image.", fix: "Reshoot with fresher broccoli and brighter lighting. Increase contrast." },
    { name: "Kung Pao Chicken", score: 5, issue: "Strong hero image. No changes needed.", fix: "Keep as hero product on both platforms." },
    { name: "Mango Milk Tea", score: 2, issue: "No dedicated product photo. Using generic beverage image.", fix: "Custom photo needed — use branded cup, mango slices as props." },
  ];
  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-orange-50">
        <p className="text-sm font-semibold text-orange-700 uppercase tracking-wider flex items-center gap-1.5">
          <Camera className="w-3.5 h-3.5" /> Menu Photo Quality Review
        </p>
      </div>
      {items.map((item, i) => (
        <div key={i} className="px-4 py-3 border-b border-border last:border-0">
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <p className="text-sm font-semibold text-foreground">{item.name}</p>
            <div className="flex gap-0.5 flex-shrink-0">
              {[1,2,3,4,5].map((s) => (
                <Star key={s} className={cn("w-3 h-3", s <= item.score ? "text-amber-400 fill-amber-400" : "text-border")} />
              ))}
            </div>
          </div>
          <p className="text-sm text-red-600 mb-1">{item.issue}</p>
          <p className="text-sm text-green-700">→ {item.fix}</p>
        </div>
      ))}
    </div>
  );
}

function ChefDescriptionUpgrade() {
  const items = [
    {
      name: "Beef Broccoli Rice Box",
      before: "Beef and broccoli with steamed white rice.",
      after: "Tender wok-seared beef and crisp broccoli in our savory garlic-oyster sauce, served over fluffy steamed jasmine rice. Hearty, balanced, and satisfying.",
    },
    {
      name: "Crispy Spring Rolls",
      before: "4 crispy spring rolls with dipping sauce.",
      after: "Four golden-fried spring rolls packed with seasoned pork and vegetables, hand-wrapped and fried to a satisfying crunch. Served with house sweet chili sauce.",
    },
    {
      name: "Mango Milk Tea",
      before: "Mango milk tea drink.",
      after: "Creamy mango milk tea made with real mango purée and fresh-brewed tea, lightly sweetened and served over ice. Refreshing and naturally sweet.",
    },
  ];
  return (
    <div className="mt-3 space-y-3">
      <div className="px-4 py-2.5 rounded-xl border border-border bg-background mb-0">
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-0">
          <FileText className="w-3.5 h-3.5" /> Item Description Upgrades
        </p>
      </div>
      {items.map((item, i) => (
        <div key={i} className="bg-background border border-border rounded-xl p-4">
          <p className="text-sm font-semibold text-foreground mb-3">{item.name}</p>
          <div className="space-y-2">
            <div className="bg-red-50 border border-red-100 rounded-lg px-3 py-2.5">
              <p className="text-sm font-semibold text-red-600 uppercase tracking-wide mb-1.5">Current</p>
              <p className="text-sm text-foreground/70 italic">"{item.before}"</p>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2.5">
              <p className="text-sm font-semibold text-green-700 uppercase tracking-wide mb-1.5">Suggested</p>
              <p className="text-sm text-foreground">"{item.after}"</p>
            </div>
          </div>
          <Button size="sm" variant="outline" className="mt-3 text-sm">Apply to Platform</Button>
        </div>
      ))}
    </div>
  );
}

// ─── SOCIAL MEDIA AGENT BLOCKS ────────────────────────────────────────────────

function SocialContentPerformance() {
  const posts = [
    { day: "Mon", reach: 1200 }, { day: "Tue", reach: 4200 }, { day: "Wed", reach: 980 },
    { day: "Thu", reach: 1840 }, { day: "Fri", reach: 2100 }, { day: "Sat", reach: 1450 }, { day: "Sun", reach: 680 },
  ];
  return (
    <div className="mt-3 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Posts This Month", value: "12", delta: "+3 vs last", up: true },
          { label: "Total Reach", value: "14,200", delta: "+22%", up: true },
          { label: "Avg Engagement", value: "3.8%", delta: "+0.6pp", up: true },
          { label: "Saves", value: "894", delta: "+41%", up: true },
          { label: "Profile Visits", value: "1,240", delta: "+28%", up: true },
          { label: "Follower Growth", value: "+312", delta: "TikTok referral", up: null },
        ].map((k) => (
          <div key={k.label} className="bg-background border border-border rounded-xl p-3">
            <p className="text-sm text-muted-foreground leading-snug">{k.label}</p>
            <p className="font-serif text-lg font-bold text-foreground mt-1">{k.value}</p>
            <Delta v={k.delta} up={k.up} />
          </div>
        ))}
      </div>
      <div className="bg-background border border-border rounded-xl p-4">
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Daily Reach This Week</p>
        <ResponsiveContainer width="100%" height={100}>
          <AreaChart data={posts} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gReach" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(270,60%,55%)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="hsl(270,60%,55%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="day" tick={{ fontSize: 10 }} />
            <Tooltip />
            <Area type="monotone" dataKey="reach" stroke="hsl(270,60%,55%)" fill="url(#gReach)" strokeWidth={2} name="Reach" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SocialBestPost() {
  return (
    <div className="mt-3 bg-background border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
        <p className="text-sm font-semibold text-foreground">Best Performing Post This Week</p>
      </div>
      <div className="flex gap-3 mb-3">
        <div className="w-20 h-20 rounded-xl bg-gradient-to-br from-orange-400 via-red-400 to-pink-500 flex items-center justify-center flex-shrink-0">
          <ImageIcon className="w-8 h-8 text-white/80" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground mb-1">Kung Pao Chicken Sizzle Reel</p>
          <p className="text-sm text-muted-foreground mb-2">Posted Tuesday · Instagram Reels + TikTok</p>
          <div className="grid grid-cols-2 gap-1.5">
            {[["Views", "4,200"], ["Saves", "312"], ["Profile visits", "89"], ["Orders tracked", "6"]].map(([l, v]) => (
              <div key={l} className="flex justify-between text-sm">
                <span className="text-muted-foreground">{l}</span>
                <span className="font-semibold text-foreground">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2.5">
        <p className="text-sm text-purple-800"><strong>AI Recommendation:</strong> Boost this post with $80 paid promotion — projected reach 22,000–28,000. Save rate (7.4%) is 2.1x your account average, indicating strong resonance.</p>
      </div>
    </div>
  );
}

function SocialAudienceInsights() {
  return (
    <div className="mt-3 space-y-3">
      <div className="bg-background border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Audience Reaction Themes</p>
        </div>
        {[
          { theme: "Food visuals & plating", volume: "High", sentiment: "Positive", note: "Sizzle and steam effects drive highest save rate" },
          { theme: "Delivery speed mentions", volume: "Medium", sentiment: "Mixed", note: "Some comments asking for faster delivery" },
          { theme: "Price / value comments", volume: "Medium", sentiment: "Positive", note: "'Good portions for the price' — common phrase" },
          { theme: "Combo requests", volume: "Low", sentiment: "Opportunity", note: "DMs asking if combo meals are available" },
        ].map((t, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-0">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">{t.theme}</p>
              <p className="text-sm text-muted-foreground mt-0.5">{t.note}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <span className={cn("text-sm font-semibold px-2 py-0.5 rounded-full",
                t.sentiment === "Positive" ? "bg-green-100 text-green-700" :
                t.sentiment === "Mixed" ? "bg-amber-100 text-amber-700" :
                "bg-blue-100 text-blue-700")}>{t.sentiment}</span>
              <p className="text-sm text-muted-foreground mt-1">{t.volume} volume</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SocialCreatorPipeline() {
  const creators = [
    { handle: "@downtownfoodiejen", followers: "42k", er: "5.2%", fee: "$220/post", status: "Shortlisted", note: "Asian food specialist, Downtown" },
    { handle: "@eatlocalmike", followers: "28k", er: "6.8%", fee: "$180/post", status: "Shortlisted", note: "High ER, hyperlocal audience" },
    { handle: "@citybitesblog", followers: "71k", er: "3.9%", fee: "$310/post", status: "In review", note: "Broader reach, food lifestyle" },
    { handle: "@tastetheblock", followers: "19k", er: "7.1%", fee: "$150/post", status: "Shortlisted", note: "Budget-friendly, great engagement" },
    { handle: "@lunchhourfoodie", followers: "33k", er: "4.6%", fee: "$200/post", status: "Pending contact", note: "Office lunch audience — perfect fit" },
  ];
  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-purple-50">
        <p className="text-sm font-semibold text-purple-700 uppercase tracking-wider">Creator / Influencer Pipeline</p>
      </div>
      {creators.map((c, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-pink-400 flex items-center justify-center flex-shrink-0">
            <span className="text-white text-sm font-bold">{c.handle[1].toUpperCase()}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{c.handle}</p>
            <p className="text-sm text-muted-foreground">{c.followers} · {c.er} ER · {c.note}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-sm font-semibold text-foreground">{c.fee}</p>
            <span className={cn("text-sm font-semibold px-1.5 py-0.5 rounded-full mt-0.5 inline-block",
              c.status === "Shortlisted" ? "bg-green-100 text-green-700" :
              c.status === "In review" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
            )}>{c.status}</span>
          </div>
        </div>
      ))}
      <div className="px-4 py-3 bg-muted/30">
        <Button size="sm" className="w-full text-sm">Approve Shortlist & Begin Outreach</Button>
      </div>
    </div>
  );
}

// ─── CUSTOMER SERVICE AGENT BLOCKS ────────────────────────────────────────────

function CsReputationSnapshot() {
  const platforms = [
    { name: "Google Maps", rating: 4.7, reviews: 28, delta: "+0.1", up: true, color: "text-blue-600" },
    { name: "Yelp", rating: 4.4, reviews: 14, delta: "Stable", up: null, color: "text-red-600" },
    { name: "Uber Eats", rating: 4.8, reviews: 12, delta: "+0.1", up: true, color: "text-green-700" },
    { name: "DoorDash", rating: 4.3, reviews: 8, delta: "−0.1", up: false, color: "text-orange-600" },
  ];
  return (
    <div className="mt-3 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {platforms.map((p) => (
          <div key={p.name} className="bg-background border border-border rounded-xl p-4">
            <p className={cn("text-sm font-semibold mb-2", p.color)}>{p.name}</p>
            <div className="flex items-baseline gap-1.5">
              <span className="font-serif text-2xl font-bold text-foreground">{p.rating}</span>
              <Star className="w-4 h-4 text-amber-400 fill-amber-400 mb-0.5" />
            </div>
            <Delta v={p.delta} up={p.up} />
            <p className="text-sm text-muted-foreground mt-1">{p.reviews} new reviews</p>
          </div>
        ))}
      </div>
      <div className="bg-background border border-border rounded-xl p-4">
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Sentiment Breakdown (All Platforms)</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          {[["Positive", "41", "text-green-600", "bg-green-50"], ["Neutral", "9", "text-muted-foreground", "bg-muted/40"], ["Negative", "2", "text-red-500", "bg-red-50"]].map(([l, v, tc, bg]) => (
            <div key={l} className={cn("rounded-lg py-3", bg)}>
              <p className={cn("text-2xl font-bold font-serif", tc)}>{v}</p>
              <p className="text-sm text-muted-foreground mt-0.5">{l}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CsComplaintTracker() {
  const complaints = [
    { platform: "DoorDash", issue: "Delivery wait time > 40 min", count: 2, status: "Escalated", statusColor: "bg-amber-100 text-amber-700", action: "DoorDash support contacted, compensation offered to both customers" },
    { platform: "Yelp", issue: "Soup packaging leaking", count: 1, status: "Resolved", statusColor: "bg-green-100 text-green-700", action: "Customer offered replacement + $10 credit. Packaging team notified." },
    { platform: "Google", issue: "Wrong item delivered", count: 1, status: "Resolved", statusColor: "bg-green-100 text-green-700", action: "Full refund + free re-delivery arranged." },
    { platform: "Uber Eats", issue: "Missing dipping sauce", count: 3, status: "Monitoring", statusColor: "bg-blue-100 text-blue-700", action: "Added to checklist. No negative reviews from these orders." },
  ];
  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-red-50">
        <p className="text-sm font-semibold text-red-700 uppercase tracking-wider flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> Delivery Complaint Tracker
        </p>
      </div>
      {complaints.map((c, i) => (
        <div key={i} className="px-4 py-3 border-b border-border last:border-0">
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <div>
              <span className="text-sm text-muted-foreground">{c.platform} · {c.count} {c.count === 1 ? "report" : "reports"}</span>
              <p className="text-sm font-semibold text-foreground">{c.issue}</p>
            </div>
            <span className={cn("text-sm font-semibold px-2 py-0.5 rounded-full flex-shrink-0", c.statusColor)}>{c.status}</span>
          </div>
          <p className="text-sm text-muted-foreground">→ {c.action}</p>
        </div>
      ))}
    </div>
  );
}

function CsWinBackCampaign() {
  return (
    <div className="mt-3 space-y-3">
      <div className="bg-teal-50 border border-teal-200 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="w-3.5 h-3.5 text-teal-700" />
          <p className="text-sm font-semibold text-teal-700">Win-Back Campaign Recommendation</p>
        </div>
        <p className="text-sm text-foreground/80 mb-3">
          <strong>398 customers</strong> are 45+ days inactive. Tiered approach recommended:
        </p>
        <div className="space-y-2 mb-3">
          {[
            ["Tier 1 — 142 High Value", "Free delivery + 10% off", "~$3,100 est. recovery"],
            ["Tier 2 — 189 Mid Value", "10% off COMEBACK10 code", "~$1,890 est. recovery"],
            ["Tier 3 — 67 Low Value", "5% off welcome back", "~$335 est. recovery"],
          ].map(([tier, offer, result]) => (
            <div key={tier} className="bg-white/70 rounded-lg px-3 py-2.5 flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-foreground">{tier}</p>
                <p className="text-sm text-muted-foreground">{offer}</p>
              </div>
              <span className="text-sm font-semibold text-teal-700 flex-shrink-0">{result}</span>
            </div>
          ))}
        </div>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700 text-white border-0 w-full">Launch Win-Back Campaign</Button>
      </div>
      <div className="bg-background border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Past Campaign Performance</p>
        </div>
        {[
          { campaign: "COMEBACK10 — March", sent: 215, opened: "34%", converted: "9%", revenue: "$1,935" },
          { campaign: "Free Delivery — February", sent: 180, opened: "28%", converted: "12%", revenue: "$2,160" },
          { campaign: "Loyalty Milestone SMS — Jan", sent: 640, opened: "22%", converted: "18%", revenue: "$3,840" },
        ].map((c, i) => (
          <div key={i} className="px-4 py-3 border-b border-border last:border-0">
            <p className="text-sm font-semibold text-foreground mb-2">{c.campaign}</p>
            <div className="grid grid-cols-4 gap-2">
              {[["Sent", `${c.sent}`], ["Open", c.opened], ["Conv.", c.converted], ["Revenue", c.revenue]].map(([l, v]) => (
                <div key={l} className="text-center">
                  <p className="text-sm text-muted-foreground">{l}</p>
                  <p className="text-sm font-semibold text-foreground">{v}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Hired-agent persistence (localStorage) ───────────────────────────────────

const HIRED_KEY = "favie_hired_agents";

const getHiredAgents = (): Set<string> =>
  new Set(JSON.parse(localStorage.getItem(HIRED_KEY) || "[]"));

const addHiredAgent = (agentId: string) => {
  const set = getHiredAgents();
  set.add(agentId);
  localStorage.setItem(HIRED_KEY, JSON.stringify([...set]));
  window.dispatchEvent(new CustomEvent("hired-agents-changed"));
};

function useHiredAgents() {
  const [hired, setHired] = useState<Set<string>>(getHiredAgents);
  useEffect(() => {
    const handler = () => setHired(getHiredAgents());
    window.addEventListener("hired-agents-changed", handler);
    return () => window.removeEventListener("hired-agents-changed", handler);
  }, []);
  return hired;
}

// ─── Payment Modal (used in both chat window and task market) ─────────────────

interface PayableTask { id: string; title: string; price: number; }

function PaymentModal({ task, onClose, onSuccess, successText }: {
  task: PayableTask;
  onClose: () => void;
  onSuccess: () => void;
  successText?: string;
}) {
  const { t } = useTranslation();
  const [paid, setPaid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [card, setCard] = useState({ number: "", expiry: "", cvc: "", name: "" });

  const formatCard = (v: string) => v.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
  const formatExpiry = (v: string) => {
    const d = v.replace(/\D/g, "").slice(0, 4);
    return d.length >= 3 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  };

  const handlePay = () => {
    setLoading(true);
    setTimeout(() => { setLoading(false); setPaid(true); }, 1200);
    setTimeout(() => onSuccess(), 2800);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={!paid ? onClose : undefined} />
      <div className="relative z-10 bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        {!paid ? (
          <>
            <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-border">
              <div>
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">{t("agents_page.payment_one_time_task")}</p>
                <p className="text-base font-bold text-foreground leading-snug">{task.title}</p>
              </div>
              <div className="text-right flex-shrink-0 ml-4">
                <p className="text-2xl font-bold text-primary">${task.price.toFixed(2)}</p>
              </div>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <Label className="text-sm text-muted-foreground mb-1.5 block">{t("agents_page.payment_card_number")}</Label>
                <div className="relative">
                  <Input
                    data-testid="input-card-number"
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
                  <Label className="text-sm text-muted-foreground mb-1.5 block">{t("agents_page.payment_expiry")}</Label>
                  <Input
                    data-testid="input-card-expiry"
                    placeholder="MM/YY"
                    value={card.expiry}
                    onChange={e => setCard(c => ({ ...c, expiry: formatExpiry(e.target.value) }))}
                    className="font-mono text-sm"
                    maxLength={5}
                  />
                </div>
                <div>
                  <Label className="text-sm text-muted-foreground mb-1.5 block">{t("agents_page.payment_cvc")}</Label>
                  <Input
                    data-testid="input-card-cvc"
                    placeholder="123"
                    value={card.cvc}
                    onChange={e => setCard(c => ({ ...c, cvc: e.target.value.replace(/\D/g, "").slice(0, 3) }))}
                    className="font-mono text-sm"
                    maxLength={3}
                  />
                </div>
              </div>
              <div>
                <Label className="text-sm text-muted-foreground mb-1.5 block">{t("agents_page.payment_name_on_card")}</Label>
                <Input
                  data-testid="input-card-name"
                  placeholder="Jane Smith"
                  value={card.name}
                  onChange={e => setCard(c => ({ ...c, name: e.target.value }))}
                  className="text-sm"
                />
              </div>
            </div>
            <div className="px-6 pb-6 space-y-3">
              <button
                data-testid="button-pay"
                onClick={handlePay}
                disabled={loading}
                className="w-full rounded-xl bg-primary text-primary-foreground text-sm font-semibold py-3 hover:bg-primary/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-70"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                {loading ? t("agents_page.payment_processing") : t("agents_page.payment_pay_btn", { amount: task.price.toFixed(2) })}
              </button>
              <p className="text-center text-sm text-muted-foreground flex items-center justify-center gap-1">
                <Lock className="w-3 h-3" /> {t("agents_page.payment_secured")}
              </p>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-9 h-9 text-green-600" />
            </div>
            <div>
              <p className="text-base font-bold text-foreground">{t("agents_page.payment_success")}</p>
              <p className="text-sm text-muted-foreground mt-1">{successText ?? t("agents_page.payment_launching")}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Agent Tasks, Themes & Intro Cards ───────────────────────────────────────

const AGENT_HIRE_PRICES: Record<AgentId, number> = {
  operation: 149, chef: 149, social: 149, customer: 149, finance: 149, legal: 199, expert: 999,
};

const AGENT_THEMES: Record<AgentId, {
  card: string; title: string; sub: string; sectionHead: string;
  label: string; desc: string; iconBg: string; iconText: string;
  iconBg2: string; iconText2: string; unlimitedBg: string; unlimitedText: string;
  unlimitedDot: string; priceText: string; btn: string;
  taskIconBgRgba: string; taskIconText: string; taskPriceText: string;
  taskGlow: string; taskGlowHired: string;
}> = {
  operation: {
    card: "border-blue-200 bg-blue-50", title: "text-blue-900", sub: "text-blue-600",
    sectionHead: "text-blue-400", label: "text-blue-800", desc: "text-blue-600",
    iconBg: "bg-blue-100", iconText: "text-blue-600",
    iconBg2: "bg-blue-50 border border-blue-100", iconText2: "text-blue-400",
    unlimitedBg: "bg-blue-100", unlimitedText: "text-blue-700", unlimitedDot: "bg-blue-500",
    priceText: "text-blue-700", btn: "bg-blue-600 hover:bg-blue-700",
    taskIconBgRgba: "rgba(37,99,235,0.13)", taskIconText: "text-blue-600", taskPriceText: "text-blue-600",
    taskGlow: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(37,99,235,0.22)",
    taskGlowHired: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(22,163,74,0.25)",
  },
  chef: {
    card: "border-amber-200 bg-amber-50", title: "text-amber-900", sub: "text-amber-600",
    sectionHead: "text-amber-400", label: "text-amber-800", desc: "text-amber-600",
    iconBg: "bg-amber-100", iconText: "text-amber-600",
    iconBg2: "bg-amber-50 border border-amber-100", iconText2: "text-amber-400",
    unlimitedBg: "bg-amber-100", unlimitedText: "text-amber-700", unlimitedDot: "bg-amber-500",
    priceText: "text-amber-700", btn: "bg-amber-600 hover:bg-amber-700",
    taskIconBgRgba: "rgba(245,158,11,0.13)", taskIconText: "text-amber-600", taskPriceText: "text-amber-600",
    taskGlow: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(217,119,6,0.22)",
    taskGlowHired: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(22,163,74,0.25)",
  },
  social: {
    card: "border-purple-200 bg-purple-50", title: "text-purple-900", sub: "text-purple-600",
    sectionHead: "text-purple-400", label: "text-purple-800", desc: "text-purple-600",
    iconBg: "bg-purple-100", iconText: "text-purple-600",
    iconBg2: "bg-purple-50 border border-purple-100", iconText2: "text-purple-400",
    unlimitedBg: "bg-purple-100", unlimitedText: "text-purple-700", unlimitedDot: "bg-purple-500",
    priceText: "text-purple-700", btn: "bg-purple-600 hover:bg-purple-700",
    taskIconBgRgba: "rgba(147,51,234,0.13)", taskIconText: "text-purple-600", taskPriceText: "text-purple-600",
    taskGlow: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(147,51,234,0.22)",
    taskGlowHired: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(22,163,74,0.25)",
  },
  customer: {
    card: "border-teal-200 bg-teal-50", title: "text-teal-900", sub: "text-teal-600",
    sectionHead: "text-teal-400", label: "text-teal-800", desc: "text-teal-600",
    iconBg: "bg-teal-100", iconText: "text-teal-600",
    iconBg2: "bg-teal-50 border border-teal-100", iconText2: "text-teal-400",
    unlimitedBg: "bg-teal-100", unlimitedText: "text-teal-700", unlimitedDot: "bg-teal-500",
    priceText: "text-teal-700", btn: "bg-teal-600 hover:bg-teal-700",
    taskIconBgRgba: "rgba(13,148,136,0.13)", taskIconText: "text-teal-600", taskPriceText: "text-teal-600",
    taskGlow: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(13,148,136,0.22)",
    taskGlowHired: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(22,163,74,0.25)",
  },
  finance: {
    card: "border-emerald-200 bg-emerald-50", title: "text-emerald-900", sub: "text-emerald-600",
    sectionHead: "text-emerald-400", label: "text-emerald-800", desc: "text-emerald-600",
    iconBg: "bg-emerald-100", iconText: "text-emerald-600",
    iconBg2: "bg-emerald-50 border border-emerald-100", iconText2: "text-emerald-400",
    unlimitedBg: "bg-emerald-100", unlimitedText: "text-emerald-700", unlimitedDot: "bg-emerald-500",
    priceText: "text-emerald-700", btn: "bg-emerald-600 hover:bg-emerald-700",
    taskIconBgRgba: "rgba(5,150,105,0.13)", taskIconText: "text-emerald-600", taskPriceText: "text-emerald-600",
    taskGlow: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(5,150,105,0.22)",
    taskGlowHired: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(22,163,74,0.25)",
  },
  legal: {
    card: "border-violet-200 bg-violet-50", title: "text-violet-900", sub: "text-violet-600",
    sectionHead: "text-violet-400", label: "text-violet-800", desc: "text-violet-600",
    iconBg: "bg-violet-100", iconText: "text-violet-600",
    iconBg2: "bg-violet-50 border border-violet-100", iconText2: "text-violet-400",
    unlimitedBg: "bg-violet-100", unlimitedText: "text-violet-700", unlimitedDot: "bg-violet-500",
    priceText: "text-violet-700", btn: "bg-violet-600 hover:bg-violet-700",
    taskIconBgRgba: "rgba(124,58,237,0.13)", taskIconText: "text-violet-600", taskPriceText: "text-violet-600",
    taskGlow: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(124,58,237,0.22)",
    taskGlowHired: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(22,163,74,0.25)",
  },
  expert: {
    card: "border-rose-200 bg-rose-50", title: "text-rose-900", sub: "text-rose-600",
    sectionHead: "text-rose-400", label: "text-rose-800", desc: "text-rose-600",
    iconBg: "bg-rose-100", iconText: "text-rose-600",
    iconBg2: "bg-rose-50 border border-rose-100", iconText2: "text-rose-400",
    unlimitedBg: "bg-rose-100", unlimitedText: "text-rose-700", unlimitedDot: "bg-rose-500",
    priceText: "text-rose-700", btn: "bg-rose-600 hover:bg-rose-700",
    taskIconBgRgba: "rgba(225,29,72,0.13)", taskIconText: "text-rose-600", taskPriceText: "text-rose-600",
    taskGlow: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(225,29,72,0.22)",
    taskGlowHired: "0 8px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(22,163,74,0.25)",
  },
};

const AGENT_HIRE_FEATURES: Record<AgentId, {
  proactive: { icon: React.ElementType; label: string; desc: string }[];
  onDemand:  { icon: React.ElementType; label: string; desc: string }[];
  taskCount: string;
}> = {
  operation: {
    proactive: [
      { icon: TrendingUp, label: "Tracks revenue and delivery metrics daily",     desc: "Monitors order volume, ROAS, and platform performance — flags any metric that drops outside your healthy range" },
      { icon: Zap,        label: "Optimizes ad spend in real time",               desc: "Adjusts your delivery ad budget based on hourly conversion patterns — cuts waste during low-traffic windows automatically" },
      { icon: BarChart2,  label: "Keeps your promotion performance live",         desc: "Monitors every active promotion's ROI and flags when ROAS drops below your breakeven threshold" },
    ],
    onDemand: [
      { icon: FileText,   label: "Instant performance reports",  desc: "Revenue breakdowns, ROAS comparisons, platform benchmarks — generated on demand with your exact data" },
      { icon: ListChecks, label: "Guided growth planning",       desc: "Budget reallocation plans, promotion mixes, and competitor positioning — ready in seconds, updated monthly" },
    ],
    taskCount: "All 5 tasks",
  },
  chef: {
    proactive: [
      { icon: TrendingUp, label: "Tracks food trends matching your cuisine",  desc: "Monitors TikTok, Instagram, and delivery search trends for dishes relevant to your menu style — sends you weekly signals" },
      { icon: Camera,     label: "Audits your menu photos",                   desc: "Scans all active menu item photos against conversion benchmarks — flags items where a photo update would improve orders" },
      { icon: Star,       label: "Monitors your top-performing items",        desc: "Tracks order volume and review sentiment per dish — surfaces items gaining or losing momentum each week" },
    ],
    onDemand: [
      { icon: FileText,   label: "Dish and description writing", desc: "Dish idea reports, seasonal menus, and SEO-optimized item descriptions — matched to your cuisine style and prep capability" },
      { icon: ListChecks, label: "Photo improvement guides",     desc: "Specific styling and reshooting instructions per item, benchmarked against top performers in your category" },
    ],
    taskCount: "All 4 tasks",
  },
  social: {
    proactive: [
      { icon: TrendingUp, label: "Tracks content performance across platforms", desc: "Monitors reach, engagement, saves, and follower growth across Instagram and TikTok — surfaces what's working each week" },
      { icon: Bell,       label: "Flags trending content opportunities",        desc: "Watches food trends, seasonal moments, and local events — alerts you before the peak so you can publish ahead of the curve" },
      { icon: BarChart2,  label: "Keeps your creator pipeline warm",           desc: "Tracks shortlisted KOL/KOC partnerships, past campaign ROI, and upcoming collaboration opportunities" },
    ],
    onDemand: [
      { icon: FileText,   label: "Content and campaign writing", desc: "Reels scripts, post captions, hashtag sets, influencer briefs, and 30-day content calendars — written to match your brand voice" },
      { icon: ListChecks, label: "Campaign performance reports", desc: "Post-campaign analytics summaries, audience growth breakdowns, and next-quarter content strategy — on demand" },
    ],
    taskCount: "All 4 tasks",
  },
  customer: {
    proactive: [
      { icon: Bell,       label: "Monitors all platform reviews in real time",  desc: "Tracks Google, Yelp, Uber Eats, and DoorDash reviews — sends an alert the moment a new negative review appears" },
      { icon: ShieldAlert, label: "Flags escalating complaint patterns",        desc: "Detects when the same issue appears multiple times across platforms — surfaces root cause and response recommendations" },
      { icon: BarChart2,  label: "Keeps your reputation score live",           desc: "Updates your platform ratings and response rate in real time so you always know exactly where you stand" },
    ],
    onDemand: [
      { icon: FileText,   label: "Review replies and customer responses", desc: "Professional, brand-consistent responses to negative reviews — personalized to the specific issue, ready to post" },
      { icon: ListChecks, label: "Retention campaigns",                   desc: "Win-back sequences for lapsed customers, loyalty program blueprints, and post-visit follow-up templates" },
    ],
    taskCount: "All 4 tasks",
  },
  finance: {
    proactive: [
      { icon: TrendingUp, label: "Monitors margin and profitability daily",       desc: "Tracks food cost %, labor cost %, and net margin — alerts you the moment any cost category exceeds your target" },
      { icon: Bell,       label: "Flags budget overruns before they compound",   desc: "Detects overtime spend, platform fee creep, and food cost spikes week by week — alerts you before the month closes" },
      { icon: BarChart2,  label: "Keeps your P&L dashboard current",             desc: "Updates your profitability snapshot in real time across all revenue channels — no waiting for your accountant" },
    ],
    onDemand: [
      { icon: FileText,   label: "Financial reports and analysis", desc: "P&L breakdowns, food cost analyses, cash flow projections, and tax prep checklists — generated with your exact data" },
      { icon: ListChecks, label: "Pricing and repricing plans",    desc: "Menu pricing formulas, margin improvement plans, and supplier cost reviews — ready whenever you need to make a pricing decision" },
    ],
    taskCount: "All 4 tasks",
  },
  legal: {
    proactive: [
      { icon: Bell,       label: "Monitors labor law changes",    desc: "Watches CA minimum wage, break rules, and overtime thresholds — sends an alert the moment something changes" },
      { icon: ShieldAlert, label: "Flags compliance gaps",        desc: "Scans your schedule and payroll data weekly, surfaces any I-9 gaps, break violations, or overdue certifications before they become liabilities" },
      { icon: BarChart2,  label: "Keeps your dashboard current", desc: "Updates your open HR risks in real time so you always know exactly where you stand, without asking" },
    ],
    onDemand: [
      { icon: FileText,   label: "Document generation",   desc: "Handbooks, warning letters, job descriptions, offer letters, termination checklists — generated in seconds, ready to sign" },
      { icon: ListChecks, label: "Guided HR workflows",   desc: "Step-by-step process for hiring, disciplining, and offboarding — legally correct every time, as many times as you need" },
    ],
    taskCount: "All 7 tasks",
  },
  expert: {
    proactive: [],
    onDemand: [],
    taskCount: "Unlimited",
  },
};

const AGENT_TASKS: Record<AgentId, { id: string; icon: React.ElementType; title: string; price: number; shortDesc: string }[]> = {
  operation: [
    { id: "delivery-ad-report",        icon: BarChart3,  title: "Delivery Ad Report",          price: 4.99, shortDesc: "Full platform performance with ROAS, CPC, and budget recommendations." },
    { id: "revenue-growth-analysis",   icon: TrendingUp, title: "Revenue Growth Analysis",     price: 9.99, shortDesc: "Monthly revenue breakdown with growth drivers and 3 specific action steps." },
    { id: "promo-mix-optimizer",       icon: Tag,        title: "Promo Mix Optimizer",         price: 4.99, shortDesc: "Best promotion mix for your platform, season, and customer base." },
    { id: "competitor-pricing-report", icon: BarChart2,  title: "Competitor Pricing Report",   price: 7.99, shortDesc: "Nearby competitor pricing and positioning with your recommended adjustments." },
    { id: "budget-rebalance-plan",     icon: RefreshCw,  title: "Budget Rebalance Plan",       price: 3.99, shortDesc: "Shift ad spend to your highest-ROAS hours with projected monthly savings." },
  ],
  chef: [
    { id: "new-dish-ideas",     icon: Star,        title: "New Dish Ideas",        price: 2.99, shortDesc: "4 trend-based dish ideas with readiness score and delivery photo tips." },
    { id: "menu-photo-review",  icon: Camera,      title: "Menu Photo Review",     price: 4.99, shortDesc: "Quality audit of every menu photo with specific fix recommendations." },
    { id: "seasonal-menu-plan", icon: CalendarDays, title: "Seasonal Menu Plan",   price: 9.99, shortDesc: "Full seasonal menu with pricing guidance and month-by-month rollout plan." },
    { id: "description-rewrite",icon: FileText,    title: "Description Rewrite",   price: 3.99, shortDesc: "SEO-optimized menu descriptions for all items, ready for any delivery platform." },
  ],
  social: [
    { id: "content-calendar", icon: CalendarDays, title: "30-Day Content Calendar",      price: 4.99, shortDesc: "Daily post plan with captions, hashtags, and optimal posting times." },
    { id: "influencer-brief", icon: Users,        title: "Influencer Brief",             price: 3.99, shortDesc: "KOL/KOC outreach package with pitch, talking points, and deliverables." },
    { id: "reels-script",     icon: Video,        title: "Reels Script",                 price: 2.99, shortDesc: "60-second promotional video script with shot list and CTA." },
    { id: "campaign-report",  icon: BarChart3,    title: "Campaign Performance Report",  price: 9.99, shortDesc: "Social performance analysis with audience insights and next-quarter action plan." },
  ],
  customer: [
    { id: "review-reply-set",       icon: Star,          title: "Review Reply Templates",   price: 1.99, shortDesc: "3 ready-to-post replies (short/medium/full) for any negative review." },
    { id: "win-back-campaign",      icon: Users,         title: "Win-Back Campaign",         price: 4.99, shortDesc: "Re-engagement sequence for lapsed customers with tiered promo plan." },
    { id: "complaint-response",     icon: MessageSquare, title: "Complaint Response Letter", price: 2.99, shortDesc: "Professional, ready-to-post reply to any specific complaint or bad review." },
    { id: "loyalty-program-design", icon: ListChecks,    title: "Loyalty Program Blueprint", price: 9.99, shortDesc: "Tier-based loyalty program design with rewards, earn rules, and launch plan." },
  ],
  finance: [
    { id: "pl-analysis",         icon: BarChart3,  title: "P&L Analysis",        price: 9.99, shortDesc: "Monthly profit & loss with margin breakdown, benchmarks, and action items." },
    { id: "food-cost-optimizer", icon: DollarSign, title: "Food Cost Optimizer",  price: 4.99, shortDesc: "Menu cost analysis and pricing formula to hit your target gross margin." },
    { id: "cash-flow-forecast",  icon: TrendingUp, title: "Cash Flow Forecast",   price: 7.99, shortDesc: "90-day cash flow projection with risk flags and timing recommendations." },
    { id: "tax-prep-checklist",  icon: FileText,   title: "Tax Prep Checklist",   price: 3.99, shortDesc: "Restaurant-specific quarterly tax prep with deductions, deadlines, and notes." },
  ],
  legal: [
    { id: "labor-compliance",     icon: Scale,         title: "CA Labor Law Compliance Check", price: 1.99,  shortDesc: "Current CA minimum wage, compliance checklist & accountant summary." },
    { id: "employee-handbook",    icon: FileText,      title: "Employee Handbook Generator",   price: 19.99, shortDesc: "A full CA-compliant employee handbook with attendance, dress code, and tip policies." },
    { id: "job-description",      icon: PenLine,       title: "Job Description Writer",        price: 2.99,  shortDesc: "Ready-to-post hiring copy optimized for Indeed and Craigslist." },
    { id: "disciplinary-warning", icon: AlertTriangle, title: "Disciplinary Warning Letter",   price: 3.99,  shortDesc: "Formal CA-compliant written warning — printable and ready to sign." },
    { id: "termination-checklist",icon: ClipboardList, title: "CA Termination Checklist",      price: 4.99,  shortDesc: "Every CA legal step for offboarding — final pay, COBRA, notices, and property return." },
    { id: "onboarding-schedule",  icon: GraduationCap, title: "New Hire Onboarding Schedule", price: 4.99,  shortDesc: "Two-week day-by-day training plan with tasks, trainers, and learning goals." },
    { id: "lease-negotiation",    icon: Building2,     title: "Lease Negotiation Package",     price: 24.99, shortDesc: "Market-data-backed negotiation strategy with talking points and attorney checklist." },
  ],
  expert: [],
};

function AgentIntroContent({ agentId, agentName, onTaskClick, onHireClick, hired }: {
  agentId: AgentId;
  agentName: string;
  onTaskClick: (task: PayableTask) => void;
  onHireClick: () => void;
  hired: boolean;
}) {
  const { t: tFn } = useTranslation();
  const t = AGENT_THEMES[agentId];
  const f = useAgentHireFeatures(agentId);
  const tasks = useAgentTasks(agentId);
  const price = AGENT_HIRE_PRICES[agentId];
  return (
    <div className="mt-3 space-y-3 w-full">
      {/* Hire card */}
      <div className={cn("rounded-2xl border p-6 space-y-4", t.card)}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <p className={cn("text-base font-bold", t.title)}>{agentName}</p>
              {hired && (
                <span className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide bg-green-100 text-green-700 border border-green-200 rounded-full px-2 py-0.5 leading-none">
                  <CheckCircle2 className="w-3 h-3" /> {tFn("agents_page.intro_active_badge")}
                </span>
              )}
            </div>
            <p className={cn("text-sm mt-0.5", t.sub)}>
              {hired ? tFn("agents_page.intro_subscribed_sub") : tFn("agents_page.intro_always_on")}
            </p>
          </div>
          <div className="text-right flex-shrink-0">
            {hired ? (
              <p className="text-sm font-semibold text-green-600">${price} {tFn("agents_page.intro_per_mo")}</p>
            ) : (
              <>
                <p className={cn("text-2xl font-bold", t.priceText)}>${price}</p>
                <p className={cn("text-sm", t.sub)}>{tFn("agents_page.intro_per_month")}</p>
              </>
            )}
          </div>
        </div>

        {/* Proactive section */}
        <div>
          <p className={cn("text-sm font-semibold uppercase tracking-wider mb-2", t.sectionHead)}>{tFn("agents_page.intro_proactive_heading")}</p>
          <div className="space-y-2.5">
            {f.proactive.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex gap-3">
                <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5", t.iconBg)}>
                  <Icon className={cn("w-3.5 h-3.5", t.iconText)} />
                </div>
                <div>
                  <span className={cn("text-sm font-semibold", t.label)}>{label} — </span>
                  <span className={cn("text-sm", t.desc)}>{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* On-demand section */}
        <div>
          <p className={cn("text-sm font-semibold uppercase tracking-wider mb-2", t.sectionHead)}>{tFn("agents_page.intro_ondemand_heading")}</p>
          <div className="space-y-2.5">
            {f.onDemand.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex gap-3">
                <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5", t.iconBg2)}>
                  <Icon className={cn("w-3.5 h-3.5", t.iconText2)} />
                </div>
                <div>
                  <span className={cn("text-sm font-semibold", t.label)}>{label} — </span>
                  <span className={cn("text-sm", t.desc)}>{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Unlimited badge */}
        <div className={cn("flex items-center gap-2 rounded-xl px-4 py-2.5", t.unlimitedBg)}>
          <div className={cn("w-2 h-2 rounded-full flex-shrink-0", t.unlimitedDot)} />
          <p className={cn("text-sm font-medium", t.unlimitedText)}>{f.taskCount} {tFn("agents_page.intro_run_unlimited")}</p>
        </div>

        {hired ? (
          <div className="flex items-center gap-2 rounded-xl bg-green-50 border border-green-200 px-4 py-3">
            <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
            <p className="text-sm font-medium text-green-700">{tFn("agents_page.intro_subscribed_badge")}</p>
          </div>
        ) : (
          <button
            data-testid={`button-hire-${agentId}-agent`}
            onClick={onHireClick}
            className={cn("w-1/2 mx-auto block rounded-xl text-white text-sm font-semibold py-3 transition-colors", t.btn)}
          >
            {tFn("agents_page.intro_hire_btn", { price })}
          </button>
        )}
      </div>

      {tasks.length > 0 && <>
      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-sm text-muted-foreground">{hired ? tFn("agents_page.intro_run_any_task") : tFn("agents_page.intro_run_single_task")}</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Task cards */}
      <div className="grid grid-cols-3 gap-3">
        {tasks.map((task) => {
          const Icon = task.icon;
          return (
            <button
              key={task.id}
              data-testid={`chat-task-card-${task.id}`}
              onClick={() => onTaskClick(task)}
              className="group text-left bg-white rounded-2xl p-4 flex flex-col gap-3 relative transition-all duration-200 hover:-translate-y-0.5"
              style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.05)" }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.boxShadow = hired ? t.taskGlowHired : t.taskGlow;
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.05)";
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: hired ? "rgba(22,163,74,0.13)" : t.taskIconBgRgba }}>
                  <Icon size={18} className={hired ? "text-green-600" : t.taskIconText} />
                </div>
                <div className="flex flex-col items-end gap-1">
                  {hired ? (
                    <span className="text-xs font-semibold text-green-600 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 leading-none">Free</span>
                  ) : (
                    <span className={cn("text-sm font-bold tabular-nums", t.taskPriceText)}>${task.price.toFixed(2)}</span>
                  )}
                </div>
              </div>
              <p className="text-sm font-semibold text-gray-800 leading-snug">{task.title}</p>
              <p className="text-xs text-gray-400 leading-relaxed line-clamp-2 flex-1">{task.shortDesc}</p>
            </button>
          );
        })}
      </div>
      </>}
    </div>
  );
}

// ─── Agent Task Prompts & Contexts ────────────────────────────────────────────

const AGENT_TASK_PROMPTS: Record<AgentId, Record<string, string>> = {
  operation: {
    "delivery-ad-report":        "Your Delivery Ad Report is ready to generate. To tailor it to your restaurant, I need a few quick details:\n\n- **Which platforms are you on?** (Uber Eats, DoorDash, or both)\n- **What's your current monthly ad budget cap?**\n- **What's your target ROAS or cost-per-order goal?**",
    "revenue-growth-analysis":   "Ready to run your Revenue Growth Analysis. Quick questions:\n\n- **What's your approximate monthly revenue?**\n- **What's your main sales channel?** (delivery, dine-in, or both)\n- **Any specific area to focus on?** (e.g., delivery platforms, specific time period)",
    "promo-mix-optimizer":       "Ready to build your Promotion Mix Plan. A few details:\n\n- **Which platforms do you run promotions on?**\n- **What promotions have you run in the past 3 months?**\n- **What's your monthly promo budget?**",
    "competitor-pricing-report": "Ready to generate your Competitor Pricing Report. To make it specific:\n\n- **What neighborhood or area is your restaurant in?**\n- **What cuisine type do you serve?**\n- **Any specific competitors you want included?**",
    "budget-rebalance-plan":     "Ready to build your Budget Rebalance Plan. Quick questions:\n\n- **What are your current weekly ad spend caps?** (per platform if different)\n- **What are your peak service hours?** (e.g., lunch 12–2pm, dinner 6–9pm)\n- **What's your current ROAS target?**",
    "schedule-optimizer":        "Your Schedule Optimizer is ready to run. To build the most accurate weekly plan:\n\n- **List your team: roles and headcount** (e.g., 2 managers, 4 servers, 2 cooks, 1 dishwasher)\n- **What are your operating hours?** (e.g., Mon–Thu 11am–10pm, Fri–Sun 10am–11pm)\n- **What are your peak service windows?** (e.g., Fri–Sat dinner 6–9pm, Sunday brunch 10am–1pm)",
    "open-close-checklist":      "Your Opening & Closing Checklist is ready to generate. Quick questions:\n\n- **What type of restaurant is this?** (casual dining, fast-casual, fine dining, bar, café…)\n- **What roles do you need checklists for?** (e.g., Manager, Server, Cook, Bartender, Host)",
    "health-inspection":         "Your Health Inspection Prep guide is ready. A few details:\n\n- **What city or county is your restaurant in?**\n- **What type of restaurant?** (full-service, fast-casual, food truck, bakery…)\n- **Any violations from your last inspection?** (optional — paste them or leave blank)",
    "vendor-rfq":                "Your Vendor RFQ document is ready to write. Quick questions:\n\n- **What products are you sourcing?** (e.g., meat & poultry, produce, dry goods, beverages)\n- **What's your estimated monthly purchase volume?** (dollar amount or by weight)",
    "pos-vendor-comparison":     "Your POS System Comparison report is ready. To tailor it:\n\n- **What POS system are you currently using (if any)?**\n- **What's your monthly POS cost?**\n- **What's your restaurant type?** (full-service, fast-casual, fine dining, food truck)\n- **What are your top pain points with your current setup?**",
    "labor-utilization":         "Your Labor Utilization Analysis is ready to run. Quick questions:\n\n- **Describe your team: roles and headcount** (e.g., 3 full-time servers, 2 part-time, 2 line cooks…)\n- **What are your operating hours?**\n- **What are your busiest periods?**\n- **What's your current labor cost %?**",
    "supplier-comparison":       "Your Multi-Supplier Price Comparison is ready to build. To run it:\n\n- **What product category should I focus on?** (meat, produce, seafood, dry goods…)\n- **List your current supplier(s) and key prices** (e.g., Supplier A: chicken breast $3.40/lb, ground beef $4.10/lb)\n- **What's your estimated monthly spend in this category?**",
    "channel-expansion":         "Your Expansion Playbook is ready to build. A few details:\n\n- **What's your current revenue mix?** (e.g., 70% dine-in, 20% delivery, 10% catering)\n- **Which channel do you want to grow?** (takeout/delivery, private dining, off-site catering, or both)\n- **What's your target revenue increase?** (e.g., +$8k/month, or +20%)",
  },
  chef: {
    "new-dish-ideas":     "Your New Dish Ideas report is ready to generate. To make the recommendations specific to your restaurant:\n\n- **What cuisine type do you serve?**\n- **What's your price range per dish?** (budget, mid-range, upscale)\n- **Any dietary preferences or restrictions to consider?** (e.g., vegetarian, halal, gluten-free)",
    "menu-photo-review":  "Ready to audit your menu photos. To give you specific recommendations:\n\n- **How many menu items do you currently have?**\n- **Do you have professional photos, DIY, or stock images?**\n- **What are your 3 best-selling items?**",
    "seasonal-menu-plan": "Ready to build your Seasonal Menu Plan. A few details:\n\n- **What season are you planning for?** (spring/summer/fall/winter)\n- **What cuisine type do you serve?**\n- **Do you want new dishes, or seasonal variations of existing ones?**",
    "description-rewrite":"Ready to rewrite your menu item descriptions. To do this right:\n\n- **Paste the current descriptions you want to improve** (or list the item names)\n- **What's the platform you're targeting?** (Uber Eats, DoorDash, your website, or all)\n- **What tone are you going for?** (casual, upscale, homestyle…)",
    "menu-engineering":   "Your Menu Engineering Analysis is ready to run. To complete it:\n\n- **Paste your menu items with prices** (one per line: Item Name $Price)\n- **Include as many items as you want** — the more items, the more complete the Stars / Plow Horses / Puzzles / Dogs matrix",
    "recipe-scaler":      "Your Recipe Scaler is ready. Just share:\n\n- **Paste your original recipe** (ingredient + quantity, one per line, plus the original yield)\n- **What's your target number of portions?**",
    "seasonal-menu":      "Your Seasonal Menu Planner is ready to generate. Quick questions:\n\n- **What cuisine type or restaurant style do you have?**\n- **Which season are you planning for?** (spring / summer / fall / winter)\n- **What's your target food cost per serving?**",
    "allergen-audit":     "Your Allergen Audit is ready to run. To generate the full matrix:\n\n- **Paste your menu with main ingredients** (one dish per line — e.g., Caesar Salad — romaine, parmesan, croutons, anchovy dressing)\n- The more ingredient detail you provide, the more accurate the 8-allergen matrix",
    "staff-meal":         "Your Staff Meal Planner is ready to create. Quick questions:\n\n- **How many staff do you feed per day?**\n- **What ingredients or kitchen trim is commonly available?** (e.g., chicken backs, vegetable trim, day-old bread)\n- **What's your daily budget per person?**",
    "menu-description":   "Your Menu Description Writer is ready. To get the best copy:\n\n- **Paste your dish names and any brief notes** (e.g., Seared Duck Breast — cherry gastrique, root vegetable puree)\n- **What tone are you going for?** (warm & approachable, upscale & evocative, fun & casual)",
  },
  social: {
    "content-calendar":    "Your 30-Day Content Calendar is ready to build. Quick questions:\n\n- **Which platforms do you post on?** (Instagram, TikTok, Facebook…)\n- **How often do you currently post per week?**\n- **Any upcoming events, specials, or promotions to feature?**",
    "influencer-brief":    "Ready to write your Influencer Brief. A few details:\n\n- **What type of creator are you looking for?** (local food influencer, lifestyle, family…)\n- **What's your budget range for one collaboration?**\n- **What do you want the creator to focus on?** (new dish, general brand, specific promotion)",
    "reels-script":        "Your Reels Script is ready to write. Quick questions:\n\n- **What dish or product is this Reel about?**\n- **What's the goal?** (drive orders, show behind-the-scenes, announce something new)\n- **What tone?** (fun/casual, satisfying food shots, story-driven)",
    "campaign-report":     "Ready to generate your Campaign Performance Report. A few details:\n\n- **Which campaign or time period should I analyze?** (e.g., last 30 days, a specific promotion)\n- **Which platforms did you run the campaign on?**\n- **What was your main goal?** (follower growth, delivery orders, brand awareness)",
    "social-media-pack":   "Your 7-Day Social Media Content Pack is ready to build. Quick questions:\n\n- **What are your featured dishes or signature items this week?**\n- **Any events or promotions running this week?** (happy hour, live music, brunch specials…)\n- **Which platforms do you post on?** (Instagram, Facebook, TikTok, or all)",
    "gbp-optimizer":       "Your Google Business Profile optimization is ready. To write the best description:\n\n- **Brief description of your restaurant** (cuisine, vibe, what you're known for)\n- **Signature dishes or standout features**\n- **What neighborhood are you in, and what's nearby?**",
    "email-newsletter":    "Your Monthly Email Newsletter is ready to write. Quick questions:\n\n- **What's new this month?** (new dishes, menu changes, seasonal updates)\n- **Any events or promotions this month?**\n- **Any story or highlight to feature?** (chef update, milestone, community involvement — optional)",
    "grand-opening":       "Your Grand Opening Announcement pack is ready to create. Quick questions:\n\n- **What's your opening date?**\n- **What's your restaurant address?**\n- **What makes your restaurant special?** (3–5 key selling points)",
    "promo-designer":      "Your Promotion campaign is ready to design. Quick questions:\n\n- **What's the time slot for this promotion?** (e.g., Mon–Fri 3–6pm, or all day Tuesday)\n- **What's your primary goal?** (drive foot traffic, move inventory, bring back lapsed customers, increase check size)",
    "local-acquisition":   "Your Local Customer Acquisition Strategy is ready to build. Quick questions:\n\n- **What's your restaurant neighborhood or address?**\n- **What cuisine type do you serve?**\n- **What's your price range per person?** (under $15, $15–$30, $30–$60, $60+)\n- **Who is your current main customer profile?**\n- **What's your primary growth goal?** (more lunch traffic, new dinner customers, grow delivery, build catering pipeline)",
  },
  customer: {
    "review-reply-set":       "Ready to write your Review Reply Templates. Quick questions:\n\n- **Paste the review or describe the complaint type** you want me to respond to\n- **What's your preferred tone?** (warm and apologetic, professional, brief and solution-focused)\n- **What resolution did you offer, if any?** (refund, replacement, discount)",
    "win-back-campaign":      "Your Win-Back Campaign is ready to design. A few details:\n\n- **How many lapsed customers do you have?** (approximate)\n- **How long since they last ordered?** (30, 60, or 90+ days?)\n- **What promotion are you willing to offer?** (free delivery, % discount, free item)",
    "complaint-response":     "Ready to write your Complaint Response. Quick questions:\n\n- **Paste the customer complaint** (review text, email, or DM)\n- **Which platform is this on?** (Google, Yelp, DoorDash, Uber Eats, direct message)\n- **What resolution have you already offered, if any?**",
    "loyalty-program-design": "Your Loyalty Program Blueprint is ready to build. A few details:\n\n- **What's your average order value?**\n- **Do you prefer a points-based, tier-based, or stamp card system?**\n- **What rewards are you willing to offer?** (free items, discounts, exclusive perks)",
    "review-reply":           "Your Review Reply Templates are ready to write. Quick questions:\n\n- **Paste the customer review** you want to respond to\n- **What's your preferred tone?** (warm & empathetic, professional & formal, brief & direct)",
    "faq-generator":          "Your FAQ Page is ready to generate. A few details:\n\n- **What type of restaurant are you?** (e.g., Japanese ramen, upscale Italian, fast-casual Mexican)\n- **What topics should I cover?** (reservations, parking, delivery, dietary needs, allergens, private events…)",
    "complaint-email":        "Your Complaint Response email is ready to write. Quick questions:\n\n- **Paste the customer's complaint**\n- **Briefly describe what happened on your side** (staffing issue, kitchen delay, miscommunication…)",
    "reservation-policy":     "Your Reservation Policy is ready to write. Quick questions:\n\n- **Do you accept reservations?** (phone & online / phone only / walk-in only / large parties only)\n- **What's your maximum party size?**\n- **What's your no-show or late cancellation policy?**",
    "loyalty-program":        "Your Loyalty Program design is ready to build. A few details:\n\n- **What's your average check per guest?**\n- **How often do you want customers to return?** (monthly, 2–3x/month, weekly)\n- **What rewards are you willing to offer?** (% back, free item, exclusive perks)",
  },
  finance: {
    "pl-analysis":            "Your P&L Analysis is ready to generate. To make it accurate:\n\n- **What was your total revenue this month?**\n- **What's your approximate food cost %?** (or dollar amount)\n- **What's your labor cost % or dollar amount?**",
    "food-cost-optimizer":    "Your Food Cost Optimizer is ready to run. Quick questions:\n\n- **What's your current food cost %?** (target is typically 28–33%)\n- **What are your 3–5 highest-volume menu items?**\n- **What's your target gross margin?** (e.g., 65–70%)",
    "cash-flow-forecast":     "Ready to build your Cash Flow Forecast. A few details:\n\n- **What's your average monthly revenue?**\n- **What are your main fixed monthly expenses?** (rent, payroll, utilities — approximate is fine)\n- **Any upcoming large expenses in the next 90 days?**",
    "tax-prep-checklist":     "Your Tax Prep Checklist is ready to generate. A few quick questions:\n\n- **What quarter are you preparing for?**\n- **Do you file as sole proprietor, LLC, S-corp, or other?**\n- **Any specific deductions you want included?** (equipment, renovation, vehicle use…)",
    "food-cost-benchmark":    "Your Food Cost Benchmark is ready to run. Quick questions:\n\n- **What's your current food cost percentage?**\n- **What's your monthly revenue range?** (under $30k / $30–60k / $60–100k / $100–200k / over $200k)",
    "break-even":             "Your Break-Even Calculator is ready. Quick questions:\n\n- **What's your monthly rent or occupancy cost?**\n- **Monthly labor cost?** (wages + payroll taxes)\n- **Food cost percentage?**\n- **Average check per guest?** (after tax, before tip)",
    "catering-quote":         "Your Catering Quote is ready to generate. Quick questions:\n\n- **How many guests?**\n- **What's the menu style?** (buffet / plated sit-down / heavy appetizers / box lunch)\n- **Brief description of the menu or theme**\n- **Client's target budget per person?**",
    "price-increase-letter":  "Your Price Increase Letter is ready to write. Quick questions:\n\n- **How much are prices going up?** (percentage or dollar amount per item)\n- **What are the main reasons?** (rising food costs, rent increases, labor costs, or all of the above)\n- **What's your restaurant's tone?** (casual & friendly / warm & family-oriented / professional & upscale)",
    "dish-cost-card":         "Your Dish Cost Card is ready to calculate. Quick questions:\n\n- **What dish is this for?**\n- **List every ingredient, quantity, and unit cost** (e.g., Salmon fillet, 6 oz, $1.80/oz)\n- **What's your current menu price?** (optional — I'll tell you if it's on target)",
    "pricing-formula":        "Your Revenue Pricing Formula is ready to build. Quick questions:\n\n- **What's your current average check per guest?**\n- **What's your current food cost percentage?**\n- **What's your current monthly revenue?**\n- **How many seats do you have?**\n- **What's your average weekly covers (guests served)?**",
  },
  legal: {
    "labor-compliance":     "Your CA Labor Law Compliance Check is ready to run. To generate your personalized report, I just need a few quick details:\n\n- **How many employees do you have?** (full-time and part-time separately)\n- **What's your average hourly wage?**\n- **Which city is your restaurant in?**",
    "employee-handbook":    "Your Employee Handbook is ready to build. To tailor it correctly, tell me:\n\n- **What's your restaurant's service style?** (fast-casual, full-service, counter service…)\n- **How many employees do you have?**\n- **One location or multiple?**",
    "job-description":      "Ready to write your job description. Just answer these:\n\n- **What role are you hiring for?**\n- **What experience level and pay range are you looking for?**\n- **Any required certifications, schedule preferences, or specific skills to include?**",
    "disciplinary-warning": "Ready to draft the disciplinary warning letter. I need a few details:\n\n- **Employee's name and their role?**\n- **What was the specific violation or incident, and when did it occur?**\n- **Is this their first, second, or third written warning?**",
    "termination-checklist":"Ready to generate your termination checklist. Tell me:\n\n- **Employee's name and their last day of work?**\n- **Voluntary resignation or employer-initiated termination?**\n- **Any specific equipment, keys, or system access to include in the return list?**",
    "onboarding-schedule":  "Ready to build your onboarding schedule. Quick questions:\n\n- **What role is the new hire starting in?**\n- **What's their start date?**\n- **Front-of-house, back-of-house, or management?**",
    "lease-negotiation":    "Ready to build your Lease Negotiation Package. A few details:\n\n- **What type of space is this?** (new location, renewal, or expansion?)\n- **What's the proposed monthly rent and lease term?**\n- **Any specific clauses or issues you want to negotiate?**",
  },
  expert: {},
};

const AGENT_TASK_CONTEXTS: Record<AgentId, Record<string, string>> = {
  operation: {
    "delivery-ad-report":        "The user has purchased the 'Delivery Ad Report' task. Using the data they provide, generate a comprehensive delivery platform performance report including: ROAS by platform, cost-per-order analysis, peak vs. off-peak efficiency breakdown, and specific budget recommendations.",
    "revenue-growth-analysis":   "The user has purchased the 'Revenue Growth Analysis' task. Using the data they provide, generate a detailed monthly revenue analysis including: growth rate breakdown, channel contribution, trend patterns, and 3 specific action recommendations.",
    "promo-mix-optimizer":       "The user has purchased the 'Promo Mix Optimizer' task. Using the data they provide, generate a complete promotion mix recommendation including: promotion type ranking by ROI, platform-specific suggestions, timing recommendations, and a 30-day promotion calendar.",
    "competitor-pricing-report": "The user has purchased the 'Competitor Pricing Report' task. Using the data they provide, generate a competitive pricing analysis including: nearby competitor menu price comparison, price positioning recommendations, and suggested price adjustments.",
    "budget-rebalance-plan":     "The user has purchased the 'Budget Rebalance Plan' task. Using the data they provide, generate an optimized ad budget allocation plan including: hourly spend efficiency analysis, recommended daily/weekly cap adjustments, and projected savings.",
    "schedule-optimizer":        "The user has purchased the 'Schedule Optimizer' task. Using the data they provide, generate a complete optimized weekly staff schedule including: a day-by-day shift table by role, estimated weekly labor cost, overtime risk flags, and 2–3 specific staffing adjustments to reduce cost.",
    "open-close-checklist":      "The user has purchased the 'Opening & Closing Checklist' task. Using the data they provide, generate role-specific opening and closing checklists formatted with checkbox items, organized by role, ready to print and post in the restaurant.",
    "health-inspection":         "The user has purchased the 'Health Inspection Prep' task. Using the data they provide, generate a comprehensive inspection prep checklist organized by inspector scoring categories, including: common point deductions per area, corrective actions for each issue, and a final day-of checklist.",
    "vendor-rfq":                "The user has purchased the 'Vendor RFQ Template' task. Using the data they provide, generate a complete professional Request for Quote document including: product specifications, vendor qualification criteria, pricing format table, delivery requirements, payment terms, and evaluation criteria.",
    "pos-vendor-comparison":     "The user has purchased the 'POS & Vendor System Comparison' task. Using the data they provide, generate a scored comparison of 10+ POS systems across 8 criteria (pricing, features, integrations, hardware, support, delivery compatibility, reporting, contract flexibility), with a clear recommendation and vendor negotiation checklist.",
    "labor-utilization":         "The user has purchased the 'Labor Utilization Analysis' task. Using the data they provide, generate an hour-by-hour labor efficiency analysis including: staffing vs. demand by time slot, overstaffed and understaffed windows, dollar impact of each gap, and prioritized scheduling changes ranked by savings.",
    "supplier-comparison":       "The user has purchased the 'Multi-Supplier Price Comparison' task. Using the data they provide, generate a side-by-side price benchmarking report including: current price vs. wholesale market rate per item, estimated monthly overpayment, alternative supplier suggestions, and a ready-to-use negotiation script for the next supplier call.",
    "channel-expansion":         "The user has purchased the 'Takeout & Banquet Expansion Plan' task. Using the data they provide, generate a full 90-day channel expansion playbook including: market opportunity sizing, step-by-step launch milestones, pricing and packaging recommendations, required operational changes, and 6-month revenue projections.",
  },
  chef: {
    "new-dish-ideas":     "The user has purchased the 'New Dish Ideas' task. Using the data they provide, generate 4 specific new dish recommendations including: dish name, trend rationale, ingredient readiness, estimated food cost, pricing suggestion, and a photo styling tip for each.",
    "menu-photo-review":  "The user has purchased the 'Menu Photo Review' task. Using the data they provide, generate a comprehensive photo quality audit including: score per item (1–5), specific issue identified, and detailed reshooting/styling instructions.",
    "seasonal-menu-plan": "The user has purchased the 'Seasonal Menu Plan' task. Using the data they provide, generate a complete seasonal menu plan including: 6–8 dish recommendations with descriptions, pricing guidance, and a month-by-month rollout suggestion.",
    "description-rewrite":"The user has purchased the 'Description Rewrite' task. Using the data they provide, generate SEO-optimized, platform-ready menu item descriptions using sensory language, benefit-driven framing, and appropriate length for the target platform.",
    "menu-engineering":   "The user has purchased the 'Menu Engineering Analysis' task. Using the menu they provide, classify every item into Stars (high profit, high popularity), Plow Horses (low profit, high popularity), Puzzles (high profit, low popularity), or Dogs (low profit, low popularity). Output a formatted matrix, then provide specific recommendations: items to promote, reprice, reposition, or retire.",
    "recipe-scaler":      "The user has purchased the 'Recipe Scaler' task. Using the recipe they provide, scale every ingredient to the target portion count with accurate unit conversions. Flag any ingredients that don't scale linearly (e.g., salt, leavening agents, seasoning) with adjustment notes.",
    "seasonal-menu":      "The user has purchased the 'Seasonal Menu Planner' task. Using the data they provide, generate 8–12 seasonal dish ideas with: creative dish name, menu-ready description, core ingredients, estimated food cost per serving, suggested retail price, and a note on presentation.",
    "allergen-audit":     "The user has purchased the 'Allergen Audit' task. Using the menu they provide, identify all 8 major allergens (milk, eggs, fish, shellfish, tree nuts, peanuts, wheat, soybeans) per dish in a formatted matrix table, then write a compliance-ready allergen disclosure statement for their menu or website.",
    "staff-meal":         "The user has purchased the 'Staff Meal Planner' task. Using the data they provide, create a 5-day staff meal plan using trim and leftover prep ingredients, with: daily meal name, key ingredients used, estimated cost per person, and a brief preparation note for each day.",
    "menu-description":   "The user has purchased the 'Menu Description Writer' task. Using the dish names and notes they provide, write polished, appetite-inspiring 1–3 sentence descriptions in the requested style, plus a brief style guide note for future consistency.",
  },
  social: {
    "content-calendar":    "The user has purchased the '30-Day Content Calendar' task. Using the data they provide, generate a complete 30-day social media content calendar including: post type, platform, caption, hashtags, and best posting time for each day.",
    "influencer-brief":    "The user has purchased the 'Influencer Brief' task. Using the data they provide, generate a complete creator outreach package including: influencer profile criteria, personalized pitch message, key talking points, deliverables, compensation structure, and usage rights.",
    "reels-script":        "The user has purchased the 'Reels Script' task. Using the data they provide, generate a complete 60-second Reels script including: hook (0–3s), core content (3–50s), and CTA (50–60s), with shot descriptions and optional voiceover text.",
    "campaign-report":     "The user has purchased the 'Campaign Performance Report' task. Using the data they provide, generate a comprehensive campaign analysis including: performance vs. benchmarks, what worked and what didn't, audience insights, and a next-campaign action plan.",
    "social-media-pack":   "The user has purchased the 'Social Media Content Pack' task. Using the data they provide, generate a full 7-day social media content calendar including: post type (Reel / Story / Carousel / Static), platform, caption, hashtag set, and optimal posting time for each day.",
    "gbp-optimizer":       "The user has purchased the 'Google Business Profile Optimizer' task. Using the data they provide, generate: (1) an SEO-optimized Google Business description under 750 characters, (2) a recommended categories and attributes checklist, and (3) 3 ready-to-post Google Posts ideas.",
    "email-newsletter":    "The user has purchased the 'Monthly Email Newsletter' task. Using the data they provide, generate a complete email newsletter including: 2 A/B subject line options, a hero section, featured dish section, events/promotions section, story or highlight section, and a clear CTA.",
    "grand-opening":       "The user has purchased the 'Grand Opening Announcement' task. Using the data they provide, generate: (1) a shareable social media post (Instagram/Facebook), (2) in-store poster copy, (3) a press-ready local press release, and (4) a Google Business post.",
    "promo-designer":      "The user has purchased the 'Happy Hour / Promo Designer' task. Using the data they provide, generate: offer structure and duration, ready-to-use copy for each channel (social, in-store signage, Google Business), estimated ROI, and key success metrics to track.",
    "local-acquisition":   "The user has purchased the 'Local Demographic Acquisition Strategy' task. Using the data they provide, generate: (1) trade area demographic profile and top 3 untapped customer segments, (2) channel-by-channel 90-day acquisition plan, (3) recommended budget allocation, and (4) KPIs to track by segment.",
  },
  customer: {
    "review-reply-set":       "The user has purchased the 'Review Reply Templates' task. Using the data they provide, generate 3 professional, brand-consistent review responses at different lengths (short: 2 sentences, medium: 1 paragraph, full: 2–3 paragraphs), each acknowledging the issue and offering a resolution.",
    "win-back-campaign":      "The user has purchased the 'Win-Back Campaign' task. Using the data they provide, generate a complete win-back campaign plan including: tiered messaging strategy, email/SMS templates for each tier, promotion structure, send timing, and projected order recovery estimate.",
    "complaint-response":     "The user has purchased the 'Complaint Response Letter' task. Using the data they provide, generate a professional, empathetic response to the complaint — ready to post or send directly. Include: acknowledgment, explanation (if applicable), resolution offered, and brand-consistent closing.",
    "loyalty-program-design": "The user has purchased the 'Loyalty Program Blueprint' task. Using the data they provide, generate a complete loyalty program design including: program structure, tier names and thresholds, earn and redeem rules, launch promotion, and technology/POS integration recommendations.",
    "review-reply":           "The user has purchased the 'Review Reply Draft' task. Using the review they provide, generate 3 ready-to-post reply templates: short (2 sentences), medium (1 paragraph), and full (2–3 paragraphs). Each should acknowledge the issue, show empathy, and offer a clear resolution in the requested tone.",
    "faq-generator":          "The user has purchased the 'FAQ Page Generator' task. Using the data they provide, generate 15–20 polished FAQ pairs organized into clear topic sections (reservations, delivery, dietary, events, etc.), ready to paste directly onto a website or Google Business profile.",
    "complaint-email":        "The user has purchased the 'Complaint Email Response' task. Using the complaint and context they provide, generate a professional, empathetic email response including: acknowledgment of the issue, brief explanation from the restaurant's perspective, a concrete resolution or goodwill gesture, and a brand-consistent closing.",
    "reservation-policy":     "The user has purchased the 'Reservation Policy Writer' task. Using the data they provide, generate: (1) a full formal reservation and cancellation policy for their website, and (2) a shorter version formatted for inclusion in reservation confirmation texts or emails.",
    "loyalty-program":        "The user has purchased the 'Loyalty Program Designer' task. Using the data they provide, generate a complete loyalty program design including: program type and structure, tier names and earning thresholds, reward rules, a welcome bonus offer, sample launch copy for social and in-store, and a cost estimate.",
  },
  finance: {
    "pl-analysis":            "The user has purchased the 'P&L Analysis' task. Using the data they provide, generate a detailed profit and loss analysis including: revenue breakdown, food cost %, labor cost %, platform fee %, gross margin, net margin, margin vs. industry benchmark, and 3 specific improvement actions.",
    "food-cost-optimizer":    "The user has purchased the 'Food Cost Optimizer' task. Using the data they provide, generate a comprehensive food cost analysis including: current cost % vs. target, item-level cost and margin estimates, repricing recommendations, and supplier negotiation tips.",
    "cash-flow-forecast":     "The user has purchased the 'Cash Flow Forecast' task. Using the data they provide, generate a 90-day cash flow projection including: monthly inflow/outflow estimates, cash position at end of each month, risk flags, and recommendations to improve cash flow timing.",
    "tax-prep-checklist":     "The user has purchased the 'Tax Prep Checklist' task. Using the data they provide, generate a restaurant-specific quarterly tax prep checklist including: documents to gather, deductions to claim, deadlines, payment estimates, and accountant briefing notes.",
    "food-cost-benchmark":    "The user has purchased the 'Food Cost Benchmark Analysis' task. Using the data they provide, benchmark their food cost % against LA restaurant averages for their revenue range, calculate the dollar gap, and deliver at least 5 specific cost-reduction actions they can execute this week.",
    "break-even":             "The user has purchased the 'Break-Even Calculator' task. Using the data they provide, calculate their exact daily break-even revenue, daily cover count required, and weekly target. Present a clear breakdown of fixed vs. variable costs and highlight the 2–3 levers with the biggest impact on their break-even point.",
    "catering-quote":         "The user has purchased the 'Catering Quote Builder' task. Using the data they provide, generate a complete professional catering quote including: per-person food cost breakdown, recommended pricing and margin, staffing estimate, total quote amount, and suggested contract terms and deposit structure.",
    "price-increase-letter":  "The user has purchased the 'Menu Price Increase Letter' task. Using the data they provide, write two versions of a price increase notice: (1) a short version for social media posts (under 150 words), and (2) a longer version for in-restaurant signage or email (250–350 words), both in the requested tone.",
    "dish-cost-card":         "The user has purchased the 'Dish Cost Card' task. Using the ingredient list they provide, calculate the exact cost per serving, recommend a menu price using a standard food cost target of 28–32%, assess whether their current price is on target, and provide specific suggestions if it isn't.",
    "pricing-formula":        "The user has purchased the 'Revenue Pricing Formula' task. Using the data they provide, apply the 4.8x pricing model to calculate optimal menu price points, generate a menu engineering matrix summary (Stars / Plow Horses / Puzzles / Dogs) for their current menu range, and produce a 6-month revenue projection at the new pricing.",
  },
  legal: {
    "labor-compliance":     "The user has purchased the 'CA Labor Law Compliance Check' task. Using the data they provide below, generate a comprehensive CA compliance report with: current minimum wage rates, a compliance checklist, specific risk items, and a short accountant summary.",
    "employee-handbook":    "The user has purchased the 'Employee Handbook Generator' task. Using the details they provide, generate a full California-compliant employee handbook covering: attendance, breaks, tip policies, dress code, termination, and sick leave (SB 616).",
    "job-description":      "The user has purchased the 'Job Description Writer' task. Using the details they provide, generate a complete, CA-compliant ready-to-post job description including duties, qualifications, compensation disclosures, and legal statements.",
    "disciplinary-warning": "The user has purchased the 'Disciplinary Warning Letter' task. Using the details they provide, generate a formal, CA-compliant written warning letter ready to sign and place in the employee's file.",
    "termination-checklist":"The user has purchased the 'Termination Checklist' task. Using the details they provide, generate a step-by-step termination checklist covering final pay timing, COBRA notice, equipment return, system access removal, and reference policy.",
    "onboarding-schedule":  "The user has purchased the 'New Hire Onboarding Schedule' task. Using the details they provide, generate a detailed 2-week day-by-day onboarding plan covering training, introductions, policy review, and first milestone check-in.",
    "lease-negotiation":    "The user has purchased the 'Lease Negotiation Package' task. Using the details they provide, generate a comprehensive lease negotiation strategy with market rent benchmarks, prioritized talking points, concession targets, and an attorney review checklist.",
  },
  expert: {},
};

// ─── AGENT CONFIGS ────────────────────────────────────────────────────────────

interface AgentTaskCard {
  id: string;
  title: string;
  price: number;
  shortDesc: string;
}

interface AgentConfig {
  name: string;
  role: string;
  description: string;
  icon: React.ElementType;
  avatar: string;
  badge: string;
  contextStats: { label: string; value: string }[];
  initialMessages: { text: string; content?: React.ReactNode }[];
  chips: ChipDef[];
  agentTasks?: AgentTaskCard[];
}

const AGENT_CONFIGS: Record<AgentId, AgentConfig> = {
  operation: {
    name: "Operation Agent",
    role: "Business Growth & Delivery Operations",
    description: "Monitors overall revenue and order growth, delivery ad spend efficiency, platform performance, and recommends budget and promotion adjustments.",
    icon: Briefcase,
    avatar: "bg-blue-600",
    badge: "bg-blue-100 text-blue-700",
    contextStats: [
      { label: "Monthly Revenue", value: "$28,460" },
      { label: "Total Orders", value: "1,284" },
      { label: "Uber Eats ROAS", value: "3.1x" },
      { label: "DoorDash ROAS", value: "2.8x" },
      { label: "Ad Budget Cap", value: "$1,300" },
      { label: "Recommended Cap", value: "$700" },
    ],
    initialMessages: [
      {
        text: "Hi, I'm your Operation Agent. I track your revenue, delivery platform performance, and ad spend efficiency every day — flagging anything that needs attention before it costs you money. When you need a specific analysis or plan, I can generate it on demand in seconds. Subscribe to run all tasks unlimited, or pick a single task below.",
        content: null,
      },
    ],
    chips: [
      { label: "How are we growing this week?", response: { text: "Week 4 was your strongest week this month — 91 orders, $2,030 revenue, all-time high. Driving factors: Uber Eats lunch-hour performance improved after my bid adjustment last Monday, and the combo promotion added 61 incremental orders.", content: <OpGrowthSnapshot /> } },
      { label: "Should we increase our delivery budget?", response: { text: "No — I recommend the opposite. Your current $1,300 cap is above the efficient range. Reducing to $700 will eliminate afternoon waste while preserving your peak-hour coverage. Here's the full breakdown.", content: <OpBudgetRec /> } },
      { label: "Which platform is performing better?", response: { text: "Uber Eats is leading across every metric — higher ROAS, better conversion, stronger rating, and growing order volume. DoorDash has a 7.5% order dip I'm actively working to recover.", content: <OpDeliveryComparison /> } },
      { label: "What promotions should we run next?", response: { text: "Recommendation for next 30 days: (1) Extend the combo deal — it's your highest ROI promo. (2) Test a BOGO spring roll on DoorDash to recover algorithm visibility. (3) Reactivate the 15% lunch discount on Uber Eats only — better platform for that format.", content: <OpPromoMix /> } },
      { label: "Where are we losing efficiency?", response: { text: "Biggest efficiency loss: $234/month in afternoon delivery ad spend with 1.2–1.4x ROAS (below breakeven at your CPO). Second: DoorDash spend efficiency dropping — CPO increased from $1.72 to $1.98 over 3 weeks. I've already begun rebalancing." } },
    ],
  },

  chef: {
    name: "Chef Agent",
    role: "Menu Innovation & Item Optimization",
    description: "Recommends new dish ideas based on trends and seasonal timing, and optimizes existing menu photos and descriptions to improve click-through and order conversion.",
    icon: ChefHat,
    avatar: "bg-amber-500",
    badge: "bg-amber-100 text-amber-700",
    contextStats: [
      { label: "Menu Items", value: "24 active" },
      { label: "Photos Reviewed", value: "24" },
      { label: "Poor Quality Photos", value: "3 items" },
      { label: "New Dish Ideas", value: "4 ready" },
      { label: "Description Upgrades", value: "6 pending" },
      { label: "Hero Product", value: "Kung Pao Chicken" },
    ],
    initialMessages: [
      {
        text: "Hi, I'm your Chef Agent. I track food trends matched to your cuisine, audit your menu photos against conversion benchmarks, and monitor which dishes are gaining or losing momentum each week. When you need a dish ideas report, photo review, or description rewrite, I'll have it ready in seconds. Subscribe to run all tasks unlimited, or pick a single task below.",
        content: null,
      },
    ],
    chips: [
      { label: "What new dishes should we try next?", response: { text: "Here are my top 4 new dish recommendations for this month — all based on food trend data, your existing prep capability, and local demand signals in your delivery zone.", content: <ChefDishIdeas /> } },
      { label: "Which menu photos need updating?", response: { text: "I've rated all 24 menu items for photo quality. Three items are below acceptable standard and likely costing you orders. Here's the full audit.", content: <ChefPhotoReview /> } },
      { label: "How should we improve this item description?", response: { text: "Here are three high-priority item description upgrades. The before/after comparison shows how sensory language and specificity improve ordering confidence on delivery platforms.", content: <ChefDescriptionUpgrade /> } },
      { label: "What seasonal items fit our brand right now?", response: { text: "For June–August, I recommend: (1) Mango Chicken Rice Bowl — leverages summer fruit trend + your existing protein. (2) Cold Sesame Noodle Bowl — cool weather alternative, highly searchable. (3) Iced Mango Milk Tea — your best beverage upgrade opportunity." } },
      { label: "Which dishes should become hero products?", response: { text: "Hero product recommendation: Kung Pao Chicken (already strong), plus I'd elevate Spicy Garlic Wings as a second hero once you add it. Hero products get prioritized in your delivery platform storefront, Instagram pinned posts, and paid ad imagery." } },
    ],
  },

  social: {
    name: "Marketing Agent",
    role: "Content, Engagement & Creator Partnerships",
    description: "Manages your posting activity, tracks content performance and audience engagement, recommends upcoming content, and matches you with relevant creator collaborations.",
    icon: Megaphone,
    avatar: "bg-purple-600",
    badge: "bg-purple-100 text-purple-700",
    contextStats: [
      { label: "Posts This Month", value: "12" },
      { label: "Total Reach", value: "14,200" },
      { label: "Avg Engagement", value: "3.8%" },
      { label: "Best Post Views", value: "4,200" },
      { label: "TikTok Growth", value: "+312 followers" },
      { label: "Creators Shortlisted", value: "5" },
    ],
    initialMessages: [
      {
        text: "Hi, I'm your Marketing Agent. I monitor your content performance across Instagram and TikTok daily, track what your audience engages with, and keep your creator pipeline ready to activate. When you need a content calendar, Reels script, or campaign report, I'll have it done in seconds. Subscribe to run all tasks unlimited, or pick a single task below.",
        content: null,
      },
    ],
    chips: [
      { label: "What content performed best this week?", response: { text: "The Kung Pao Chicken sizzle reel on Tuesday was your top performer — 4,200 views, 312 saves, 6 attributed delivery orders. Format insight: behind-the-scenes + food-in-motion content consistently outperforms static posts 6x.", content: <SocialBestPost /> } },
      { label: "What should we post next?", response: { text: "Next 7 days: Monday — 'Rice or Noodles?' audience poll (drives comments). Wednesday — Combo deal announcement Reel (30s with sizzle close). Friday — Flash delivery offer Story. Sunday — Customer reaction compilation (builds trust). I've drafted all four." } },
      { label: "What are people reacting to?", response: { text: "Audience data shows food visuals, plating close-ups, and steam/sizzle effects drive your highest save and share rates. Price-value sentiment is positive — your audience responds well to portion-size messaging.", content: <SocialAudienceInsights /> } },
      { label: "Which creators should we work with?", response: { text: "5 creators are shortlisted and ready to contact. I recommend starting with @downtownfoodiejen and @eatlocalmike — both are Downtown-based, have food-specialist audiences, and are within budget. Combined estimated reach: 70k.", content: <SocialCreatorPipeline /> } },
      { label: "Show me upcoming content opportunities", response: { text: "Q3 content calendar highlights: June — summer heat wave theme + iced beverages. July — new dish reveal (Mango Chicken Bowl) + creator campaign launch. August — back-to-school family meal deals + Google Business push. I can generate the full 12-week calendar." } },
    ],
  },

  customer: {
    name: "Customer Service Agent",
    role: "Reviews, Complaints & Customer Retention",
    description: "Monitors Google, Yelp, and delivery platform ratings, tracks complaint resolution, and recommends win-back and retention campaigns to grow repeat revenue.",
    icon: Headphones,
    avatar: "bg-teal-600",
    badge: "bg-teal-100 text-teal-700",
    contextStats: [
      { label: "Google Rating", value: "4.7 ★" },
      { label: "Yelp Rating", value: "4.4 ★" },
      { label: "Uber Eats Rating", value: "4.8 ★" },
      { label: "DoorDash Rating", value: "4.3 ★ ⚠" },
      { label: "Repeat Rate", value: "31%" },
      { label: "Lapsed Customers", value: "398" },
    ],
    initialMessages: [
      {
        text: "Hi, I'm your Customer Service Agent. I watch your reviews across Google, Yelp, Uber Eats, and DoorDash around the clock — alerting you the moment a new negative review lands. I also track complaint patterns and help you win back lapsed customers. Subscribe to run all tasks unlimited, or pick a single task below.",
        content: null,
      },
    ],
    chips: [
      { label: "What are customers complaining about most?", response: { text: "Top complaint this month: delivery wait time on DoorDash (2 mentions). Root cause: average DoorDash delivery time has crept to 31 minutes — above the 30-minute threshold that triggers DoorDash visibility penalties. I've escalated and flagged to operations.", content: <CsComplaintTracker /> } },
      { label: "How are our Google and Yelp ratings changing?", response: { text: "Google: 4.7★ (+0.1 vs last month, 28 new reviews). Yelp: 4.4★ (stable, 14 new reviews). Google is trending positively — I've been proactively asking satisfied customers for Google reviews via post-delivery follow-up.", content: <CsReputationSnapshot /> } },
      { label: "What delivery issues still need follow-up?", response: { text: "Two open items: (1) DoorDash wait time escalation — support ticket open, awaiting response. (2) Missing dipping sauce pattern (3 reports this month) — added to kitchen checklist, monitoring for repeat occurrence.", content: <CsComplaintTracker /> } },
      { label: "What should we do to improve reviews?", response: { text: "Three highest-ROI review improvements: (1) Reduce DoorDash delivery time under 30 min — will stop rating erosion. (2) Add post-delivery Google review prompt for orders rated 5★ in-app — projects to double monthly Google review volume. (3) Add 'Thank you for your order' card in packaging with QR code." } },
      { label: "What win-back campaign should we run next?", response: { text: "I recommend launching the tiered win-back campaign targeting 398 inactive customers. High-value tier (142 customers) gets free delivery + 10% off — projected $3,100 recovery. Ready to deploy Tuesday.", content: <CsWinBackCampaign /> } },
    ],
  },

  finance: {
    name: "Finance Agent",
    role: "Cost Control, Profitability & Financial Planning",
    description: "Monitors food cost, labor cost, and overall profitability. Identifies margin leaks, flags overspending, and recommends pricing and cost-reduction actions.",
    icon: DollarSign,
    avatar: "bg-emerald-600",
    badge: "bg-emerald-100 text-emerald-700",
    contextStats: [
      { label: "Monthly Revenue", value: "$28,460" },
      { label: "Food Cost %", value: "31.2%" },
      { label: "Labor Cost %", value: "28.4%" },
      { label: "Gross Margin", value: "40.4%" },
      { label: "Net Profit", value: "$4,920" },
      { label: "Net Margin", value: "17.3%" },
    ],
    initialMessages: [
      {
        text: "Hi, I'm your Finance Agent. I monitor your food cost, labor cost, and net margin daily — alerting you the moment any cost category drifts outside your target range. When you need a P&L breakdown, food cost analysis, or cash flow forecast, I'll generate it with your exact data in seconds. Subscribe to run all tasks unlimited, or pick a single task below.",
        content: null,
      },
    ],
    chips: [
      { label: "What is our food cost ratio this month?", response: { text: "Food cost ratio: 31.2% — within the 28–33% healthy range for your cuisine type. The main cost driver this month is protein costs (chicken +6%, beef +4% from your supplier). I recommend locking in a 90-day price agreement with your poultry supplier before summer demand peaks." } },
      { label: "Where are we losing margin?", response: { text: "Top margin leaks: (1) Steamed Fish Fillet — 29% margin, underpriced by ~$1.50. (2) Weekend overtime — adds $380/month in avoidable labor cost. (3) DoorDash platform fee (30%) is 4 points higher than Uber Eats — recommend shifting promotions to Uber Eats to improve net margin." } },
      { label: "What is our net profit this month?", response: { text: "Net profit: $4,920 (17.3% net margin) — up from $4,210 last month (+16.9%). Breakdown: Revenue $28,460 → Food Cost $8,880 → Labor $8,082 → Platform Fees $4,270 → Overhead $2,308 = Net $4,920. This is your best month in the last 6 months." } },
      { label: "Which menu items should we reprice?", response: { text: "Repricing recommendations: (1) Steamed Fish Fillet: $16.00 → $17.50 (+$1.50, brings margin from 29% to 36%). (2) Hot & Sour Soup: $8.50 → $9.50 (+$1.00, margin improvement of 7 points). These two changes add ~$480/month in margin at current volume." } },
      { label: "How can we reduce labor cost?", response: { text: "Two specific adjustments to bring labor from 28.4% to under 27%: (1) Shift one weekend kitchen staff from 8-hour to 6-hour Saturday shift — saves $210/month. (2) Overlap lunch and dinner prep to reduce 2 hours of double-staffing — saves $170/month. Combined: $380/month saving." } },
    ],
  },

  legal: {
    name: "Legal & HR Agent",
    role: "Compliance, HR & Employment Law",
    description: "Monitors California labor law compliance, handles employee documentation, and flags HR risks before they become legal liabilities.",
    icon: Scale,
    avatar: "bg-violet-600",
    badge: "bg-violet-100 text-violet-700",
    contextStats: [],
    initialMessages: [
      {
        text: "Hi, I'm your Legal & HR Agent. I work in the background every day without you having to ask — monitoring CA labor law changes, scanning for compliance gaps in your schedule, and keeping your HR risk dashboard up to date. When something needs your attention, I'll alert you before it becomes a problem. And whenever you need a document — a warning letter, a job posting, an onboarding plan — just ask and it's ready in seconds. Subscribe once and run any of the 6 tasks below as many times as you need, no extra charge.",
        content: null,
      },
    ],
    chips: [
      { label: "What California labor laws apply to my restaurant?", response: { text: "" } },
      { label: "Draft an employee warning letter", response: { text: "" } },
      { label: "How do I legally terminate an employee?", response: { text: "" } },
      { label: "What are the meal and rest break rules?", response: { text: "" } },
      { label: "Help me write a job posting", response: { text: "" } },
    ],
  },

  expert: {
    name: "Restaurant Expert",
    role: "满足用户的任何需求，没有任何限制",
    description: "Your unrestricted restaurant expert. Ask anything — strategy, operations, recipes, growth, compliance, marketing, or anything else.",
    icon: Star,
    avatar: "bg-rose-600",
    badge: "bg-rose-100 text-rose-700",
    contextStats: [],
    initialMessages: [
      {
        text: "Hi, I'm your Restaurant Expert. Ask me anything — no restrictions, no topic limits. Strategy, menu, operations, staff, marketing, finance, compliance — whatever you need.",
        content: null,
      },
    ],
    chips: [],
  },
};

const AGENT_AVATAR_CLASSES: Record<AgentId, string> = {
  operation: "bg-blue-600",
  chef: "bg-amber-500",
  social: "bg-purple-600",
  customer: "bg-teal-600",
  finance: "bg-emerald-600",
  legal: "bg-violet-600",
  expert: "bg-rose-600",
};

// ─── Chip Bar ─────────────────────────────────────────────────────────────────

function ChipBar({ chips, onSend }: {
  chips: ChipDef[];
  onSend: (chip: ChipDef) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip, i) => (
        <button key={i} onClick={() => onSend(chip)}
          className="text-[13px] font-medium px-3 py-1.5 rounded-full border border-border/40 bg-transparent text-muted-foreground/70 hover:text-foreground hover:border-border/70 transition-colors text-left leading-none"
          data-testid={`chip-${i}`}>{chip.label}
        </button>
      ))}
    </div>
  );
}

// ─── ZooWork Channel Panel ──────────────────────────────────────────────────────
// Binds one of this agent's ZooWork channels (feishu / wecom / weixin via the
// server-driven QR flow, slack via explicit bot+app tokens). See
// server/zoowork-channels.ts for the API this talks to — once bound, ZooWork
// itself owns the conversation on that platform; there's nothing else to wire up.

interface AgentChannel {
  platform: string;
  account: string;
  display_name?: string | null;
  enabled?: boolean;
  health?: string;
  status?: string;
}

interface ChannelField { key: string; label: string; placeholder: string }
interface ChannelDef {
  type: string;
  name: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  iconColor: string;
  guided: boolean; // true = server-driven QR setup flow, false = explicit credential form
  fields?: ChannelField[];
}

const SUPPORTED_CHANNELS: ChannelDef[] = [
  { type: "feishu", name: "飞书 Feishu", icon: MessageSquare, iconColor: "#00D6B9", guided: true },
  { type: "wecom", name: "企业微信 WeCom", icon: MessageSquare, iconColor: "#2AA7E7", guided: true },
  { type: "weixin", name: "微信 WeChat", icon: SiWechat, iconColor: "#07C160", guided: true },
  {
    type: "slack",
    name: "Slack",
    icon: SiSlack,
    iconColor: "#4A154B",
    guided: false,
    fields: [
      { key: "botToken", label: "Bot Token", placeholder: "xoxb-..." },
      { key: "appToken", label: "App Token", placeholder: "xapp-..." },
    ],
  },
];

type SetupState = {
  platform: string;
  sessionId: string;
  imgContent: string;
  pollInterval: number | null;
  status: "pending" | "success" | "expired" | "denied" | "error";
  message?: string | null;
};

function ChannelBindingsPanel({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [connectingType, setConnectingType] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [setupState, setSetupState] = useState<SetupState | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const channelsKey = `/api/agent/${agentId}/channels`;
  const { data: channels = [], isLoading } = useQuery<AgentChannel[]>({
    queryKey: [channelsKey],
  });

  const channelByType = Object.fromEntries(channels.map(c => [c.platform, c]));
  const boundChannel = channels.find(c => c.enabled !== false);

  const addMutation = useMutation({
    mutationFn: async ({ platform, config }: { platform: string; config: Record<string, string> }) => {
      const res = await apiRequest("POST", `${channelsKey}/${platform}`, config);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [channelsKey] });
      setConnectingType(null);
      setFormValues({});
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ platform, patch }: { platform: string; patch: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `${channelsKey}/${platform}`, patch);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [channelsKey] }),
  });

  const removeMutation = useMutation({
    mutationFn: async (platform: string) => {
      const res = await apiRequest("DELETE", `${channelsKey}/${platform}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [channelsKey] }),
  });

  // Poll a running QR setup session until it leaves "pending".
  useEffect(() => {
    if (!setupState || setupState.status !== "pending") return;
    let cancelled = false;
    const { platform, sessionId, pollInterval } = setupState;
    (async () => {
      while (!cancelled) {
        await new Promise(r => setTimeout(r, (pollInterval ?? 3) * 1000));
        if (cancelled) return;
        try {
          const res = await apiRequest("GET", `${channelsKey}/${platform}/setup/${sessionId}`);
          if (cancelled) return;
          const data = await res.json() as { status: string; message?: string | null };
          if (data.status !== "pending") {
            cancelled = true;
            setSetupState(prev => prev ? { ...prev, status: data.status as SetupState["status"], message: data.message } : null);
            if (data.status === "success") {
              queryClient.invalidateQueries({ queryKey: [channelsKey] });
              setTimeout(() => setSetupOpen(false), 1500);
            }
            return;
          }
        } catch { /* transient poll error — keep trying until the session itself expires */ }
      }
    })();
    return () => { cancelled = true; };
  }, [setupState?.sessionId, setupState?.status]);

  async function handleGuidedConnect(platform: string) {
    setSetupLoading(true);
    setSetupError(null);
    try {
      const res = await apiRequest("POST", `${channelsKey}/${platform}/setup`, {});
      const data = await res.json() as { sessionId: string; imgContent: string; pollInterval: number | null };
      setSetupState({ platform, sessionId: data.sessionId, imgContent: data.imgContent, pollInterval: data.pollInterval, status: "pending" });
      setSetupOpen(true);
    } catch (e: any) {
      setSetupError(e.message || "Failed to start setup");
    } finally {
      setSetupLoading(false);
    }
  }

  function closeSetupModal() {
    setSetupOpen(false);
    if (setupState && setupState.status === "pending") {
      apiRequest("DELETE", `${channelsKey}/${setupState.platform}/setup/${setupState.sessionId}`).catch(() => {});
    }
  }

  return (
    <div className="px-4 py-3 border-t border-border">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("agents_page.channels_label")}</p>
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="space-y-2">
          {[...SUPPORTED_CHANNELS].sort((a, b) => {
            const aBound = channelByType[a.type] ? 1 : 0;
            const bBound = channelByType[b.type] ? 1 : 0;
            return bBound - aBound;
          }).map((ch) => {
            const bound = channelByType[ch.type];
            const isConnecting = connectingType === ch.type;
            // Only one platform may be bound to this agent at a time — see zoowork-channels.ts.
            const blockedByOther = !bound && boundChannel && boundChannel.platform !== ch.type;
            const unhealthy = bound && (bound.health === "unhealthy" || bound.status === "error");
            return (
              <div key={ch.type} className="rounded-lg border border-border bg-background overflow-hidden">
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  <ch.icon style={{ color: ch.iconColor }} className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm font-medium text-foreground flex-1">{ch.name}</span>
                  {bound ? (
                    <span className={cn("text-xs font-medium px-1.5 py-0.5 rounded", unhealthy ? "text-amber-600 bg-amber-50" : "text-green-600 bg-green-50")}>
                      {unhealthy ? t("agents_page.channel_unhealthy") : t("agents_page.channel_connected")}
                    </span>
                  ) : ch.guided ? (
                    <button
                      onClick={() => handleGuidedConnect(ch.type)}
                      disabled={setupLoading || !!blockedByOther}
                      className="text-xs text-primary hover:underline disabled:opacity-50"
                      title={blockedByOther ? `已绑定 ${boundChannel!.platform}，请先断开` : undefined}
                    >
                      {setupLoading ? <Loader2 className="w-3 h-3 animate-spin inline" /> : t("agents_page.channel_connect")}
                    </button>
                  ) : (
                    <button
                      onClick={() => { setConnectingType(isConnecting ? null : ch.type); setFormValues({}); }}
                      disabled={!!blockedByOther}
                      className="text-xs text-primary hover:underline disabled:opacity-50"
                      title={blockedByOther ? `已绑定 ${boundChannel!.platform}，请先断开` : undefined}
                    >
                      {isConnecting ? t("agents_page.channel_cancel") : t("agents_page.channel_connect")}
                    </button>
                  )}
                </div>

                {bound && (
                  <div className="px-3 pb-2.5 flex items-center justify-between">
                    <span className="text-xs text-muted-foreground font-mono truncate max-w-[110px]">
                      {bound.display_name || bound.account}
                    </span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => updateMutation.mutate({ platform: ch.type, patch: { enabled: bound.enabled === false } })}
                        disabled={updateMutation.isPending}
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        {bound.enabled === false ? t("agents_page.channel_enable") : t("agents_page.channel_disable")}
                      </button>
                      <button
                        onClick={() => removeMutation.mutate(ch.type)}
                        disabled={removeMutation.isPending}
                        className="text-xs text-destructive hover:underline"
                      >
                        {removeMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : t("agents_page.channel_disconnect")}
                      </button>
                    </div>
                  </div>
                )}

                {isConnecting && !bound && !ch.guided && (
                  <div className="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
                    {ch.fields?.map((f) => (
                      <div key={f.key}>
                        <label className="text-xs text-muted-foreground mb-1 block">{f.label}</label>
                        <Input
                          value={formValues[f.key] ?? ""}
                          onChange={(e) => setFormValues(v => ({ ...v, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="text-xs font-mono h-7"
                        />
                      </div>
                    ))}
                    <Button
                      size="sm"
                      className="w-full h-7 text-xs"
                      disabled={addMutation.isPending || !ch.fields?.every(f => formValues[f.key]?.trim())}
                      onClick={() => addMutation.mutate({ platform: ch.type, config: formValues })}
                    >
                      {addMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Link2 className="w-3 h-3 mr-1" />{t("agents_page.channel_connect")}</>}
                    </Button>
                    {addMutation.isError && (
                      <p className="text-xs text-destructive mt-1">{(addMutation.error as Error)?.message || "Connect failed"}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {setupError && (
            <p className="text-xs text-destructive">{setupError}</p>
          )}
        </div>
      )}

      {/* QR setup dialog (feishu / wecom / weixin) */}
      {setupOpen && setupState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl shadow-xl p-6 w-72 flex flex-col items-center gap-4 relative">
            <button
              onClick={closeSetupModal}
              className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
            <p className="text-sm font-semibold text-foreground">
              {SUPPORTED_CHANNELS.find(c => c.type === setupState.platform)?.name}
            </p>
            {setupState.status === "success" ? (
              <div className="flex flex-col items-center gap-2">
                <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6 text-green-600" />
                </div>
                <p className="text-sm font-medium text-green-600">{t("agents_page.channel_connected")}</p>
              </div>
            ) : setupState.status === "pending" ? (
              <>
                <img
                  src={setupState.imgContent.startsWith("http") ? setupState.imgContent : `data:image/png;base64,${setupState.imgContent}`}
                  alt="QR Code"
                  className="w-44 h-44 rounded-lg border border-border"
                />
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{t("agents_page.channel_waiting_scan")}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-destructive text-center">
                {setupState.status === "expired" ? t("agents_page.channel_setup_expired")
                  : setupState.status === "denied" ? t("agents_page.channel_setup_denied")
                  : setupState.message || t("agents_page.channel_setup_error")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MCP Connect Panel ──────────────────────────────────────────────────────────
// Lets the customer supply their own key for an MCP tool this agent offers.
// The key is sent once and encrypted server-side — Favie's proxy injects it into
// requests to the real (authenticated) MCP server; we never store it in plaintext.

interface McpServerAvailable {
  id: string;
  key: string;
  name: string;
  description: string | null;
  connected: boolean;
}

function McpConnectPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");

  const { data, isLoading } = useQuery<{ mcpServers: McpServerAvailable[] }>({
    queryKey: ["/api/mcp/available"],
  });
  const servers = data?.mcpServers ?? [];

  const connectMutation = useMutation({
    mutationFn: (mcpServerId: string) => apiRequest("POST", "/api/mcp/connect", { mcpServerId, apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mcp/available"] });
      setConnectingId(null);
      setApiKey("");
    },
  });
  const disconnectMutation = useMutation({
    mutationFn: (mcpServerId: string) => apiRequest("DELETE", `/api/mcp/connect/${mcpServerId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/mcp/available"] }),
  });

  if (!isLoading && servers.length === 0) return null;

  return (
    <div className="px-4 py-3 border-t border-border">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("connectors_page.mcp_panel_title")}</p>
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="space-y-2">
          {servers.map((s) => {
            const isConnecting = connectingId === s.id;
            return (
              <div key={s.id} className="rounded-lg border border-border bg-background overflow-hidden">
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  <Link2 className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground flex-1">{s.name}</span>
                  {s.connected ? (
                    <span className="text-xs font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded">{t("connectors_page.status_connected")}</span>
                  ) : (
                    <button
                      onClick={() => { setConnectingId(isConnecting ? null : s.id); setApiKey(""); }}
                      className="text-xs text-primary hover:underline"
                    >
                      {isConnecting ? t("mcps_page.cancel") : t("connectors_page.button_connect")}
                    </button>
                  )}
                </div>
                {s.description && (
                  <p className="px-3 pb-2 text-xs text-muted-foreground">{s.description}</p>
                )}
                {s.connected && (
                  <div className="px-3 pb-2.5 flex justify-end">
                    <button
                      onClick={() => disconnectMutation.mutate(s.id)}
                      disabled={disconnectMutation.isPending}
                      className="text-xs text-destructive hover:underline"
                    >
                      {disconnectMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : t("connectors_page.button_disconnect")}
                    </button>
                  </div>
                )}
                {isConnecting && !s.connected && (
                  <div className="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={t("connectors_page.paste_key_placeholder")}
                      className="text-xs font-mono h-7"
                    />
                    <Button
                      size="sm"
                      className="w-full h-7 text-xs"
                      disabled={connectMutation.isPending || !apiKey.trim()}
                      onClick={() => connectMutation.mutate(s.id)}
                    >
                      {connectMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Link2 className="w-3 h-3 mr-1" />{t("connectors_page.button_connect")}</>}
                    </Button>
                    {connectMutation.isError && (
                      <p className="text-xs text-destructive mt-1">{(connectMutation.error as Error)?.message || t("connectors_page.connect_failed")}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Context Panel ────────────────────────────────────────────────────────────

function AgentContextPanel({ config, agentId, restaurant }: { config: AgentConfig; agentId: string; restaurant?: Restaurant | null }) {
  const { t } = useTranslation();
  return (
    <div className="w-60 xl:w-64 flex-shrink-0 border-l border-border bg-card overflow-y-auto hidden lg:flex flex-col">
      <div className="px-4 py-4 border-b border-border">
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">{config.role}</p>
        <p className="text-sm text-muted-foreground leading-relaxed">{config.description}</p>
      </div>
      {agentId === "expert" && restaurant && (
        <div className="px-4 py-3 border-b border-border space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Restaurant</p>
          <p className="text-sm font-medium text-foreground">{restaurant.name}</p>
          {restaurant.rating && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Rating:</span>
              <span className="text-xs font-semibold text-foreground">{restaurant.rating} ⭐</span>
              {restaurant.reviewCount && (
                <span className="text-xs text-muted-foreground">({restaurant.reviewCount})</span>
              )}
            </div>
          )}
          {restaurant.googleUrl && (
            <a
              href={restaurant.googleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline break-all"
            >
              Google Maps →
            </a>
          )}
        </div>
      )}
      {config.contextStats.length > 0 && (
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">{t("agents_page.context_key_metrics")}</p>
          <div className="space-y-2.5">
            {config.contextStats.map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{label}</span>
                <span className="text-sm font-semibold text-foreground">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
          <span className="text-sm text-green-700 font-medium">{t("agents_page.context_active_monitoring")}</span>
        </div>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">{t("agents_page.context_proactively_working")}</p>
        <p className="text-sm text-muted-foreground italic">{t("agents_page.context_nothing_scheduled")}</p>
      </div>
      <ChannelBindingsPanel agentId={agentId} />
      <McpConnectPanel />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function useAgentHireFeatures(agentId: AgentId) {
  const { t } = useTranslation();
  const base = AGENT_HIRE_FEATURES[agentId];

  const translations: Record<AgentId, { proactive: { label: string; desc: string }[]; onDemand: { label: string; desc: string }[]; taskCount: string }> = {
    operation: {
      proactive: [
        { label: t("agents_page.op_proactive1_label"), desc: t("agents_page.op_proactive1_desc") },
        { label: t("agents_page.op_proactive2_label"), desc: t("agents_page.op_proactive2_desc") },
        { label: t("agents_page.op_proactive3_label"), desc: t("agents_page.op_proactive3_desc") },
      ],
      onDemand: [
        { label: t("agents_page.op_ondemand1_label"), desc: t("agents_page.op_ondemand1_desc") },
        { label: t("agents_page.op_ondemand2_label"), desc: t("agents_page.op_ondemand2_desc") },
      ],
      taskCount: t("agents_page.op_task_count"),
    },
    chef: {
      proactive: [
        { label: t("agents_page.chef_proactive1_label"), desc: t("agents_page.chef_proactive1_desc") },
        { label: t("agents_page.chef_proactive2_label"), desc: t("agents_page.chef_proactive2_desc") },
        { label: t("agents_page.chef_proactive3_label"), desc: t("agents_page.chef_proactive3_desc") },
      ],
      onDemand: [
        { label: t("agents_page.chef_ondemand1_label"), desc: t("agents_page.chef_ondemand1_desc") },
        { label: t("agents_page.chef_ondemand2_label"), desc: t("agents_page.chef_ondemand2_desc") },
      ],
      taskCount: t("agents_page.chef_task_count"),
    },
    social: {
      proactive: [
        { label: t("agents_page.social_proactive1_label"), desc: t("agents_page.social_proactive1_desc") },
        { label: t("agents_page.social_proactive2_label"), desc: t("agents_page.social_proactive2_desc") },
        { label: t("agents_page.social_proactive3_label"), desc: t("agents_page.social_proactive3_desc") },
      ],
      onDemand: [
        { label: t("agents_page.social_ondemand1_label"), desc: t("agents_page.social_ondemand1_desc") },
        { label: t("agents_page.social_ondemand2_label"), desc: t("agents_page.social_ondemand2_desc") },
      ],
      taskCount: t("agents_page.social_task_count"),
    },
    customer: {
      proactive: [
        { label: t("agents_page.customer_proactive1_label"), desc: t("agents_page.customer_proactive1_desc") },
        { label: t("agents_page.customer_proactive2_label"), desc: t("agents_page.customer_proactive2_desc") },
        { label: t("agents_page.customer_proactive3_label"), desc: t("agents_page.customer_proactive3_desc") },
      ],
      onDemand: [
        { label: t("agents_page.customer_ondemand1_label"), desc: t("agents_page.customer_ondemand1_desc") },
        { label: t("agents_page.customer_ondemand2_label"), desc: t("agents_page.customer_ondemand2_desc") },
      ],
      taskCount: t("agents_page.customer_task_count"),
    },
    finance: {
      proactive: [
        { label: t("agents_page.finance_proactive1_label"), desc: t("agents_page.finance_proactive1_desc") },
        { label: t("agents_page.finance_proactive2_label"), desc: t("agents_page.finance_proactive2_desc") },
        { label: t("agents_page.finance_proactive3_label"), desc: t("agents_page.finance_proactive3_desc") },
      ],
      onDemand: [
        { label: t("agents_page.finance_ondemand1_label"), desc: t("agents_page.finance_ondemand1_desc") },
        { label: t("agents_page.finance_ondemand2_label"), desc: t("agents_page.finance_ondemand2_desc") },
      ],
      taskCount: t("agents_page.finance_task_count"),
    },
    legal: {
      proactive: [
        { label: t("agents_page.legal_proactive1_label"), desc: t("agents_page.legal_proactive1_desc") },
        { label: t("agents_page.legal_proactive2_label"), desc: t("agents_page.legal_proactive2_desc") },
        { label: t("agents_page.legal_proactive3_label"), desc: t("agents_page.legal_proactive3_desc") },
      ],
      onDemand: [
        { label: t("agents_page.legal_ondemand1_label"), desc: t("agents_page.legal_ondemand1_desc") },
        { label: t("agents_page.legal_ondemand2_label"), desc: t("agents_page.legal_ondemand2_desc") },
      ],
      taskCount: t("agents_page.legal_task_count"),
    },
    expert: {
      proactive: [],
      onDemand: [],
      taskCount: t("agents_page.expert_task_count"),
    },
  };

  const tl = translations[agentId] ?? translations.operation;
  return {
    proactive: base.proactive.map((item, i) => ({ ...item, label: tl.proactive[i]?.label ?? item.label, desc: tl.proactive[i]?.desc ?? item.desc })),
    onDemand: base.onDemand.map((item, i) => ({ ...item, label: tl.onDemand[i]?.label ?? item.label, desc: tl.onDemand[i]?.desc ?? item.desc })),
    taskCount: tl.taskCount,
  };
}

function useAgentTasks(agentId: AgentId) {
  const { t } = useTranslation();
  const base = AGENT_TASKS[agentId] ?? [];
  return base.map((task) => {
    const key = task.id.replace(/-/g, "_");
    return {
      ...task,
      title: t(`agents_page.task_${key}_title`, { defaultValue: task.title }),
      shortDesc: t(`agents_page.task_${key}_short`, { defaultValue: task.shortDesc }),
    };
  });
}

function useAgentConfig(agentId: AgentId) {
  const { t } = useTranslation();
  // Called unconditionally (rules of hooks) — only consumed below when agentId isn't
  // one of the 7 known tabs, but agentId can change across renders of this same
  // mounted component (client-side nav between tabs), so this can't be conditional.
  const { data: myAgentsData } = useQuery<{ agents: EntitledAgent[] }>({ queryKey: ["/api/agent/my-agents"] });

  const translatedConfigs: Record<AgentId, Pick<AgentConfig, "name" | "role" | "description" | "contextStats" | "initialMessages" | "chips">> = {
    operation: {
      name: t("agents_page.op_name"),
      role: t("agents_page.op_role"),
      description: t("agents_page.op_desc"),
      contextStats: [
        { label: t("agents_page.op_stat_monthly_revenue"), value: "$28,460" },
        { label: t("agents_page.op_stat_total_orders"), value: "1,284" },
        { label: t("agents_page.op_stat_ubereats_roas"), value: "3.1x" },
        { label: t("agents_page.op_stat_doordash_roas"), value: "2.8x" },
        { label: t("agents_page.op_stat_ad_budget_cap"), value: "$1,300" },
        { label: t("agents_page.op_stat_recommended_cap"), value: "$700" },
      ],
      initialMessages: [{ text: t("agents_page.op_init_msg"), content: null }],
      chips: [
        { label: t("agents_page.op_chip1"), response: { text: t("agents_page.op_chip1_resp"), content: <OpGrowthSnapshot /> } },
        { label: t("agents_page.op_chip2"), response: { text: t("agents_page.op_chip2_resp"), content: <OpBudgetRec /> } },
        { label: t("agents_page.op_chip3"), response: { text: t("agents_page.op_chip3_resp"), content: <OpDeliveryComparison /> } },
        { label: t("agents_page.op_chip4"), response: { text: t("agents_page.op_chip4_resp"), content: <OpPromoMix /> } },
        { label: t("agents_page.op_chip5"), response: { text: t("agents_page.op_chip5_resp") } },
      ],
    },
    chef: {
      name: t("agents_page.chef_name"),
      role: t("agents_page.chef_role"),
      description: t("agents_page.chef_desc"),
      contextStats: [
        { label: t("agents_page.chef_stat_menu_items"), value: "24 active" },
        { label: t("agents_page.chef_stat_photos_reviewed"), value: "24" },
        { label: t("agents_page.chef_stat_poor_photos"), value: "3 items" },
        { label: t("agents_page.chef_stat_new_dish_ideas"), value: "4 ready" },
        { label: t("agents_page.chef_stat_desc_upgrades"), value: "6 pending" },
        { label: t("agents_page.chef_stat_hero_product"), value: "Kung Pao Chicken" },
      ],
      initialMessages: [{ text: t("agents_page.chef_init_msg"), content: null }],
      chips: [
        { label: t("agents_page.chef_chip1"), response: { text: t("agents_page.chef_chip1_resp"), content: <ChefDishIdeas /> } },
        { label: t("agents_page.chef_chip2"), response: { text: t("agents_page.chef_chip2_resp"), content: <ChefPhotoReview /> } },
        { label: t("agents_page.chef_chip3"), response: { text: t("agents_page.chef_chip3_resp"), content: <ChefDescriptionUpgrade /> } },
        { label: t("agents_page.chef_chip4"), response: { text: t("agents_page.chef_chip4_resp") } },
        { label: t("agents_page.chef_chip5"), response: { text: t("agents_page.chef_chip5_resp") } },
      ],
    },
    social: {
      name: t("agents_page.social_name"),
      role: t("agents_page.social_role"),
      description: t("agents_page.social_desc"),
      contextStats: [
        { label: t("agents_page.social_stat_posts"), value: "12" },
        { label: t("agents_page.social_stat_reach"), value: "14,200" },
        { label: t("agents_page.social_stat_engagement"), value: "3.8%" },
        { label: t("agents_page.social_stat_best_post"), value: "4,200" },
        { label: t("agents_page.social_stat_tiktok_growth"), value: "+312 followers" },
        { label: t("agents_page.social_stat_creators"), value: "5" },
      ],
      initialMessages: [{ text: t("agents_page.social_init_msg"), content: null }],
      chips: [
        { label: t("agents_page.social_chip1"), response: { text: t("agents_page.social_chip1_resp"), content: <SocialBestPost /> } },
        { label: t("agents_page.social_chip2"), response: { text: t("agents_page.social_chip2_resp") } },
        { label: t("agents_page.social_chip3"), response: { text: t("agents_page.social_chip3_resp"), content: <SocialAudienceInsights /> } },
        { label: t("agents_page.social_chip4"), response: { text: t("agents_page.social_chip4_resp"), content: <SocialCreatorPipeline /> } },
        { label: t("agents_page.social_chip5"), response: { text: t("agents_page.social_chip5_resp") } },
      ],
    },
    customer: {
      name: t("agents_page.customer_name"),
      role: t("agents_page.customer_role"),
      description: t("agents_page.customer_desc"),
      contextStats: [
        { label: t("agents_page.customer_stat_google"), value: "4.7 ★" },
        { label: t("agents_page.customer_stat_yelp"), value: "4.4 ★" },
        { label: t("agents_page.customer_stat_ubereats"), value: "4.8 ★" },
        { label: t("agents_page.customer_stat_doordash"), value: "4.3 ★ ⚠" },
        { label: t("agents_page.customer_stat_repeat_rate"), value: "31%" },
        { label: t("agents_page.customer_stat_lapsed"), value: "398" },
      ],
      initialMessages: [{ text: t("agents_page.customer_init_msg"), content: null }],
      chips: [
        { label: t("agents_page.customer_chip1"), response: { text: t("agents_page.customer_chip1_resp"), content: <CsComplaintTracker /> } },
        { label: t("agents_page.customer_chip2"), response: { text: t("agents_page.customer_chip2_resp"), content: <CsReputationSnapshot /> } },
        { label: t("agents_page.customer_chip3"), response: { text: t("agents_page.customer_chip3_resp"), content: <CsComplaintTracker /> } },
        { label: t("agents_page.customer_chip4"), response: { text: t("agents_page.customer_chip4_resp") } },
        { label: t("agents_page.customer_chip5"), response: { text: t("agents_page.customer_chip5_resp"), content: <CsWinBackCampaign /> } },
      ],
    },
    finance: {
      name: t("agents_page.finance_name"),
      role: t("agents_page.finance_role"),
      description: t("agents_page.finance_desc"),
      contextStats: [
        { label: t("agents_page.finance_stat_revenue"), value: "$28,460" },
        { label: t("agents_page.finance_stat_food_cost"), value: "31.2%" },
        { label: t("agents_page.finance_stat_labor_cost"), value: "28.4%" },
        { label: t("agents_page.finance_stat_gross_margin"), value: "40.4%" },
        { label: t("agents_page.finance_stat_net_profit"), value: "$4,920" },
        { label: t("agents_page.finance_stat_net_margin"), value: "17.3%" },
      ],
      initialMessages: [{ text: t("agents_page.finance_init_msg"), content: null }],
      chips: [
        { label: t("agents_page.finance_chip1"), response: { text: t("agents_page.finance_chip1_resp") } },
        { label: t("agents_page.finance_chip2"), response: { text: t("agents_page.finance_chip2_resp") } },
        { label: t("agents_page.finance_chip3"), response: { text: t("agents_page.finance_chip3_resp") } },
        { label: t("agents_page.finance_chip4"), response: { text: t("agents_page.finance_chip4_resp") } },
        { label: t("agents_page.finance_chip5"), response: { text: t("agents_page.finance_chip5_resp") } },
      ],
    },
    legal: {
      name: t("agents_page.legal_name"),
      role: t("agents_page.legal_role"),
      description: t("agents_page.legal_desc"),
      contextStats: [],
      initialMessages: [{ text: t("agents_page.legal_init_msg"), content: null }],
      chips: [
        { label: t("agents_page.legal_chip1"), response: { text: "" } },
        { label: t("agents_page.legal_chip2"), response: { text: "" } },
        { label: t("agents_page.legal_chip3"), response: { text: "" } },
        { label: t("agents_page.legal_chip4"), response: { text: "" } },
        { label: t("agents_page.legal_chip5"), response: { text: "" } },
      ],
    },
    expert: {
      name: t("agents_page.expert_name"),
      role: t("agents_page.expert_role"),
      description: t("agents_page.expert_desc"),
      contextStats: [],
      initialMessages: [{ text: t("agents_page.expert_init_msg"), content: null }],
      chips: [],
    },
  };

  if (!isKnownAgentId(agentId)) {
    // Generic catalog product (sysadmin-authored, no curated marketing copy here) —
    // use its own name/description instead of borrowing one of the 7 tabs' content.
    const entry = myAgentsData?.agents.find((a) => a.key === agentId);
    const name = entry?.name ?? agentId;
    return {
      name,
      role: "",
      description: entry?.description ?? "",
      icon: MessageSquare,
      avatar: "bg-primary",
      badge: "",
      contextStats: [],
      initialMessages: [{ text: t("agents_page.generic_init_msg", { name }), content: null }],
      chips: [],
    };
  }

  const base = AGENT_CONFIGS[agentId] ?? AGENT_CONFIGS.operation;
  const translated = translatedConfigs[agentId] ?? translatedConfigs.operation;
  return { ...base, ...translated };
}

export default function AgentChatPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const params = useParams<{ agentId: string }>();
  const agentId = (params.agentId as AgentId) || "operation";
  const config = useAgentConfig(agentId);

  const buildInitialMessages = (cfg: AgentConfig): ChatMsg[] =>
    cfg.initialMessages.map((m, i) => ({
      id: `init-${i}`,
      role: "ai" as const,
      text: m.text,
      content: m.content,
      ts: `09:0${i}`,
    }));

  const search = useSearch();
  const hiredAgents = useHiredAgents();
  const [messages, setMessages] = useState<ChatMsg[]>(() => buildInitialMessages(config));
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [hasSavedHistory, setHasSavedHistory] = useState(false);
  const [awaitingOnboarding, setAwaitingOnboarding] = useState(false);
  const [paymentTask, setPaymentTask] = useState<PayableTask | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Multi-select mode for batch deleting messages.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{ url: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingTaskId = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const queryClient = useQueryClient();
  const { data: restaurantData, isLoading: restaurantsLoading } = useQuery<{ restaurants: Restaurant[] }>({
    queryKey: ["/api/restaurants"],
  });
  const hasRestaurants = (restaurantData?.restaurants?.length ?? 0) > 0;
  const showRestaurantGate = !restaurantsLoading && !hasRestaurants && !!user;

  const hireTask: PayableTask = { id: `__hire_${agentId}__`, title: t("agents_page.hire_task_title", { name: config.name }), price: AGENT_HIRE_PRICES[agentId] };

  // Task card clicked: if agent is already hired → inject task prompt directly; else → show payment modal
  const handleTaskClick = (task: PayableTask) => {
    if (hiredAgents.has(agentId)) {
      const prompt = AGENT_TASK_PROMPTS[agentId]?.[task.id];
      if (!prompt) return;
      pendingTaskId.current = task.id;
      const taskMsg: ChatMsg = { id: makeId(), role: "ai", text: prompt, ts: nowStr() };
      setMessages((m) => [...m, taskMsg]);
    } else {
      setPaymentTask(task);
    }
  };

  const handlePaymentSuccess = () => {
    const task = paymentTask;
    setPaymentTask(null);
    if (!task) return;
    if (task.id.startsWith("__hire_")) {
      addHiredAgent(agentId);
      return;
    }
    const prompt = AGENT_TASK_PROMPTS[agentId]?.[task.id];
    if (!prompt) return;
    pendingTaskId.current = task.id;
    setTimeout(() => {
      const taskMsg: ChatMsg = { id: makeId(), role: "ai", text: prompt, ts: nowStr() };
      setMessages((m) => [...m, taskMsg]);
    }, 400);
  };

  useEffect(() => { if (!user) navigate("/login"); }, [user]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isLoading]);

  useEffect(() => {
    const initMsgs = buildInitialMessages(config);
    setMessages(initMsgs);
    setInput("");
    setIsLoading(false);
    setHistoryLoaded(false);
    setHasSavedHistory(false);
    setAwaitingOnboarding(false);
    setSelectMode(false);
    setSelectedIds(new Set());
    setHasMoreHistory(false);
    pendingTaskId.current = null;

    fetch(`/api/chat/${agentId}?limit=20`)
      .then((r) => (r.ok ? r.json() : { messages: [], hasMore: false }))
      .then((data: { messages: { id: number; role: string; text: string; ts: string }[]; hasMore: boolean }) => {
        const history = data.messages;
        setHasMoreHistory(data.hasMore);
        if (history.length > 0) {
          const savedMsgs: ChatMsg[] = history.map((h) => ({
            id: `saved-${h.id}`,
            role: h.role as "ai" | "user",
            text: h.text,
            ts: h.ts,
          }));
          const startsWithAiGreeting = savedMsgs[0]?.role === "ai";
          setMessages(startsWithAiGreeting ? savedMsgs : [...initMsgs, ...savedMsgs]);
          setHasSavedHistory(true);
          setAwaitingOnboarding(false);
        } else if (agentId === "expert") {
          setAwaitingOnboarding(true);
        }
        setHistoryLoaded(true);
      })
      .catch(() => setHistoryLoaded(true));
  }, [agentId]);

  // Pending task message — injected only after history finishes loading to avoid race
  const pendingTaskMsg = useRef<ChatMsg | null>(null);

  // Detect ?task= param → store a pending task message to inject after history loads
  useEffect(() => {
    const params = new URLSearchParams(search);
    const taskId = params.get("task");
    if (!taskId) return;
    const prompt = AGENT_TASK_PROMPTS[agentId]?.[taskId];
    if (!prompt) return;
    pendingTaskId.current = taskId;
    pendingTaskMsg.current = { id: makeId(), role: "ai", text: prompt, ts: nowStr() };
    window.history.replaceState(null, "", window.location.pathname);
  }, [search, agentId]);

  // Poll for new messages from other channels (Telegram, etc.)
  // Polls every 3s while awaiting Expert onboarding, otherwise every 10s
  useEffect(() => {
    if (!historyLoaded) return;
    const interval = setInterval(() => {
      if (isLoading) return; // don't poll while waiting for AI response
      fetch(`/api/chat/${agentId}?limit=20`)
        .then((r) => (r.ok ? r.json() : { messages: [], hasMore: false }))
        .then((data: { messages: { id: number; role: string; text: string; ts: string }[]; hasMore: boolean }) => {
          const history = data.messages;
          // While awaiting onboarding, replace all messages with DB history once it arrives
          if (awaitingOnboarding && history.length > 0) {
            const savedMsgs: ChatMsg[] = history.map((h) => ({
              id: `saved-${h.id}`,
              role: h.role as "ai" | "user",
              text: h.text,
              ts: h.ts,
            }));
            setMessages(savedMsgs);
            setHasSavedHistory(true);
            setAwaitingOnboarding(false);
            setHasMoreHistory(data.hasMore);
            return;
          }
          setMessages((current) => {
            const existingIds = new Set(
              current.filter(m => m.id.startsWith("saved-")).map(m => Number(m.id.replace("saved-", "")))
            );
            const newMsgs = history.filter(h => !existingIds.has(h.id)).map(h => ({
              id: `saved-${h.id}`,
              role: h.role as "ai" | "user",
              text: h.text,
              ts: h.ts,
            }));
            if (newMsgs.length === 0) return current;
            setHasSavedHistory(true);
            return [...current, ...newMsgs];
          });
        })
        .catch(() => {});
    }, awaitingOnboarding ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [agentId, historyLoaded, isLoading, awaitingOnboarding]);

  // Once history has loaded, flush any pending task message
  useEffect(() => {
    if (!historyLoaded) return;
    if (!pendingTaskMsg.current) return;
    const msg = pendingTaskMsg.current;
    pendingTaskMsg.current = null;
    setMessages((m) => [...m, msg]);
  }, [historyLoaded]);

  // Save a user+AI message pair to the server, then re-sync state with stable DB IDs
  // so the 10s polling dedup correctly skips them (prevents duplication).
  const saveMessages = (userMsg: ChatMsg, aiMsg: ChatMsg) => {
    setHasSavedHistory(true);
    fetch(`/api/chat/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: userMsg.role, text: userMsg.text, ts: userMsg.ts },
          { role: aiMsg.role, text: aiMsg.text, ts: aiMsg.ts },
        ],
      }),
    })
      .then((r) => (r.ok ? fetch(`/api/chat/${agentId}?limit=20`) : null))
      .then((r) => (r?.ok ? r.json() : null))
      .then((data: { messages: { id: number; role: string; text: string; ts: string }[]; hasMore: boolean } | null) => {
        if (!data) return;
        const initMsgs = buildInitialMessages(config);
        const savedMsgs: ChatMsg[] = data.messages.map((h) => ({
          id: `saved-${h.id}`,
          role: h.role as "ai" | "user",
          text: h.text,
          ts: h.ts,
        }));
        // Tool steps and the user's own uploaded-image URL are never persisted to
        // chat_messages, so re-attach what we already have in memory for the turn
        // that was just saved — otherwise this history reload wipes them out the
        // instant they appear.
        if (aiMsg.steps && aiMsg.steps.length > 0) {
          const last = savedMsgs[savedMsgs.length - 1];
          if (last?.role === "ai") last.steps = aiMsg.steps;
        }
        if (userMsg.attachmentUrl) {
          const secondToLast = savedMsgs[savedMsgs.length - 2];
          if (secondToLast?.role === "user") secondToLast.attachmentUrl = userMsg.attachmentUrl;
        }
        const startsWithAiGreeting = savedMsgs[0]?.role === "ai";
        setMessages(startsWithAiGreeting ? savedMsgs : [...initMsgs, ...savedMsgs]);
        setHasMoreHistory(data.hasMore);
      })
      .catch(() => {});
  };

  // Delete one message: persisted ones (id prefixed "saved-") also hit the server.
  const deleteMessage = (messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    if (messageId.startsWith("saved-")) {
      const serverId = messageId.slice("saved-".length);
      fetch(`/api/chat/${agentId}/${serverId}`, { method: "DELETE" }).catch(() => {});
    }
  };

  // ── Multi-select / batch delete ───────────────────────────────────────────
  const enterSelectMode = (id: string) => {
    setSelectMode(true);
    setSelectedIds(new Set([id]));
  };
  const toggleSelectMessage = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };
  const selectAllMessages = () => {
    setSelectedIds(new Set(messages.map((m) => m.id)));
  };
  const deleteSelectedMessages = () => {
    const ids = Array.from(selectedIds);
    setMessages((prev) => prev.filter((m) => !selectedIds.has(m.id)));
    for (const id of ids) {
      if (id.startsWith("saved-")) {
        const serverId = id.slice("saved-".length);
        fetch(`/api/chat/${agentId}/${serverId}`, { method: "DELETE" }).catch(() => {});
      }
    }
    setConfirmDeleteOpen(false);
    exitSelectMode();
  };

  // Load older messages (pagination)
  const loadMoreHistory = () => {
    const firstSavedMsg = messages.find(m => m.id.startsWith("saved-"));
    if (!firstSavedMsg || loadingMore) return;
    const beforeId = Number(firstSavedMsg.id.replace("saved-", ""));
    setLoadingMore(true);
    const scrollContainer = chatContainerRef.current;
    const prevScrollHeight = scrollContainer?.scrollHeight ?? 0;
    fetch(`/api/chat/${agentId}?limit=20&before=${beforeId}`)
      .then((r) => (r.ok ? r.json() : { messages: [], hasMore: false }))
      .then((data: { messages: { id: number; role: string; text: string; ts: string }[]; hasMore: boolean }) => {
        setHasMoreHistory(data.hasMore);
        if (data.messages.length > 0) {
          const olderMsgs: ChatMsg[] = data.messages.map((h) => ({
            id: `saved-${h.id}`,
            role: h.role as "ai" | "user",
            text: h.text,
            ts: h.ts,
          }));
          setMessages((current) => [...olderMsgs, ...current]);
          // Preserve scroll position after prepending
          requestAnimationFrame(() => {
            if (scrollContainer) {
              scrollContainer.scrollTop = scrollContainer.scrollHeight - prevScrollHeight;
            }
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  // Clear this agent's chat history
  const handleClearHistory = () => {
    fetch(`/api/chat/${agentId}`, { method: "DELETE" }).catch(() => {});
    setMessages(buildInitialMessages(config));
    setHasSavedHistory(false);
  };

  // Build conversation history to send to LLM (skip the pre-loaded initial AI briefing)
  const buildHistory = (msgs: ChatMsg[]) => {
    const initCount = config.initialMessages.length;
    return msgs.slice(initCount).map((m) => ({
      role: m.role === "ai" ? "assistant" as const : "user" as const,
      content: m.text,
    }));
  };

  // Calls the agent endpoint with up to 3 attempts, consuming the SSE stream
  // (text deltas + tool start/end) so `onUpdate` can render progressively —
  // Claude Code style — instead of the whole turn appearing at once. Network/
  // proxy disconnects on long-running LLM responses are common, so we retry
  // transparently while the typing indicator stays visible; a retry resets
  // the partial text/steps rendered by the failed attempt. 4xx responses
  // (auth, validation) still arrive as plain JSON before streaming starts and
  // are NOT retried; failures once streaming has begun arrive as an SSE
  // `error` frame instead (see server/routes.ts) and ARE retried.
  const callKimi = async (
    userText: string,
    history: { role: "user" | "assistant"; content: string }[],
    onUpdate: (state: { text: string; steps: ToolStep[] }) => void,
  ) => {
    const body = JSON.stringify({
      agentId,
      messages: [...history, { role: "user", content: userText }],
    });
    let lastErr: unknown = new Error("Network error");
    for (let attempt = 0; attempt < 3; attempt++) {
      let text = "";
      const steps: ToolStep[] = [];
      const stepIndexByCallId = new Map<string, number>();
      try {
        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as any;
          const error = new Error(err.message || "API error");
          // Definite client errors → don't retry, fail fast.
          if (res.status >= 400 && res.status < 500) throw error;
          lastErr = error;
        } else if (!res.body) {
          lastErr = new Error("No response stream");
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let done: { text: string; steps: ToolStep[] } | null = null;
          let streamErr: string | null = null;
          while (true) {
            const { done: readerDone, value } = await reader.read();
            if (readerDone) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const chunk = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              if (!chunk.startsWith("data: ")) continue;
              const event = JSON.parse(chunk.slice(6));
              if (event.type === "text") {
                text += event.delta;
                onUpdate({ text, steps: [...steps] });
              } else if (event.type === "tool-start") {
                steps.push({ toolName: event.toolName, args: event.args });
                stepIndexByCallId.set(event.toolCallId, steps.length - 1);
                onUpdate({ text, steps: [...steps] });
              } else if (event.type === "tool-end") {
                const i = stepIndexByCallId.get(event.toolCallId);
                if (i !== undefined) steps[i] = { ...steps[i], isError: event.isError, resultPreview: event.resultPreview };
                onUpdate({ text, steps: [...steps] });
              } else if (event.type === "done") {
                done = { text: event.text, steps: event.steps ?? steps };
              } else if (event.type === "error") {
                streamErr = event.message || "API error";
              }
            }
            if (done || streamErr) break;
          }
          if (done) return done;
          if (streamErr && /401|403|400|disabled|Not authenticated/i.test(streamErr)) throw new Error(streamErr);
          lastErr = new Error(streamErr || "Stream ended unexpectedly");
        }
      } catch (e: any) {
        // Re-throw 4xx without retrying.
        if (e?.message && /401|403|400|disabled|Not authenticated/i.test(e.message)) throw e;
        lastErr = e;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
      }
    }
    throw lastErr;
  };

  const handleChip = async (chip: ChipDef) => {
    if (isLoading) return;
    const userMsg: ChatMsg = { id: makeId(), role: "user", text: chip.label, ts: nowStr() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setIsLoading(true);
    const aiMsgId = makeId();
    let started = false;
    const onUpdate = (state: { text: string; steps: ToolStep[] }) => {
      if (!started) {
        started = true;
        setIsLoading(false);
        setMessages((m) => [...m, { id: aiMsgId, role: "ai", text: state.text, content: chip.response.content, ts: nowStr(), steps: state.steps }]);
      } else {
        setMessages((m) => m.map((msg) => (msg.id === aiMsgId ? { ...msg, text: state.text, steps: state.steps } : msg)));
      }
    };
    try {
      const history = buildHistory(messages);
      const { text: aiText, steps } = await callKimi(chip.label, history, onUpdate);
      const aiMsg: ChatMsg = { id: aiMsgId, role: "ai", text: aiText, content: chip.response.content, ts: nowStr(), steps };
      setMessages((m) => (started ? m.map((msg) => (msg.id === aiMsgId ? aiMsg : msg)) : [...m, aiMsg]));
      saveMessages(userMsg, aiMsg);
    } catch {
      const fallback = chip.response.text || t("agents_page.chat_error_fallback");
      const aiMsg: ChatMsg = { id: makeId(), role: "ai", text: fallback, content: chip.response.content, ts: nowStr() };
      setMessages((m) => [...m.filter((msg) => msg.id !== aiMsgId), aiMsg]);
      saveMessages(userMsg, aiMsg);
    } finally {
      setIsLoading(false);
    }
  };

  // The agent has no way to receive file bytes directly — but it does have a built-in
  // `image` tool that can fetch and view a plain image URL (png/jpeg/gif/webp only). We
  // host the upload ourselves and hand the agent that URL as part of the message text.
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setUploadError(t("agents_page.upload_not_image"));
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const res = await apiRequest("POST", "/api/chat/upload", { dataUrl });
      const { url } = await res.json();
      setPendingUpload({ url });
    } catch (err: any) {
      setUploadError(err?.message || t("agents_page.upload_failed"));
    } finally {
      setUploading(false);
    }
  };

  const handleFreeText = async () => {
    const text = input.trim();
    const attachment = pendingUpload;
    if ((!text && !attachment) || isLoading) return;
    const userMsg: ChatMsg = { id: makeId(), role: "user", text, ts: nowStr(), attachmentUrl: attachment?.url };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setPendingUpload(null);
    setIsLoading(true);
    const aiMsgId = makeId();
    let started = false;
    const onUpdate = (state: { text: string; steps: ToolStep[] }) => {
      if (!started) {
        started = true;
        setIsLoading(false);
        setMessages((m) => [...m, { id: aiMsgId, role: "ai", text: state.text, ts: nowStr(), steps: state.steps }]);
      } else {
        setMessages((m) => m.map((msg) => (msg.id === aiMsgId ? { ...msg, text: state.text, steps: state.steps } : msg)));
      }
    };
    try {
      const history = buildHistory(messages);
      const taskId = pendingTaskId.current;
      const taskContext = taskId ? (AGENT_TASK_CONTEXTS[agentId]?.[taskId] ?? null) : null;
      if (taskId) pendingTaskId.current = null;
      const withTask = taskContext ? `${taskContext}\n\nUser's data: ${text}` : text;
      const llmText = attachment
        ? `${withTask}\n\n[User attached an image. Use the image tool to view it: ${attachment.url}]`
        : withTask;
      const { text: aiText, steps } = await callKimi(llmText, history, onUpdate);
      const aiMsg: ChatMsg = { id: aiMsgId, role: "ai", text: aiText, ts: nowStr(), steps };
      setMessages((m) => (started ? m.map((msg) => (msg.id === aiMsgId ? aiMsg : msg)) : [...m, aiMsg]));
      saveMessages(userMsg, aiMsg);
    } catch {
      // After 3 retries already exhausted in callKimi — only now surface a fallback.
      // We do NOT persist this error message to history.
      const aiMsg: ChatMsg = { id: makeId(), role: "ai", text: t("agents_page.chat_error_fallback"), ts: nowStr() };
      setMessages((m) => [...m.filter((msg) => msg.id !== aiMsgId), aiMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  if (!user) return null;

  if (showRestaurantGate) {
    const AgentIcon = config.icon;
    return (
      <AdminLayout chatMode>
        <div className="flex flex-col flex-1 overflow-hidden h-full items-center justify-center">
          <div className="w-full max-w-2xl mx-auto px-6 py-12">
            <div className="bg-card border border-border rounded-2xl p-8 shadow-lg">
              <div className="mb-6 text-center">
                <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3", config.avatar)}>
                  <AgentIcon className="w-6 h-6 text-white" />
                </div>
                <h2 className="font-serif text-xl font-bold text-foreground">{t("agents_page.setup_gate_title")}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t("agents_page.setup_gate_desc", { name: config.name })}</p>
              </div>
              <RestaurantSetupFlow
                onComplete={() => {
                  queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
                  navigate("/admin/agents/expert");
                }}
              />
            </div>
          </div>
        </div>
      </AdminLayout>
    );
  }

  const avatarClass = AGENT_AVATAR_CLASSES[agentId] ?? "bg-primary";

  return (
    <AdminLayout chatMode>
      <div className="flex flex-col flex-1 overflow-hidden h-full relative">
        {/* Payment modal scoped to chat window */}
        {paymentTask && (
          <PaymentModal
            task={paymentTask}
            onClose={() => setPaymentTask(null)}
            onSuccess={handlePaymentSuccess}
            successText={paymentTask.id.startsWith("__hire_") ? t("agents_page.payment_agent_active", { name: config.name }) : t("agents_page.payment_launching")}
          />
        )}

        {/* Header */}
        <div className="flex-shrink-0 px-5 py-3 border-b border-border bg-card flex items-center gap-3">
          <div className={cn("w-8 h-8 rounded-full flex items-center justify-center", avatarClass)}>
            <config.icon className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">{config.name}</p>
            <p className="text-sm text-muted-foreground">{config.role}</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {hasSavedHistory && (
              <button
                onClick={handleClearHistory}
                data-testid="btn-clear-chat"
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive transition-colors"
                title={t("agents_page.chat_clear_title")}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{t("agents_page.chat_clear")}</span>
              </button>
            )}
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-sm text-green-700 font-medium">{t("agents_page.chat_active")}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">

          {/* Chat */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectMode && (
              <div className="flex-shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 py-2.5 bg-muted/40 border-b border-border" data-testid="select-mode-bar">
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={exitSelectMode} data-testid="btn-cancel-select">
                    <X className="w-4 h-4 mr-1" /> {t("agents_page.chat_cancel")}
                  </Button>
                  <span className="text-sm font-medium text-foreground" data-testid="text-selected-count">
                    {t("agents_page.chat_selected", { count: selectedIds.size })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={selectAllMessages} data-testid="btn-select-all">
                    {t("agents_page.chat_select_all")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={selectedIds.size === 0}
                    onClick={() => setConfirmDeleteOpen(true)}
                    data-testid="btn-delete-selected"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                    {t("agents_page.chat_delete")}
                  </Button>
                </div>
              </div>
            )}
            <div ref={chatContainerRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-5" data-testid="agent-chat-thread">
              {!historyLoaded && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {historyLoaded && awaitingOnboarding && (
                <div className="flex gap-3 w-full">
                  <div className={cn("w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5", avatarClass)}>
                    <config.icon className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <span className="text-sm font-semibold text-foreground">{config.name}</span>
                    </div>
                    <div className="rounded-xl px-4 py-3 text-sm leading-relaxed bg-card border border-border text-foreground">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                        <span>{t("agents_page.expert_onboarding_generating", { defaultValue: "正在生成餐厅运营诊断，大约需要 10 秒…" })}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {historyLoaded && hasMoreHistory && (
                <div className="flex justify-center py-2">
                  <button
                    onClick={loadMoreHistory}
                    disabled={loadingMore}
                    className="text-xs text-muted-foreground hover:text-foreground border border-border rounded-full px-4 py-1.5 transition-colors disabled:opacity-50"
                  >
                    {loadingMore ? (
                      <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading...</span>
                    ) : (
                      "Load More"
                    )}
                  </button>
                </div>
              )}
              {messages.map((msg, idx) => (
                <div key={msg.id}>
                  {msg.id.startsWith("saved-") && (idx === 0 || !messages[idx - 1].id.startsWith("saved-")) && (
                    <div className="flex items-center gap-3 py-2 mb-1">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{t("agents_page.chat_previous_session")}</span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                  )}
                <div
                  className={cn("flex gap-3 w-full", msg.role === "user" ? "flex-row-reverse max-w-lg ml-auto" : "")}
                  data-testid={`msg-${msg.role}-${msg.id}`}>

                  {msg.role === "ai" && (
                    <div className={cn("w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5", avatarClass)}>
                      <config.icon className="w-4 h-4 text-white" />
                    </div>
                  )}

                  <div className={cn("flex-1 min-w-0", msg.role === "user" && "text-right")}>
                    <div className={cn("flex items-baseline gap-2 mb-1.5", msg.role === "user" && "flex-row-reverse")}>
                      <span className="text-sm font-semibold text-foreground">{msg.role === "ai" ? config.name : t("agents_page.chat_you")}</span>
                      <span className="text-sm text-muted-foreground">{msg.ts}</span>
                    </div>
                    {msg.role === "ai" && msg.steps && msg.steps.length > 0 && (
                      <ToolStepsBlock steps={msg.steps} />
                    )}
                    {msg.attachmentUrl && (
                      <img
                        src={msg.attachmentUrl}
                        alt=""
                        className={cn("max-w-[220px] rounded-xl mb-1.5", msg.role === "user" && "ml-auto")}
                        data-testid={`img-attachment-${msg.id}`}
                      />
                    )}
                    {msg.text && (
                      <MessageBubble
                        className={cn("rounded-xl px-4 py-3 text-sm leading-relaxed",
                          msg.role === "ai" ? "bg-card border border-border text-foreground" : "bg-primary text-primary-foreground")}
                        selectMode={selectMode}
                        selected={selectedIds.has(msg.id)}
                        onLongPress={() => enterSelectMode(msg.id)}
                        onToggleSelect={() => toggleSelectMessage(msg.id)}
                      >
                        {msg.role === "ai" ? <ChatMarkdown text={msg.text} /> : msg.text}
                      </MessageBubble>
                    )}
                    {msg.content && <div>{msg.content}</div>}
                    {msg.id === "init-0" && isKnownAgentId(agentId) && (
                      <AgentIntroContent
                        agentId={agentId}
                        agentName={config.name}
                        onTaskClick={handleTaskClick}
                        onHireClick={() => setPaymentTask(hireTask)}
                        hired={hiredAgents.has(agentId)}
                      />
                    )}
                  </div>
                </div>
                </div>
              ))}

              {/* Typing indicator */}
              {isLoading && (
                <div className="flex gap-3 w-full">
                  <div className={cn("w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0", avatarClass)}>
                    <config.icon className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <span className="text-sm font-semibold text-foreground">{config.name}</span>
                    </div>
                    <div className="bg-card border border-border rounded-xl px-4 py-3.5 inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                      <span className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                      <span className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 border-t border-border bg-card px-4 sm:px-6 pt-3 pb-4">
              <div className="mb-4">
                <ChipBar chips={config.chips} onSend={handleChip} />
              </div>
              {(pendingUpload || uploading) && (
                <div className="flex items-center gap-2 mb-2.5 px-1">
                  <div className="relative w-12 h-12 rounded-lg overflow-hidden border border-border bg-muted flex items-center justify-center flex-shrink-0">
                    {uploading ? (
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    ) : (
                      <img src={pendingUpload!.url} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                  {!uploading && (
                    <button
                      onClick={() => setPendingUpload(null)}
                      className="text-xs text-muted-foreground hover:text-destructive"
                      data-testid="button-remove-upload"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
              {uploadError && <p className="text-xs text-destructive mb-2 px-1">{uploadError}</p>}
              <div className="flex items-center gap-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileSelect}
                  data-testid="input-agent-upload"
                />
                <UITooltip>
                  <UITooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isLoading || uploading}
                      style={{ height: '52px', width: '52px' }}
                      className="flex-shrink-0 rounded-xl"
                      data-testid="button-agent-attach">
                      <Paperclip className="w-4.5 h-4.5" />
                    </Button>
                  </UITooltipTrigger>
                  <UITooltipContent side="top">
                    <span className="text-xs">{t("agents_page.upload_attach_image")}</span>
                  </UITooltipContent>
                </UITooltip>
                <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if ((e.metaKey || e.altKey) && (input.trim() || pendingUpload) && !isLoading) {
                        handleFreeText();
                      }
                    }
                  }}
                  placeholder={isLoading ? t("agents_page.chat_thinking", { name: config.name }) : t("agents_page.chat_placeholder", { name: config.name })}
                  disabled={isLoading}
                  style={{ minHeight: '52px' }}
                  className="flex-1 text-sm px-4 py-3 rounded-xl border border-border/80 bg-muted/30 text-foreground placeholder:text-muted-foreground/75 outline-none ring-2 ring-primary/25 focus:ring-primary/40 focus:border-primary/50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  data-testid="input-agent-chat" />
                <UITooltip>
                  <UITooltipTrigger asChild>
                    <Button onClick={handleFreeText} disabled={(!input.trim() && !pendingUpload) || isLoading}
                      size="icon"
                      style={{ height: '52px', width: '52px' }}
                      className="flex-shrink-0 bg-primary text-primary-foreground rounded-xl shadow-sm active:scale-95 transition-transform"
                      data-testid="button-agent-send">
                      <Send className="w-5 h-5" />
                    </Button>
                  </UITooltipTrigger>
                  <UITooltipContent side="top">
                    <span className="text-xs">Send · ⌘/Alt + Enter</span>
                  </UITooltipContent>
                </UITooltip>
              </div>
            </div>
          </div>

          {/* Right panel */}
          <AgentContextPanel config={config} agentId={agentId} restaurant={restaurantData?.restaurants?.[0]} />
        </div>
      </div>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent data-testid="dialog-confirm-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("agents_page.chat_delete_confirm_title", { count: selectedIds.size })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("agents_page.chat_delete_confirm_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-confirm-cancel">
              {t("agents_page.chat_cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteSelectedMessages}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="btn-confirm-delete"
            >
              {t("agents_page.chat_delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
