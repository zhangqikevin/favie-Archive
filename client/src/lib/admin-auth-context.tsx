import { createContext, useContext, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface AdminUser {
  id: string;
  email: string;
}

interface AdminAuthContextValue {
  admin: AdminUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<AdminUser>;
  logout: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ admin: AdminUser }>({
    queryKey: ["/api/sysadmin/me"],
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  const admin = data?.admin ?? null;

  const login = async (email: string, password: string): Promise<AdminUser> => {
    const res = await apiRequest("POST", "/api/sysadmin/login", { email, password });
    const json = await res.json();
    queryClient.setQueryData(["/api/sysadmin/me"], { admin: json.admin });
    return json.admin;
  };

  const logout = async (): Promise<void> => {
    await apiRequest("POST", "/api/sysadmin/logout", {});
    queryClient.removeQueries({ predicate: (q) => (q.queryKey[0] as string)?.startsWith("/api/sysadmin") });
  };

  return (
    <AdminAuthContext.Provider value={{ admin, isLoading, login, logout }}>
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return ctx;
}
