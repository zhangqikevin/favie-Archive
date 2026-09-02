import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2, Loader2, Truck, CreditCard } from "lucide-react";

const SESSION_SKIP_KEY = "favie_onboarding_step3_skipped";

// apiRequest throws `${status}: ${rawBodyText}` on a non-OK response (see
// queryClient.ts) — the body is usually `{"message": "..."}` JSON. Pull the
// human-readable message back out instead of showing that raw blob.
function friendlyErrorMessage(err: unknown, fallback: string): string {
  const raw = (err as Error)?.message ?? "";
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return raw || fallback;
  try {
    const parsed = JSON.parse(raw.slice(jsonStart));
    return parsed.message || fallback;
  } catch {
    return raw || fallback;
  }
}

interface PlatformStatus { connected: boolean; hasApiKey: boolean }
interface OnboardingStatus {
  restaurant: { id: string; name: string; address: string } | null;
  platforms: Record<string, PlatformStatus>;
  step2Complete: boolean;
  favieKeyConnected: boolean;
}

const DELIVERY_PLATFORMS = [
  { key: "ubereats", name: "Uber Eats" },
  { key: "doordash", name: "DoorDash" },
];
const API_KEY_POS = [
  { key: "toast", name: "Toast" },
  { key: "square", name: "Square" },
];
const PERMISSION_POS = [
  { key: "chowbus", name: "Chowbus" },
  { key: "menusifu", name: "MenuSifu" },
];

function PermissionPlatformRow({ platformKey, name, connected }: { platformKey: string; name: string; connected: boolean }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const verify = useMutation({
    mutationFn: () => apiRequest("POST", `/api/onboarding/platform/${platformKey}/verify`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setExpanded(false);
    },
  });

  return (
    <div className="rounded-lg border border-border bg-background overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="text-sm font-medium text-foreground flex-1">{name}</span>
        {connected ? (
          <span className="text-xs font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> 已连接
          </span>
        ) : (
          <button onClick={() => setExpanded((v) => !v)} className="text-xs text-primary hover:underline">
            {expanded ? "取消" : "连接"}
          </button>
        )}
      </div>
      {expanded && !connected && (
        <div className="px-3 pb-3 border-t border-border pt-2.5 space-y-2">
          <p className="text-xs text-muted-foreground leading-relaxed">
            请在 {name} 商家后台的用户管理里，给 <span className="font-mono">restaurants@zoowork.ai</span> 开通经理权限，完成后点击验证。
          </p>
          <Button size="sm" className="w-full h-7 text-xs" onClick={() => verify.mutate()} disabled={verify.isPending}>
            {verify.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "验证"}
          </Button>
          {verify.isError && <p className="text-xs text-destructive">{friendlyErrorMessage(verify.error, "验证失败")}</p>}
        </div>
      )}
    </div>
  );
}

