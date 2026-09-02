import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import SysAdminLayout from "@/components/sysadmin-layout";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface AgentEntry {
  id: string;
  name: string;
  visible: boolean;
  individualPriceCents: number;
}

interface AgentPackage {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  monthlyTokenQuota: number;
  active: boolean;
  agentIds: string[];
}

function dollars(cents: number) {
  return (cents / 100).toFixed(2);
}

function PackageDialog({ initial, agents, onClose }: {
  initial: Partial<AgentPackage> | null;
  agents: AgentEntry[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isNew = !initial?.id;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [priceDollars, setPriceDollars] = useState(dollars(initial?.priceCents ?? 0));
  const [tokenQuota, setTokenQuota] = useState(String(initial?.monthlyTokenQuota ?? 0));
  const [active, setActive] = useState(initial?.active ?? true);
  const [agentIds, setAgentIds] = useState<string[]>(initial?.agentIds ?? []);

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        name, description,
        priceCents: Math.round(parseFloat(priceDollars || "0") * 100),
        monthlyTokenQuota: parseInt(tokenQuota || "0", 10),
        active, agentIds,
      };
      return isNew
        ? apiRequest("POST", "/api/sysadmin/packages", body)
        : apiRequest("PATCH", `/api/sysadmin/packages/${initial!.id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/packages"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? "新建套餐" : `编辑套餐 — ${initial?.name}`}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">套餐名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">描述</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">月价格（美元）</label>
              <Input type="number" step="0.01" min="0" value={priceDollars} onChange={(e) => setPriceDollars(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">每月 Token 数量</label>
              <Input type="number" min="0" value={tokenQuota} onChange={(e) => setTokenQuota(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm text-muted-foreground">上架（客户可订阅）</label>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">套餐包含的 Agent</label>
            <div className="border border-border rounded-lg divide-y divide-border max-h-48 overflow-y-auto">
              {agents.map((a) => (
                <label key={a.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                  <Checkbox
                    checked={agentIds.includes(a.id)}
                    onCheckedChange={(v) =>
                      setAgentIds((cur) => (v ? [...cur, a.id] : cur.filter((id) => id !== a.id)))
                    }
                  />
                  <span className="flex-1">{a.name}</span>
                  {!a.visible && <span className="text-xs text-muted-foreground">（前台隐藏）</span>}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={!name || saveMutation.isPending}>
              {saveMutation.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentPricingRow({ agent, bundledInPackages }: { agent: AgentEntry; bundledInPackages: string[] }) {
  const queryClient = useQueryClient();
  const isBundled = bundledInPackages.length > 0;

  const patch = useMutation({
    mutationFn: (body: Partial<{ visible: boolean }>) =>
      apiRequest("PATCH", `/api/sysadmin/agents/${agent.id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/agents"] }),
  });

  return (
    <TableRow>
      <TableCell className="font-medium">{agent.name}</TableCell>
      <TableCell>
        {isBundled ? (
          <span className="text-xs text-muted-foreground">
            已包含在「{bundledInPackages.join("、")}」套餐中，不支持单独购买
          </span>
        ) : (
          <Switch checked={agent.visible} onCheckedChange={(v) => patch.mutate({ visible: v })} />
        )}
      </TableCell>
      <TableCell>
        {isBundled ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="text-sm text-foreground">${dollars(agent.individualPriceCents)}/mo</span>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function SysAdminProducts() {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Partial<AgentPackage> | null | "new">(null);

  const { data: packagesData } = useQuery<{ packages: AgentPackage[] }>({ queryKey: ["/api/sysadmin/packages"] });
  const { data: agentsData } = useQuery<{ agents: AgentEntry[] }>({ queryKey: ["/api/sysadmin/agents"] });
  const packages = packagesData?.packages ?? [];
  const agents = agentsData?.agents ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/sysadmin/packages/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/packages"] }),
  });

  return (
    <SysAdminLayout>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-foreground">产品管理</h1>
        <Button size="sm" onClick={() => setDialog("new")}>新建套餐</Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">配置订阅套餐（包含哪些 Agent、价格、每月 Token 额度），以及每个 Agent 是否可单独购买。</p>

      <div className="bg-card border border-border rounded-xl overflow-hidden mb-8">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>套餐</TableHead>
              <TableHead>包含 Agent 数</TableHead>
              <TableHead>月价格</TableHead>
              <TableHead>每月 Token</TableHead>
              <TableHead>状态</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {packages.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>{p.agentIds.length}</TableCell>
                <TableCell>${dollars(p.priceCents)}/mo</TableCell>
                <TableCell>{p.monthlyTokenQuota.toLocaleString()}</TableCell>
                <TableCell>{p.active ? <Badge>上架中</Badge> : <Badge variant="secondary">已下架</Badge>}</TableCell>
                <TableCell className="text-right space-x-2">
                  <Button size="sm" variant="outline" onClick={() => setDialog(p)}>编辑</Button>
                  <Button
                    size="sm" variant="outline"
                    onClick={() => { if (confirm(`删除套餐「${p.name}」？`)) deleteMutation.mutate(p.id); }}
                  >
                    删除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <h2 className="text-base font-semibold text-foreground mb-1">单购 Agent 管理</h2>
      <p className="text-sm text-muted-foreground mb-3">
        控制哪些 Agent 可以被单独购买。已经包含在某个订阅套餐里的 Agent，默认不支持单独购买——从所有套餐移除后才会恢复可单独购买。单独购买价格请在「Agent 管理」中设置。
      </p>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>可单独购买</TableHead>
              <TableHead>单独购买价格</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((a) => (
              <AgentPricingRow
                key={a.id}
                agent={a}
                bundledInPackages={packages.filter((p) => p.agentIds.includes(a.id)).map((p) => p.name)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {dialog && (
        <PackageDialog
          initial={dialog === "new" ? null : dialog}
          agents={agents}
          onClose={() => setDialog(null)}
        />
      )}
    </SysAdminLayout>
  );
}
