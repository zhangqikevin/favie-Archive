import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import SysAdminLayout from "@/components/sysadmin-layout";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface McpServerEntry {
  id: string;
  key: string;
  name: string;
  description: string | null;
  targetUrl: string;
  transport: string;
  authHeaderName: string;
  authScheme: string;
}

function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "mcp";
}

function McpServerDialog({ initial, onClose }: { initial: Partial<McpServerEntry> | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isNew = !initial?.id;
  const [name, setName] = useState(initial?.name ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(!isNew);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [targetUrl, setTargetUrl] = useState(initial?.targetUrl ?? "");
  const [transport, setTransport] = useState(initial?.transport ?? "streamable-http");
  const [authHeaderName, setAuthHeaderName] = useState(initial?.authHeaderName ?? "Authorization");
  const [authScheme, setAuthScheme] = useState(initial?.authScheme ?? "Bearer ");
  const [error, setError] = useState("");

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = { name, description, targetUrl, transport, authHeaderName, authScheme, ...(isNew ? { key: key || slugify(name) } : {}) };
      return isNew
        ? apiRequest("POST", "/api/sysadmin/mcp-servers", body)
        : apiRequest("PATCH", `/api/sysadmin/mcp-servers/${initial!.id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/mcp-servers"] });
      onClose();
    },
    onError: (err: any) => setError(err.message || "保存失败"),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? "新建 MCP 服务" : `编辑 MCP 服务 — ${initial?.name}`}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">名称</label>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); if (!keyTouched) setKey(slugify(e.target.value)); }}
            />
          </div>
          {isNew && (
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">Key（工具名前缀，不能有下划线，创建后不可改）</label>
              <Input value={key} onChange={(e) => { setKey(e.target.value); setKeyTouched(true); }} />
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">描述</label>
            <Textarea value={description ?? ""} onChange={(e) => setDescription(e.target.value)} className="min-h-[60px]" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">目标 MCP 服务器地址（真正需要鉴权的那个）</label>
            <Input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="https://api.example.com/mcp" />
            <p className="text-xs text-muted-foreground">
              ZooWork 只会看到我们自己的公开代理地址（mcp.favie.us），这个真实地址和客户的 key 只留在后端。
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">Transport</label>
            <Select value={transport} onValueChange={setTransport}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="streamable-http">streamable-http</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">鉴权请求头名称</label>
              <Input value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">前缀（含空格）</label>
              <Input value={authScheme} onChange={(e) => setAuthScheme(e.target.value)} placeholder="Bearer " />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2 justify-end pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={!name || !targetUrl || saveMutation.isPending}>
              {saveMutation.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function SysAdminMcpServers() {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Partial<McpServerEntry> | null | "new">(null);

  const { data } = useQuery<{ mcpServers: McpServerEntry[] }>({ queryKey: ["/api/sysadmin/mcp-servers"] });
  const servers = data?.mcpServers ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/sysadmin/mcp-servers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/sysadmin/mcp-servers"] }),
  });

  return (
    <SysAdminLayout>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-foreground">MCP 设置</h1>
        <Button size="sm" onClick={() => setDialog("new")}>新建 MCP 服务</Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        登记需要鉴权的真实 MCP 服务器。ZooWork 只能连接公开、无鉴权的地址，所以真正暴露给 ZooWork 的是 Favie 自己的代理（mcp.favie.us），代理会用客户自己保存的 key 去访问这里配置的真实地址。在 Agent 管理里把某个 MCP 服务挂到一个 agent 上后，客户需要在聊天面板点击 Connect 提供自己的 key 才能真正用上。
      </p>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>目标地址</TableHead>
              <TableHead>Transport</TableHead>
              <TableHead>鉴权方式</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {servers.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{s.key}</TableCell>
                <TableCell className="text-muted-foreground text-xs max-w-[220px] truncate">{s.targetUrl}</TableCell>
                <TableCell className="text-xs">{s.transport}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{s.authHeaderName}: {s.authScheme}***</TableCell>
                <TableCell className="text-right space-x-2">
                  <Button size="sm" variant="outline" onClick={() => setDialog(s)}>编辑</Button>
                  <Button
                    size="sm" variant="outline"
                    onClick={() => { if (confirm(`删除 MCP 服务「${s.name}」？`)) deleteMutation.mutate(s.id); }}
                  >
                    删除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {servers.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">还没有配置 MCP 服务</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {dialog && (
        <McpServerDialog initial={dialog === "new" ? null : dialog} onClose={() => setDialog(null)} />
      )}
    </SysAdminLayout>
  );
}
