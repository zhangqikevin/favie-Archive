import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import SysAdminLayout from "@/components/sysadmin-layout";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2 } from "lucide-react";

interface AgentEntry {
  id: string;
  key: string;
  name: string;
  description: string | null;
  model: string | null;
  personaPrompt: string;
  skillIds: string[];
  visible: boolean;
  individualPriceCents: number;
}

interface ZooworkModel { model: string; display_name?: string }
interface ZooworkSkill { skill_id?: string; id?: string; name?: string; description?: string }
interface McpServerEntry { id: string; name: string; description: string | null }

function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agent";
}

// Skills are declared state on the catalog row (see PUT .../skills) — each
// customer's own ZooWork agent picks the change up lazily on their next chat
// turn, so this never calls ZooWork directly.
function SkillsSection({ agentId, skillIds, onChange }: { agentId: string; skillIds: string[]; onChange: (ids: string[]) => void }) {
  const queryClient = useQueryClient();
  const { data: orgSkills } = useQuery<{ skills: ZooworkSkill[] }>({ queryKey: ["/api/sysadmin/zoowork/skills"] });

  const save = useMutation({
    mutationFn: (ids: string[]) => apiRequest("PUT", `/api/sysadmin/agents/${agentId}/skills`, { skillIds: ids }),
    onSuccess: (_data, ids) => {
      onChange(ids);
      queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/agents"] });
    },
  });

  const skills = orgSkills?.skills ?? [];
  const attachedIds = new Set(skillIds);

  if (skills.length === 0) {
    return <p className="text-sm text-muted-foreground">当前组织在 ZooWork 上还没有已上传的 skill。</p>;
  }

  return (
    <div className="border border-border rounded-lg divide-y divide-border max-h-48 overflow-y-auto">
      {skills.map((s) => {
        const id = s.skill_id ?? s.id ?? "";
        const checked = attachedIds.has(id);
        return (
          <label key={id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
            <Checkbox
              checked={checked}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate(v ? [...skillIds, id] : skillIds.filter((s2) => s2 !== id))}
            />
            <span className="flex-1">
              <span className="font-medium">{s.name ?? id}</span>
              {s.description && <span className="text-xs text-muted-foreground block">{s.description}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

// Which MCP servers this agent template offers. A customer still needs their
// own saved credential (via the chat panel's Connect button) before it's
// actually attached to their ZooWork agent.
function McpServersSection({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const { data: allServers } = useQuery<{ mcpServers: McpServerEntry[] }>({ queryKey: ["/api/sysadmin/mcp-servers"] });
  const { data: bound } = useQuery<{ mcpServerIds: string[] }>({ queryKey: [`/api/sysadmin/agents/${agentId}/mcp-servers`] });

  const save = useMutation({
    mutationFn: (ids: string[]) => apiRequest("PUT", `/api/sysadmin/agents/${agentId}/mcp-servers`, { mcpServerIds: ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/sysadmin/agents/${agentId}/mcp-servers`] }),
  });

  const servers = allServers?.mcpServers ?? [];
  const boundIds = bound?.mcpServerIds ?? [];
  const boundSet = new Set(boundIds);

  if (servers.length === 0) {
    return <p className="text-sm text-muted-foreground">还没有在"MCP 设置"里配置任何 MCP 服务。</p>;
  }

  return (
    <div className="border border-border rounded-lg divide-y divide-border max-h-48 overflow-y-auto">
      {servers.map((s) => {
        const checked = boundSet.has(s.id);
        return (
          <label key={s.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
            <Checkbox
              checked={checked}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate(v ? [...boundIds, s.id] : boundIds.filter((id) => id !== s.id))}
            />
            <span className="flex-1">
              <span className="font-medium">{s.name}</span>
              {s.description && <span className="text-xs text-muted-foreground block">{s.description}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function AgentEditorDialog({ initial, onClose }: { initial: AgentEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [agent, setAgent] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [model, setModel] = useState(initial.model ?? "");
  const [personaPrompt, setPersonaPrompt] = useState(initial.personaPrompt);
  const [visible, setVisible] = useState(initial.visible);
  const [priceDollars, setPriceDollars] = useState((initial.individualPriceCents / 100).toString());

  const { data: modelsData } = useQuery<{ models: ZooworkModel[] }>({ queryKey: ["/api/sysadmin/zoowork/models"] });
  const { data: previewStatus } = useQuery<{ zooworkAgentId: string | null }>({
    queryKey: [`/api/sysadmin/agents/${agent.id}/preview-status`],
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `/api/sysadmin/agents/${agent.id}`, {
        name, description, model: model || null, personaPrompt,
        visible, individualPriceCents: Math.round(parseFloat(priceDollars || "0") * 100),
      }).then((r) => r.json()),
    onSuccess: (json) => {
      setAgent(json.agent);
      queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/agents"] });
      onClose();
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/sysadmin/agents/${agent.id}/sync`, {}).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/sysadmin/agents/${agent.id}/preview-status`] });
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{agent.name} <span className="text-xs text-muted-foreground font-normal">({agent.key})</span></DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">简介</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">模型</label>
            <Select value={model || "__default"} onValueChange={(v) => setModel(v === "__default" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="平台默认" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default">平台默认</SelectItem>
                {(modelsData?.models ?? []).map((m) => (
                  <SelectItem key={m.model} value={m.model}>{m.display_name ?? m.model}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">Prompt / 人设(AGENTS.md)</label>
            <Textarea
              value={personaPrompt}
              onChange={(e) => setPersonaPrompt(e.target.value)}
              className="min-h-[160px] font-mono text-sm"
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm text-muted-foreground">前台可见</label>
            <Switch checked={visible} onCheckedChange={setVisible} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">单独加购价格（美元/月）</label>
            <Input type="number" step="0.01" min="0" value={priceDollars} onChange={(e) => setPriceDollars(e.target.value)} />
          </div>

          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">测试同步状态：</span>
              {previewStatus?.zooworkAgentId
                ? <Badge variant="default">{previewStatus.zooworkAgentId}</Badge>
                : <Badge variant="secondary">尚未创建</Badge>}
            </div>
            <Button size="sm" variant="outline" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
              {syncMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (previewStatus?.zooworkAgentId ? "重新测试同步" : "测试同步")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            这里只是用一个预览账号测试配置能否正确同步到 ZooWork，不影响任何真实客户。真实客户会在自己下次发消息时，自动同步到属于他们自己的 ZooWork agent。
          </p>

          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">Skills</label>
            <SkillsSection agentId={agent.id} skillIds={agent.skillIds} onChange={(ids) => setAgent((a) => ({ ...a, skillIds: ids }))} />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">MCP 服务</label>
            <McpServersSection agentId={agent.id} />
          </div>

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={onClose}>关闭</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewAgentDialog({ onCreated, onClose }: { onCreated: (a: AgentEntry) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    setError("");
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/sysadmin/agents", {
        key: key || slugify(name),
        name,
        description: "",
        model: null,
        personaPrompt: "",
        visible: true,
        individualPriceCents: 0,
      });
      const json = await res.json();
      onCreated(json.agent);
    } catch (err: any) {
      setError(err.message || "创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>新建 Agent</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">名称</label>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); if (!keyTouched) setKey(slugify(e.target.value)); }}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">Key（唯一标识，创建后不可改）</label>
            <Input value={key} onChange={(e) => { setKey(e.target.value); setKeyTouched(true); }} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={handleCreate} disabled={!name || !key || submitting}>
              {submitting ? "创建中…" : "创建并编辑"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function SysAdminAgents() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentEntry | null>(null);

  const { data } = useQuery<{ agents: AgentEntry[] }>({ queryKey: ["/api/sysadmin/agents"] });
  const agents = data?.agents ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/sysadmin/agents/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/agents"] }),
  });

  return (
    <SysAdminLayout>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-foreground">Agent 管理</h1>
        <Button size="sm" onClick={() => setCreating(true)}>新建 Agent</Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        创建和管理 ZooWork Managed Agent —— 人设、模型、skills、MCP 服务、上架状态与单独定价。每个客户会同步出自己独立的 ZooWork agent 实例，模板改了会在客户下次聊天时自动生效。
      </p>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>模型</TableHead>
              <TableHead>前台可见</TableHead>
              <TableHead>单独价格</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{a.key}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{a.model || "平台默认"}</TableCell>
                <TableCell>{a.visible ? <Badge>可见</Badge> : <Badge variant="secondary">隐藏</Badge>}</TableCell>
                <TableCell>${(a.individualPriceCents / 100).toFixed(2)}/mo</TableCell>
                <TableCell className="text-right space-x-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(a)}>编辑</Button>
                  <Button
                    size="sm" variant="outline"
                    onClick={() => { if (confirm(`删除 Agent「${a.name}」？`)) deleteMutation.mutate(a.id); }}
                  >
                    删除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {creating && (
        <NewAgentDialog
          onClose={() => setCreating(false)}
          onCreated={(a) => { setCreating(false); queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/agents"] }); setEditing(a); }}
        />
      )}
      {editing && <AgentEditorDialog initial={editing} onClose={() => setEditing(null)} />}
    </SysAdminLayout>
  );
}