function ApiKeyPlatformRow({ platformKey, name, connected }: { platformKey: string; name: string; connected: boolean }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState("");

  const save = useMutation({
    mutationFn: () => apiRequest("POST", `/api/onboarding/platform/${platformKey}/api-key`, { apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setExpanded(false);
      setApiKey("");
    },
  });

  return (
    <div className="rounded-lg border border-border bg-background overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="text-sm font-medium text-foreground flex-1">{name}</span>
        {connected ? (
          <span className="text-xs font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> 已连接
          </span>
        ) : (
          <button onClick={() => setExpanded((v) => !v)} className="text-xs text-primary hover:underline">
            {expanded ? "取消" : "连接"}
          </button>
        )}
      </div>
      {expanded && !connected && (
        <div className="px-3 pb-3 border-t border-border pt-2.5 space-y-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={`${name} API Key`}
            className="text-xs font-mono h-7"
          />
          <Button size="sm" className="w-full h-7 text-xs" onClick={() => save.mutate()} disabled={save.isPending || !apiKey.trim()}>
            {save.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "保存并验证"}
          </Button>
          {save.isError && <p className="text-xs text-destructive">{friendlyErrorMessage(save.error, "保存失败")}</p>}
        </div>
      )}
    </div>
  );
}

function StepTwo({ status, onContinue }: { status: OnboardingStatus; onContinue: () => void }) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5"><Truck className="w-4 h-4" /> 外卖数据</p>
        <div className="space-y-2">
          {DELIVERY_PLATFORMS.map((p) => (
            <PermissionPlatformRow key={p.key} platformKey={p.key} name={p.name} connected={!!status.platforms[p.key]?.connected} />
          ))}
        </div>
      </div>
      <div>
        <p className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5"><CreditCard className="w-4 h-4" /> POS 数据</p>
        <div className="space-y-2">
          {API_KEY_POS.map((p) => (
            <ApiKeyPlatformRow key={p.key} platformKey={p.key} name={p.name} connected={!!status.platforms[p.key]?.connected} />
          ))}
          {PERMISSION_POS.map((p) => (
            <PermissionPlatformRow key={p.key} platformKey={p.key} name={p.name} connected={!!status.platforms[p.key]?.connected} />
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        至少需要连接一个外卖平台或 POS 系统，才能继续——Favie 需要至少一个能读取订单的数据源。
      </p>
      <Button className="w-full" onClick={onContinue} disabled={!status.step2Complete}>
        下一步
      </Button>
    </div>
  );
}

function StepThree({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");

  const validate = useMutation({
    mutationFn: () => apiRequest("POST", "/api/onboarding/favie-key", { apiKey }).then((r) => r.json()),
    onSuccess: (data) => {
      if (!data.valid) throw new Error(data.message || "Key 无效");
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      onDone();
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        数据同步完成后，Favie 会给你发一封邮件，里面包含专属的 <span className="font-medium text-foreground">Favie AI Key</span>。填在这里，你的 AI 智能体就能读取真实的订单数据了。
      </p>
      <Input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="Favie AI Key"
        className="font-mono"
      />
      {validate.isError && (
        <p className="text-sm text-destructive">{friendlyErrorMessage(validate.error, "验证失败")}</p>
      )}
      <Button className="w-full" onClick={() => validate.mutate()} disabled={validate.isPending || !apiKey.trim()}>
        {validate.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "验证并保存"}
      </Button>
      <button onClick={onSkip} className="text-xs text-muted-foreground hover:text-foreground transition-colors block mx-auto">
        还没收到邮件？稍后再填
      </button>
    </div>
  );
}

export default function RestaurantOnboardingModal() {
  const { user } = useAuth();
  const [step, setStep] = useState<2 | 3 | null>(null);
  const [justFinished, setJustFinished] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Auto-close the "connected!" success screen after 3s instead of waiting on
  // the invalidated query to refetch and flip favieKeyConnected on its own.
  useEffect(() => {
    if (!justFinished) return;
    const timer = setTimeout(() => setDismissed(true), 3000);
    return () => clearTimeout(timer);
  }, [justFinished]);

  // Scoped per user — otherwise one account's "skip for now" leaks into the
  // next account tested in the same browser tab/session.
  const skipKey = user ? `${SESSION_SKIP_KEY}:${user.id}` : null;
  const [skippedStep3, setSkippedStep3] = useState(false);
  useEffect(() => {
    setSkippedStep3(skipKey ? sessionStorage.getItem(skipKey) === "1" : false);
  }, [skipKey]);

  const { data } = useQuery<OnboardingStatus>({
    queryKey: ["/api/onboarding/status"],
    enabled: !!user,
  });

  // Resume at the right step exactly once per mount — never force the user
  // back through step 2 just because step 3 (the async Favie AI Key email)
  // isn't done yet.
  useEffect(() => {
    if (data && step === null) setStep(data.step2Complete ? 3 : 2);
  }, [data, step]);

  if (!user || !data || !data.restaurant || step === null) return null; // step 1 (no restaurant yet) is handled elsewhere
  if (dismissed) return null; // success screen finished its 3s and closed itself
  if (data.step2Complete && data.favieKeyConnected) return null; // fully onboarded
  if (step === 3 && !data.favieKeyConnected && skippedStep3 && !justFinished) return null;

  function handleSkip() {
    if (skipKey) sessionStorage.setItem(skipKey, "1");
    setSkippedStep3(true);
  }

  return (
    <Dialog open onOpenChange={() => { /* not user-dismissible except step 3's explicit skip */ }}>
      <DialogContent
        className="sm:max-w-md [&>button:last-child]:hidden"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>同步你的餐厅数据 · 第 {step} / 3 步</DialogTitle>
        </DialogHeader>
        {step === 2 ? (
          <StepTwo status={data} onContinue={() => setStep(3)} />
        ) : justFinished ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-green-600" />
            </div>
            <p className="text-sm font-medium text-foreground">数据同步已连接！</p>
          </div>
        ) : (
          <StepThree onDone={() => setJustFinished(true)} onSkip={handleSkip} />
        )}
      </DialogContent>
    </Dialog>
  );
}
