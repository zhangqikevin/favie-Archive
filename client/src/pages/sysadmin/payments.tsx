import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import SysAdminLayout from "@/components/sysadmin-layout";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface PaymentRecord {
  id: string;
  userId: string;
  userEmail: string;
  kind: string;
  packageId: string | null;
  agentId: string | null;
  amountCents: number;
  status: "initiated" | "succeeded" | "failed";
  failureReason: string | null;
  createdAt: string;
}

interface Customer { id: string; email: string }
interface AgentPackage { id: string; name: string; priceCents: number }
interface AgentEntry { id: string; name: string; individualPriceCents: number }

const KIND_LABEL: Record<string, string> = {
  package_subscribe: "订阅套餐",
  addon_purchase: "单独加购 Agent",
  renewal: "续费",
};

function statusBadge(status: PaymentRecord["status"]) {
  if (status === "succeeded") return <Badge>succeeded</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="secondary">initiated</Badge>;
}

function SimulatePaymentDialog({ customers, packages, agents, onClose }: {
  customers: Customer[]; packages: AgentPackage[]; agents: AgentEntry[]; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState(customers[0]?.id ?? "");
  const [kind, setKind] = useState<"package_subscribe" | "addon_purchase" | "renewal">("package_subscribe");
  const [packageId, setPackageId] = useState(packages[0]?.id ?? "");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [amountDollars, setAmountDollars] = useState("0.00");
  const [outcome, setOutcome] = useState<"succeeded" | "failed">("succeeded");
  const [failureReason, setFailureReason] = useState("card_declined");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/sysadmin/payments/simulate", {
        userId,
        kind,
        packageId: kind === "addon_purchase" ? null : (packageId || null),
        agentId: kind === "addon_purchase" ? (agentId || null) : null,
        amountCents: Math.round(parseFloat(amountDollars || "0") * 100),
        outcome,
        failureReason: outcome === "failed" ? failureReason : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/payments"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>模拟一笔支付</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">客户</label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">类型</label>
            <Select value={kind} onValueChange={(v: any) => setKind(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="package_subscribe">订阅套餐</SelectItem>
                <SelectItem value="addon_purchase">单独加购 Agent</SelectItem>
                <SelectItem value="renewal">续费</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "addon_purchase" ? (
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">Agent</label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">套餐</label>
              <Select value={packageId} onValueChange={setPackageId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {packages.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">金额（美元）</label>
            <Input type="number" step="0.01" min="0" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">结果</label>
            <Select value={outcome} onValueChange={(v: any) => setOutcome(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="succeeded">succeeded</SelectItem>
                <SelectItem value="failed">failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {outcome === "failed" && (
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">失败原因</label>
              <Input value={failureReason} onChange={(e) => setFailureReason(e.target.value)} />
            </div>
          )}
          <div className="flex gap-2 justify-end pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={() => mutation.mutate()} disabled={!userId || mutation.isPending}>
              {mutation.isPending ? "提交中…" : "生成支付记录"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function SysAdminPayments() {
  const [simulating, setSimulating] = useState(false);
  const { data: paymentsData } = useQuery<{ payments: PaymentRecord[] }>({ queryKey: ["/api/sysadmin/payments"] });
  const { data: customersData } = useQuery<{ customers: Customer[] }>({ queryKey: ["/api/sysadmin/customers"] });
  const { data: packagesData } = useQuery<{ packages: AgentPackage[] }>({ queryKey: ["/api/sysadmin/packages"] });
  const { data: agentsData } = useQuery<{ agents: AgentEntry[] }>({ queryKey: ["/api/sysadmin/agents"] });

  const payments = paymentsData?.payments ?? [];
  const customers = customersData?.customers ?? [];
  const packages = packagesData?.packages ?? [];
  const agents = agentsData?.agents ?? [];
  const packageById = new Map(packages.map((p) => [p.id, p.name]));
  const agentById = new Map(agents.map((a) => [a.id, a.name]));

  return (
    <SysAdminLayout>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-foreground">支付记录</h1>
        <Button size="sm" onClick={() => setSimulating(true)} disabled={customers.length === 0}>模拟一笔支付</Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">当前支付网关为 mock（未接真实 Stripe），记录发起 / 成功 / 失败事件，供未来接入真实支付时复用同一套结构。</p>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>客户</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>对象</TableHead>
              <TableHead>金额</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>失败原因</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(p.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>{p.userEmail}</TableCell>
                <TableCell>{KIND_LABEL[p.kind] ?? p.kind}</TableCell>
                <TableCell className="text-sm">
                  {p.packageId ? (packageById.get(p.packageId) ?? p.packageId) : ""}
                  {p.agentId ? (agentById.get(p.agentId) ?? p.agentId) : ""}
                </TableCell>
                <TableCell>${(p.amountCents / 100).toFixed(2)}</TableCell>
                <TableCell>{statusBadge(p.status)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{p.failureReason ?? ""}</TableCell>
              </TableRow>
            ))}
            {payments.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">还没有支付记录</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {simulating && (
        <SimulatePaymentDialog
          customers={customers} packages={packages} agents={agents}
          onClose={() => setSimulating(false)}
        />
      )}
    </SysAdminLayout>
  );
}
