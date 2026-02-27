import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { EmbedSessionProvider } from "@/contexts/EmbedSessionContext";
import QueryPage from "@/pages/query";
import Dashboard from "@/pages/dashboard";
import AdminPermissions from "@/pages/admin-permissions";
import AdminUsers from "@/pages/admin-users";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={QueryPage} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/admin/permissions" component={AdminPermissions} />
      <Route path="/admin/users" component={AdminUsers} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="query-insight-theme">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <EmbedSessionProvider>
            <Toaster />
            <Router />
          </EmbedSessionProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
