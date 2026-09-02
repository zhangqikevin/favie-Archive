import { ReactNode, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAdminAuth } from "@/lib/admin-auth-context";
import { cn } from "@/lib/utils";
import { Users, Bot, Package, Receipt, Plug, LogOut } from "lucide-react";

const NAV = [
  { href: "/sysadmin/customers", label: "客户管理", icon: Users },
  { href: "/sysadmin/agents", label: "Agent 管理", icon: Bot },
  { href: "/sysadmin/mcp-servers", label: "MCP 设置", icon: Plug },
  { href: "/sysadmin/products", label: "产品管理", icon: Package },
  { href: "/sysadmin/payments", label: "支付记录", icon: Receipt },
];

export default function SysAdminLayout({ children }: { children: ReactNode }) {
  const { admin, isLoading, logout } = useAdminAuth();
  const [location, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !admin) navigate("/sysadmin/login");
  }, [isLoading, admin]);

  if (isLoading || !admin) return null;

  return (
    <div className="min-h-screen flex bg-background">
      <aside className="w-60 flex-shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-5 py-5 border-b border-border">
          <div className="font-semibold text-foreground">Favie</div>
          <div className="text-xs text-muted-foreground">System Admin</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                location === href
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-border">
          <div className="text-xs text-muted-foreground truncate mb-2">{admin.email}</div>
          <button
            onClick={() => logout().then(() => navigate("/sysadmin/login"))}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" /> 退出登录
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
