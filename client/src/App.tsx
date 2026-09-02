import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import "@/lib/i18n"; // initialise i18next before any component renders
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BookCallProvider } from "@/lib/book-call-context";
import { AuthProvider } from "@/lib/auth-context";
import { AdminAuthProvider } from "@/lib/admin-auth-context";
import Home from "@/pages/home";
import ServicesOverview from "@/pages/services-overview";
import ServiceDetail from "@/pages/service-detail";
import Industries from "@/pages/industries";
import About from "@/pages/about";
import Results from "@/pages/results";
import Pricing from "@/pages/pricing";
import FaqPage from "@/pages/faq-page";
import Contact from "@/pages/contact";
import Login from "@/pages/login";
import Register from "@/pages/register";
import Onboarding from "@/pages/onboarding";
import Dashboard from "@/pages/dashboard";
import AdminDelivery from "@/pages/admin/delivery";
import AdminMenu from "@/pages/admin/menu";
import AdminSocial from "@/pages/admin/social";
import AdminVideo from "@/pages/admin/video";
import AdminCreators from "@/pages/admin/creators";
import AdminReviews from "@/pages/admin/reviews";
import AdminLoyalty from "@/pages/admin/loyalty";
import AdminSettings from "@/pages/admin/settings";
import AdminActivity from "@/pages/admin/activity";
import AdminFiles from "@/pages/admin/files";
import TaskMarket from "@/pages/admin/task-market";
import AgentMarket from "@/pages/admin/agent-market";
import AgentChatPage from "@/pages/admin/agents";
import AgentPage from "@/pages/agent-page";
import UberEatsLab from "@/pages/ubereats-lab";
import SysAdminLogin from "@/pages/sysadmin/login";
import SysAdminCustomers from "@/pages/sysadmin/customers";
import SysAdminAgents from "@/pages/sysadmin/agents";
import SysAdminMcpServers from "@/pages/sysadmin/mcp-servers";
import SysAdminProducts from "@/pages/sysadmin/products";
import SysAdminPayments from "@/pages/sysadmin/payments";
import NotFound from "@/pages/not-found";

function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [location]);
  return null;
}

if (typeof window !== "undefined" && !(window as any).analytics) {
  (window as any).analytics = {
    track: (event: string, data?: any) => console.log("Analytics:", event, data),
  };
}

function Router() {
  return (
    <>
      <ScrollToTop />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/services" component={ServicesOverview} />
        <Route path="/services/:slug" component={ServiceDetail} />
        <Route path="/industries" component={Industries} />
        <Route path="/about" component={About} />
        <Route path="/results" component={Results} />
        <Route path="/pricing" component={Pricing} />
        <Route path="/faq" component={FaqPage} />
        <Route path="/contact" component={Contact} />
        <Route path="/login" component={Login} />
        <Route path="/register" component={Register} />
        <Route path="/agents/:agentId" component={AgentPage} />
        <Route path="/onboarding" component={Onboarding} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/admin/delivery" component={AdminDelivery} />
        <Route path="/admin/menu" component={AdminMenu} />
        <Route path="/admin/social" component={AdminSocial} />
        <Route path="/admin/video" component={AdminVideo} />
        <Route path="/admin/creators" component={AdminCreators} />
        <Route path="/admin/reviews" component={AdminReviews} />
        <Route path="/admin/loyalty" component={AdminLoyalty} />
        <Route path="/admin/settings" component={AdminSettings} />
        <Route path="/admin/agents/:agentId" component={AgentChatPage} />
        <Route path="/admin/activity" component={AdminActivity} />
        <Route path="/admin/files" component={AdminFiles} />
        <Route path="/admin/task-market" component={TaskMarket} />
        <Route path="/admin/agent-market" component={AgentMarket} />
        <Route path="/ubereats-lab" component={UberEatsLab} />
        <Route path="/sysadmin/login" component={SysAdminLogin} />
        <Route path="/sysadmin/customers" component={SysAdminCustomers} />
        <Route path="/sysadmin/agents" component={SysAdminAgents} />
        <Route path="/sysadmin/mcp-servers" component={SysAdminMcpServers} />
        <Route path="/sysadmin/products" component={SysAdminProducts} />
        <Route path="/sysadmin/payments" component={SysAdminPayments} />
        <Route component={NotFound} />
      </Switch>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <AdminAuthProvider>
            <BookCallProvider>
              <Router />
              <Toaster />
            </BookCallProvider>
          </AdminAuthProvider>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
