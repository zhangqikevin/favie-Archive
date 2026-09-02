import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAdminAuth } from "@/lib/admin-auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function SysAdminLogin() {
  const { admin, isLoading, login } = useAdminAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && admin) navigate("/sysadmin/customers");
  }, [isLoading, admin]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/sysadmin/customers");
    } catch (err: any) {
      setError(err.message || "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-card border border-border rounded-xl p-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">System Admin</h1>
          <p className="text-sm text-muted-foreground">Favie 后台管理登录</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm text-muted-foreground">邮箱</label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm text-muted-foreground">密码</label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "登录中…" : "登录"}
        </Button>
      </form>
    </div>
  );
}
