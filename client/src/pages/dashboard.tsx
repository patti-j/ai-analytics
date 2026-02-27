import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "wouter";
import { 
  Activity, 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  TrendingUp, 
  XCircle,
  ArrowLeft,
  Database,
  Zap,
  ShieldAlert,
} from "lucide-react";
import { useEmbedSession } from "@/contexts/EmbedSessionContext";

interface AnalyticsData {
  summary: {
    totalQueries: number;
    successfulQueries: number;
    failedQueries: number;
    averageLatency: number;
    averageLlmMs: number;
    averageSqlMs: number;
  };
  errorBreakdown: Array<{ stage: string; count: number; percentage: number }>;
  performanceOverTime: Array<{ timestamp: string; latency: number; llmMs: number; sqlMs: number }>;
  topErrors: Array<{ message: string; count: number; lastOccurred: string }>;
  recentQueries: Array<{
    timestamp: string;
    question: string;
    userEmail: string;
    companyId: number;
    success: boolean;
    latency: number;
    rowCount: number | null;
    error: string | null;
  }>;
}

export default function Dashboard() {
  const { isPtAdmin } = useEmbedSession();

  const { data, isLoading, error } = useQuery<AnalyticsData>({
    queryKey: ['/api/admin/analytics'],
    refetchInterval: 30000,
    enabled: isPtAdmin,
  });

  if (!isPtAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" data-testid="dashboard-access-denied">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <ShieldAlert className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <CardTitle>Access Restricted</CardTitle>
            <CardDescription>
              The analytics dashboard is only available to PlanetTogether administrators.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Link href="/">
              <button className="text-sm text-primary hover:underline" data-testid="button-back-to-query">
                Back to Query
              </button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Activity className="h-8 w-8 animate-spin mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">Loading analytics...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load analytics data. Please try again later.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const { summary, errorBreakdown, performanceOverTime, topErrors, recentQueries } = data;
  const successRate = summary.totalQueries > 0 
    ? ((summary.successfulQueries / summary.totalQueries) * 100).toFixed(1) 
    : '0.0';

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link href="/">
              <button 
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors bg-transparent border-0 cursor-pointer"
                data-testid="button-back-to-query"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Query
              </button>
            </Link>
            <div className="flex-1">
              <h1 className="text-2xl font-bold">Analytics Dashboard</h1>
              <p className="text-sm text-muted-foreground">Query performance and usage analytics</p>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Queries</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-total-queries">{summary.totalQueries}</div>
              <p className="text-xs text-muted-foreground">Last 24 hours</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-success-rate">{successRate}%</div>
              <p className="text-xs text-muted-foreground">
                {summary.successfulQueries} / {summary.totalQueries} queries
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg Latency</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-avg-latency">{summary.averageLatency}ms</div>
              <p className="text-xs text-muted-foreground">Total request time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed Queries</CardTitle>
              <XCircle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-failed-queries">{summary.failedQueries}</div>
              <p className="text-xs text-muted-foreground">Validation or execution errors</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 md:grid-cols-2 mb-8">
          <Card>
            <CardHeader>
              <CardTitle>Performance Breakdown</CardTitle>
              <CardDescription>Average time spent in each stage</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-medium">LLM Generation</span>
                  </div>
                  <span className="text-sm font-bold">{summary.averageLlmMs}ms</span>
                </div>
                <div className="w-full bg-secondary rounded-full h-2">
                  <div 
                    className="bg-blue-500 h-2 rounded-full" 
                    style={{ 
                      width: `${summary.averageLatency > 0 ? (summary.averageLlmMs / summary.averageLatency * 100) : 0}%` 
                    }}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-green-500" />
                    <span className="text-sm font-medium">SQL Execution</span>
                  </div>
                  <span className="text-sm font-bold">{summary.averageSqlMs}ms</span>
                </div>
                <div className="w-full bg-secondary rounded-full h-2">
                  <div 
                    className="bg-green-500 h-2 rounded-full" 
                    style={{ 
                      width: `${summary.averageLatency > 0 ? (summary.averageSqlMs / summary.averageLatency * 100) : 0}%` 
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Error Breakdown</CardTitle>
              <CardDescription>Errors by stage</CardDescription>
            </CardHeader>
            <CardContent>
              {errorBreakdown.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
                  <p className="text-sm">No errors in the selected time range</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {errorBreakdown.map((error) => (
                    <div key={error.stage} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant={error.stage === 'validation' ? 'destructive' : 'secondary'}>
                          {error.stage}
                        </Badge>
                        <span className="text-sm">{error.count} errors</span>
                      </div>
                      <span className="text-sm font-medium">{error.percentage.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="recent" className="space-y-4">
          <TabsList>
            <TabsTrigger value="recent" data-testid="tab-recent-queries">Recent Queries</TabsTrigger>
            <TabsTrigger value="errors" data-testid="tab-top-errors">Top Errors</TabsTrigger>
            <TabsTrigger value="performance" data-testid="tab-performance">Performance Timeline</TabsTrigger>
          </TabsList>

          <TabsContent value="recent" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Recent Query Activity</CardTitle>
                <CardDescription>Latest 20 queries with status and performance</CardDescription>
              </CardHeader>
              <CardContent>
                {recentQueries.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Activity className="h-8 w-8 mx-auto mb-2" />
                    <p className="text-sm">No queries in the selected time range</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {recentQueries.map((query, index) => (
                      <div 
                        key={index} 
                        className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                        data-testid={`recent-query-${index}`}
                      >
                        {query.success ? (
                          <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                        ) : (
                          <XCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{query.question}</p>
                          <div className="flex items-center gap-3 mt-1">
                            <span className="text-xs text-muted-foreground">
                              {new Date(query.timestamp).toLocaleTimeString()}
                            </span>
                            <span className="text-xs text-muted-foreground">{query.latency}ms</span>
                            {query.success && query.rowCount !== null && (
                              <span className="text-xs text-muted-foreground">{query.rowCount} rows</span>
                            )}
                            <span className="text-xs text-muted-foreground">{query.userEmail}</span>
                          </div>
                          {query.error && (
                            <p className="text-xs text-red-500 mt-1 line-clamp-2">{query.error}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="errors" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Most Common Errors</CardTitle>
                <CardDescription>Top 10 error messages by frequency</CardDescription>
              </CardHeader>
              <CardContent>
                {topErrors.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
                    <p className="text-sm">No errors in the selected time range</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {topErrors.map((error, index) => (
                      <div 
                        key={index} 
                        className="p-3 rounded-lg border bg-card"
                        data-testid={`top-error-${index}`}
                      >
                        <div className="flex items-start gap-3">
                          <Badge variant="destructive" className="mt-0.5">{error.count}</Badge>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium break-words">{error.message}</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Last occurred: {new Date(error.lastOccurred).toLocaleString()}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="performance" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Performance Timeline</CardTitle>
                <CardDescription>Last 50 successful queries</CardDescription>
              </CardHeader>
              <CardContent>
                {performanceOverTime.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <TrendingUp className="h-8 w-8 mx-auto mb-2" />
                    <p className="text-sm">No successful queries in the selected time range</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {performanceOverTime.slice().reverse().map((entry, index) => (
                      <div 
                        key={index} 
                        className="flex items-center gap-3"
                        data-testid={`performance-entry-${index}`}
                      >
                        <span className="text-xs text-muted-foreground w-20 flex-shrink-0">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium w-20">Total: {entry.latency}ms</span>
                            <div className="flex-1 bg-secondary rounded-full h-2 overflow-hidden">
                              <div className="flex h-full">
                                <div 
                                  className="bg-blue-500" 
                                  style={{ width: `${(entry.llmMs / entry.latency) * 100}%` }}
                                  title={`LLM: ${entry.llmMs}ms`}
                                />
                                <div 
                                  className="bg-green-500" 
                                  style={{ width: `${(entry.sqlMs / entry.latency) * 100}%` }}
                                  title={`SQL: ${entry.sqlMs}ms`}
                                />
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span>LLM: {entry.llmMs}ms</span>
                            <span>SQL: {entry.sqlMs}ms</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
