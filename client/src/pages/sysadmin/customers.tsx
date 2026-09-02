import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import SysAdminLayout from "@/components/sysadmin-layout";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Customer {
  id: string;
  email: string;
  restaurantCount: number;
  subscription: { packageId: string | null; addonAgentIds: string[]; status: string } | null;
}

interface AgentPackage {
  id: string;
  name: string;
  priceCents: number;
  agentIds: string[];
}

interface AgentEntry {
  id: string;
  name: string;
  individualPriceCents: number;
}

function fmtMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function EditSubscriptionDialog({ customer, packages, agents, onClose }: {
  customer: Customer;
  packages: AgentPackage[];
  agents: AgentEntry[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [packageId, setPackageId] = useState<string | null>(customer.subscription?.packageId ?? null);
  const [addonAgentIds, setAddonAgentIds] = useState<string[]>(customer.subscription?.addonAgentIds ?? []);
  const [status, setStatus] = useState(customer.subscription?.status ?? "active");

  const selectedPackage = packages.find((p) => p.id === packageId);
  const inPackageIds = new Set(selectedPackage?.agentIds ?? []);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest("PUT", `/api/sysadmin/customers/${customer.id}/subscription`, {
        packageId, addonAgentIds, status,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/customers"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑订阅 — {customer.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">套餐</label>
            <Select value={packageId ?? "none"} onValueChange={(v) => setPackageId(v === "none" ? null : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未订阅任何套餐</SelectItem>
                {packages.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name} · {fmtMoney(p.priceCents)}/mo</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">状态</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">active</SelectItem>
                <SelectItem value="canceled">canceled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">额外单独加购的 Agent</label>
            <div className="border border-border rounded-lg divide-y divide-border max-h-56 overflow-y-auto">
              {agents.map((a) => {
                const alreadyInPackage = inPackageIds.has(a.id);
                const checked = alreadyInPackage || addonAgentIds.includes(a.id);
                return (
                  <label key={a.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                    <Checkbox
                      checked={checked}
                      disabled={alreadyInPackage}
                      onCheckedChange={(v) =>
                        setAddonAgentIds((cur) => (v ? [...cur, a.id] : cur.filter((id) => id !== a.id)))
                      }
                    />
                    <span className="flex-1">{a.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {alreadyInPackage ? "已含在套餐内" : `+${fmtMoney(a.individualPriceCents)}/mo`}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function SysAdminCustomers() {
  const [editing, setEditing] = useState<Customer | null>(null);

  const { data: customersData } = useQuery<{ customers: Customer[] }>({ queryKey: ["/api/sysadmin/customers"] });
  const { data: packagesData } = useQuery<{ packages: AgentPackage[] }>({ queryKey: ["/api/sysadmin/packages"] });
  const { data: agentsData } = useQuery<{ agents: AgentEntry[] }>({ queryKey: ["/api/sysadmin/agents"] });

  const customers = customersData?.customers ?? [];
  const packages = packagesData?.packages ?? [];
  const agents = agentsData?.agents ?? [];
  const packageById = new Map(packages.map((p) => [p.id, p]));

  return (
    <SysAdminLayout>
      <h1 className="text-xl font-semibold text-foreground mb-1">客户管理</h1>
      <p className="text-sm text-muted-foreground mb-6">注册用户与订阅状态。</p>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>邮箱</TableHead>
              <TableHead>餐厅数</TableHead>
              <TableHead>套餐</TableHead>
              <TableHead>额外 Agent</TableHead>
              <TableHead>状态</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.email}</TableCell>
                <TableCell>{c.restaurantCount}</TableCell>
                <TableCell>
                  {c.subscription?.packageId
                    ? packageById.get(c.subscription.packageId)?.name ?? "—"
                    : <span className="text-muted-foreground">未订阅</span>}
                </TableCell>
                <TableCell>{c.subscription?.addonAgentIds.length ?? 0}</TableCell>
                <TableCell>
                  {c.subscription ? (
                    <Badge variant={c.subscription.status === "active" ? "default" : "secondary"}>
                      {c.subscription.status}
                    </Badge>
                  ) : "—"}
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="outline" onClick={() => setEditing(c)}>编辑订阅</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <EditSubscriptionDialog
          customer={editing}
          packages={packages}
          agents={agents}
          onClose={() => setEditing(null)}
        />
      )}
    </SysAdminLayout>
  );
}
