import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertCircle, Sparkles, ChevronDown, ChevronUp, Database, XCircle, Download, ThumbsUp, ThumbsDown, BarChart3, Heart, Trash2, Lightbulb, MessageSquare, ArrowUp, HelpCircle, Copy, Check, TableProperties, Users } from 'lucide-react';
import { Link } from 'wouter';
import { ThemeToggle } from '@/components/theme-toggle';
import { ResultChart } from '@/components/result-chart';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { exportToCSV, exportToExcel } from '@/lib/export-utils';
import { detectDateTimeColumns, formatCellValue } from '@/lib/date-formatter';
import { usePublishDate } from '@/hooks/usePublishDate';
import { transformRelativeDates, hasRelativeDateLanguage } from '@/lib/date-anchor';
import { useSimulatedToday, getSimulatedTodaySync } from '@/hooks/useSimulatedToday';
import { useToast } from '@/hooks/use-toast';
import { useTour, type TourStep } from '@/hooks/useTour';
import { TourOverlay } from '@/components/TourOverlay';
import { useEmbedSession } from '@/contexts/EmbedSessionContext';
import type { AiUserEntitlement } from '@shared/schema';
import { apiUrl } from '@/lib/api-config';

const APP_VERSION = '1.9.7';

// Columns to hide from results display (system-generated IDs are not user-friendly)
const HIDDEN_ID_PATTERNS = [
  /^id$/i,
  /id$/i,  // Any column ending in "Id" (ResourceId, JobId, etc.)
  /_id$/i, // Any column ending in "_id"
];

function isHiddenColumn(columnName: string): boolean {
  return HIDDEN_ID_PATTERNS.some(pattern => pattern.test(columnName));
}

// Filter out hidden columns from a row
function filterRowColumns(row: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !isHiddenColumn(key))
  );
}

// Deduplicate rows based on their visible content (after filtering hidden columns)
function deduplicateRows(rows: Record<string, any>[]): Record<string, any>[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const filtered = filterRowColumns(row);
    const key = JSON.stringify(filtered);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// Format table name by stripping publish.DASHt_ prefix
function formatTableName(fullTableName: string): string {
  // Remove 'publish.' prefix if present
  let tableName = fullTableName.replace(/^publish\./i, '');
  // Remove 'DASHt_' prefix if present
  tableName = tableName.replace(/^DASHt_/i, '');
  return tableName;
}

interface QueryResult {
  answer: string;
  sql: string;
  rows: any[];
  rowCount: number;
  isMock: boolean;
  suggestions?: string[];
  nearestDates?: {
    before: string | null;
    after: string | null;
  };
  dataLastUpdated?: string | null;
}

interface SemanticCatalog {
  tables: {
    tier1: string[];
    tier2: string[];
  };
  version: string;
  lastUpdated: string;
}

const MOCK_DATA = [
  { job_id: 'J001', job_name: 'Engine Assembly', status: 'In Progress', due_date: '2023-11-15', quantity: 50, plant: 'Plant A' },
  { job_id: 'J002', job_name: 'Chassis Welding', status: 'Completed', due_date: '2023-11-10', quantity: 20, plant: 'Plant B' },
  { job_id: 'J003', job_name: 'Paint Shop', status: 'Pending', due_date: '2023-11-20', quantity: 100, plant: 'Plant A' },
  { job_id: 'J004', job_name: 'Final Inspection', status: 'Scheduled', due_date: '2023-11-25', quantity: 50, plant: 'Plant C' },
  { job_id: 'J005', job_name: 'Packaging', status: 'On Hold', due_date: '2023-11-30', quantity: 200, plant: 'Plant B' },
];

// Scenario option type with ID, name, and type
interface ScenarioOption {
  id: string;
  name: string;
  type: string;
}

// Filter options type
interface FilterOptions {
  planningAreas: string[];
  scenarios: ScenarioOption[];
  plants: string[];
  resources: string[];
  products: string[];
  workcenters: string[];
}

function buildTourSteps(entitlements: AiUserEntitlement[], isAdmin: boolean): TourStep[] {
  const scopeLabels: Record<string, string> = {
    PlanningArea: 'Planning Area',
    Plant: 'Plant',
    Scenario: 'Scenario',
    Resource: 'Resource',
    Product: 'Product',
    Workcenter: 'Workcenter',
  };

  let scopeLines = '';
  if (isAdmin) {
    scopeLines = 'You have admin access — all data is visible to you.';
  } else if (entitlements.length === 0) {
    scopeLines = 'Your permissions have not been configured yet. Contact your administrator to get access.';
  } else {
    const byScope = new Map<string, string[]>();
    for (const e of entitlements) {
      const vals = byScope.get(e.ScopeType) || [];
      vals.push(e.ScopeValue);
      byScope.set(e.ScopeType, vals);
    }
    const lines: string[] = [];
    for (const [scope, label] of Object.entries(scopeLabels)) {
      const vals = byScope.get(scope);
      if (vals && vals.length > 0) {
        lines.push(`${label}: ${vals.join(', ')}`);
      } else {
        lines.push(`${label}: None`);
      }
    }
    scopeLines = lines.join('\n');
  }

  return [
    {
      target: '[data-tour="ask-input"]',
      title: 'Welcome to AI Analytics',
      content: 'Ask questions about your manufacturing data in everyday language. The AI translates what you type into a database query and shows the results instantly.',
      placement: 'top',
    },
    {
      target: '[data-tour="ask-input"]',
      title: 'What Can You Ask?',
      content: 'Here are some questions to get you started:\n\n• "Show me all late jobs"\n• "What is the capacity utilization this week?"\n• "Which resources are over capacity?"\n• "Top 10 products by planned quantity"\n• "List overdue sales orders"\n• "Show dispatch list for today"',
      placement: 'top',
    },
    {
      target: '[data-tour="global-filters"]',
      title: 'Your Data Scope',
      content: `Use these filters to focus your queries. Your current permissions:\n\n${scopeLines}`,
      placement: 'bottom',
    },
    {
      target: '[data-tour="dashboard-link"]',
      title: 'Favorites',
      content: 'Mark any query as a favorite with the heart icon so you can find it quickly later.',
      placement: 'bottom',
    },
  ];
}

export default function QueryPage() {
  const [question, setQuestion] = useState('');
  const [submittedQuestion, setSubmittedQuestion] = useState('');
  const [refineQuestion, setRefineQuestion] = useState(''); // Editable query in results section
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showData, setShowData] = useState(true);
  const [showSql, setShowSql] = useState(false);
  const [feedbackGiven, setFeedbackGiven] = useState<'up' | 'down' | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ planningAreas: [], scenarios: [], plants: [], resources: [], products: [], workcenters: [] });
  const [selectedPlanningAreas, setSelectedPlanningAreas] = useState<string[]>([]);
  const [selectedScenarios, setSelectedScenarios] = useState<string[]>([]);
  const [selectedPlants, setSelectedPlants] = useState<string[]>([]);
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [selectedWorkcenters, setSelectedWorkcenters] = useState<string[]>([]);
  const [showFeedbackComment, setShowFeedbackComment] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [dateTimeColumns, setDateTimeColumns] = useState<Set<string>>(new Set());
  const [queryWasTransformed, setQueryWasTransformed] = useState(false);
  const [generalAnswer, setGeneralAnswer] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(true);
  const [showFavorites, setShowFavorites] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  
  // Messages array for proper persistence during streaming
  interface StreamMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
  }
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  // Streaming is now enabled everywhere using GET SSE (proxy-friendly)
  const [useStreaming, setUseStreaming] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  
  // Refs for scrolling and EventSource control
  const resultsRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamingAnswerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  
  const { isAuthenticated, isCompanyAdmin, entitlements, favorites, isFavorite, toggleFavorite, removeFavorite, sessionId } = useEmbedSession();
  const tourSteps = useMemo(() => buildTourSteps(entitlements || [], isCompanyAdmin), [entitlements, isCompanyAdmin]);
  const tour = useTour(tourSteps);
  
  // Auto-start tour for first-time users (after a short delay to ensure page is loaded)
  useEffect(() => {
    if (!tour.hasCompletedTour) {
      const timer = setTimeout(() => {
        tour.startTour();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [tour.hasCompletedTour]);
  
  // Fetch publish date for date anchoring
  const { data: publishDate } = usePublishDate();
  
  // Fetch simulated today from server (runtime config)
  const { data: simulatedToday } = useSimulatedToday();
  
  useEffect(() => {
    if (simulatedToday) {
      console.log('[date-check] Simulated Today (from server):', simulatedToday.toISOString().split('T')[0]);
    }
  }, [simulatedToday]);
  
  // Dev mode sanity check for date display
  useEffect(() => {
    if (!import.meta.env.PROD) {
      const queryDate = simulatedToday || getSimulatedTodaySync();
      console.log('[date-check] Simulated Today:', queryDate.toISOString().split('T')[0]);
      console.log('[date-check] VITE_DEV_FIXED_TODAY:', import.meta.env.VITE_DEV_FIXED_TODAY || '(not set)');
      if (publishDate) {
        console.log('[date-check] Data Last Updated (publishDate):', publishDate.toISOString().split('T')[0]);
      }
    }
  }, [publishDate, simulatedToday]);
  
  
  const { toast } = useToast();
  
  useEffect(() => {
    if (!isAuthenticated) {
      console.log('[filter-options] Not authenticated, skipping filter load');
      return;
    }
    console.log('[filter-options] Loading filters: isCompanyAdmin=', isCompanyAdmin, 'entitlements=', entitlements?.length);

    function buildFromEntitlements(): FilterOptions | null {
      if (!entitlements || entitlements.length === 0) return null;
      const byScope = new Map<string, string[]>();
      for (const e of entitlements) {
        const vals = byScope.get(e.ScopeType) || [];
        vals.push(e.ScopeValue);
        byScope.set(e.ScopeType, vals);
      }
      return {
        planningAreas: (byScope.get('PlanningArea') || []).sort(),
        scenarios: (byScope.get('Scenario') || []).sort().map(s => ({ id: s, name: s, type: '' })),
        plants: (byScope.get('Plant') || []).sort(),
        resources: (byScope.get('Resource') || []).sort(),
        products: (byScope.get('Product') || []).sort(),
        workcenters: (byScope.get('Workcenter') || []).sort(),
      };
    }

    function hasActualValues(data: FilterOptions): boolean {
      return (data.planningAreas?.length > 0) ||
             (data.scenarios?.length > 0) ||
             (data.plants?.length > 0) ||
             (data.resources?.length > 0) ||
             (data.products?.length > 0) ||
             (data.workcenters?.length > 0);
    }

    if (isCompanyAdmin) {
      fetch(apiUrl('/api/filter-options'), { credentials: 'include' })
        .then(res => {
          if (!res.ok) throw new Error(`${res.status}`);
          return res.json();
        })
        .then((data: FilterOptions) => {
          console.log('[filter-options] Server response:', {
            planningAreas: data.planningAreas?.length,
            scenarios: data.scenarios?.length,
            plants: data.plants?.length,
            resources: data.resources?.length,
            products: data.products?.length,
            workcenters: data.workcenters?.length,
          });
          if (hasActualValues(data)) {
            setFilterOptions(data);
          } else {
            console.log('[filter-options] No actual values from server, trying entitlements fallback');
            const fallback = buildFromEntitlements();
            console.log('[filter-options] Entitlements fallback:', fallback ? 'has values' : 'empty');
            setFilterOptions(fallback || data);
          }
        })
        .catch((err) => {
          console.log('[filter-options] Fetch failed:', err.message);
          const fallback = buildFromEntitlements();
          if (fallback) setFilterOptions(fallback);
        });
    } else {
      console.log('[filter-options] Non-admin path, fetching from server with entitlement filtering');
      fetch(apiUrl('/api/filter-options'), { credentials: 'include' })
        .then(res => {
          if (!res.ok) throw new Error(`${res.status}`);
          return res.json();
        })
        .then((data: FilterOptions & { noEntitlements?: boolean }) => {
          console.log('[filter-options] Server response (non-admin):', {
            planningAreas: data.planningAreas?.length,
            scenarios: data.scenarios?.length,
            plants: data.plants?.length,
            noEntitlements: data.noEntitlements,
          });
          if (hasActualValues(data)) {
            setFilterOptions(data);
          } else {
            const fallback = buildFromEntitlements();
            if (fallback) setFilterOptions(fallback);
          }
        })
        .catch((err) => {
          console.log('[filter-options] Non-admin fetch failed:', err.message);
          const fallback = buildFromEntitlements();
          if (fallback) setFilterOptions(fallback);
        });
    }
  }, [isAuthenticated, entitlements, isCompanyAdmin]);

  const handleThumbsDown = () => {
    setShowFeedbackComment(true);
  };

  const submitFeedback = async (feedback: 'up' | 'down', comment?: string) => {
    if (!result || feedbackGiven) return;
    
    setFeedbackLoading(true);
    try {
      const response = await fetch(apiUrl('/api/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: submittedQuestion,
          sql: result.sql,
          feedback,
          comment: comment || undefined,
        }),
      });
      if (response.ok) {
        setFeedbackGiven(feedback);
        setShowFeedbackComment(false);
        setFeedbackComment('');
      } else {
        console.error('Failed to submit feedback:', response.statusText);
      }
    } catch (err) {
      console.error('Failed to submit feedback:', err);
    } finally {
      setFeedbackLoading(false);
    }
  };



  const executeQuery = async (q: string) => {
    if (!q.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setGeneralAnswer(null);
    setFeedbackGiven(null);
    setShowData(false);
    setSubmittedQuestion(q.trim());
    setRefineQuestion(''); // Reset refine input when new query is submitted
    setStreamingAnswer('');
    setStreamingStatus(null);
    userScrolledRef.current = false; // Reset auto-scroll state on new query

    // Get the anchor date (effective "today" for queries) from server config or fallback
    const anchorDate = simulatedToday || getSimulatedTodaySync();
    const anchorDateStr = anchorDate.toISOString().split('T')[0]; // YYYY-MM-DD format

    // Transform relative dates to concrete dates using anchor date
    let queryToSend = q.trim();
    const wasTransformed = hasRelativeDateLanguage(queryToSend);
    if (wasTransformed) {
      queryToSend = transformRelativeDates(queryToSend, anchorDate);
      setQueryWasTransformed(true);
    } else {
      setQueryWasTransformed(false);
    }

    // Use streaming or non-streaming based on flag
    if (useStreaming) {
      await executeStreamingQuery(queryToSend, anchorDateStr);
    } else {
      await executeNonStreamingQuery(queryToSend, anchorDateStr);
    }
  };

  const executeNonStreamingQuery = async (queryToSend: string, anchorDateStr: string) => {
    try {
      const response = await fetch(apiUrl('/api/ask'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          question: queryToSend,
          publishDate: anchorDateStr,
          filters: {
            planningArea: selectedPlanningAreas.length > 0 ? selectedPlanningAreas : null,
            scenarioId: selectedScenarios.length > 0 ? selectedScenarios : null,
            plant: selectedPlants.length > 0 ? selectedPlants : null,
            resource: selectedResources.length > 0 ? selectedResources : null,
            product: selectedProducts.length > 0 ? selectedProducts : null,
            workcenter: selectedWorkcenters.length > 0 ? selectedWorkcenters : null,
          }
        }),
      });

      let data;
      try {
        const text = await response.text();
        data = JSON.parse(text);
      } catch (e: any) {
        throw new Error(e.message || 'Failed to parse server response');
      }

      if (data.isGeneralAnswer) {
        setGeneralAnswer(data.answer);
        setLoading(false);
        return;
      }

      if (data.isOutOfScope) {
        setGeneralAnswer(data.answer);
        setLoading(false);
        return;
      }

      if (!response.ok) {
        if (data.schemaError) {
          setError(data.error || 'Schema validation failed.');
          setLoading(false);
          return;
        }
        throw new Error(data.error || 'Query failed');
      }

      setResult(data);
      setShowData(true);
      
      if (data.rows && data.rows.length > 0) {
        const hasNumericColumns = Object.values(data.rows[0]).some(
          (val) => typeof val === 'number' || (!isNaN(parseFloat(val as string)) && isFinite(val as any))
        );
        setShowChart(hasNumericColumns);
        const detectedColumns = detectDateTimeColumns(data.rows);
        setDateTimeColumns(detectedColumns);
      } else {
        setShowChart(false);
      }
      
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
      
    } catch (err: any) {
      console.error("API Query Failed:", err);
      setError(`Query failed: ${err.message}. Please check your database connection, API configuration, or try rephrasing your question.`);
    } finally {
      setLoading(false);
    }
  };

  const stopStreaming = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsStreaming(false);
    setLoading(false);
    setStreamingStatus('Stopped');
  };
  
  // Smart auto-scroll: only scroll if user hasn't manually scrolled up
  const smartAutoScroll = () => {
    if (!streamingAnswerRef.current || userScrolledRef.current) return;
    streamingAnswerRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };
  
  // Detect user scroll to pause auto-scroll
  useEffect(() => {
    const handleScroll = () => {
      const currentScrollTop = window.scrollY || document.documentElement.scrollTop;
      // If user scrolled up more than 100px from previous position, they're reading
      if (currentScrollTop < lastScrollTopRef.current - 100) {
        userScrolledRef.current = true;
      }
      // If user scrolls back to bottom, resume auto-scroll
      const isAtBottom = (window.innerHeight + currentScrollTop) >= (document.documentElement.scrollHeight - 100);
      if (isAtBottom) {
        userScrolledRef.current = false;
      }
      lastScrollTopRef.current = currentScrollTop;
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const executeStreamingQuery = async (queryToSend: string, anchorDateStr: string, retryCount = 0) => {
    const MAX_RETRIES = 2;
    console.log('[streaming] Starting streaming query with EventSource' + (retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''));
    
    // Close any existing EventSource
    if (eventSourceRef.current) {
      console.log('[streaming] Closing existing EventSource');
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    
    setIsStreaming(true);
    if (retryCount > 0) {
      setStreamingStatus(`Reconnecting... (attempt ${retryCount + 1})`);
    }
    
    // 1) Create a message slot up-front (only on first attempt)
    let assistantId: string;
    if (retryCount === 0) {
      assistantId = crypto.randomUUID();
      setMessages(prev => [...prev, { id: assistantId, role: "assistant", text: "" }]);
    } else {
      // On retry, reuse the last assistant message
      assistantId = '';
    }
    
    // Track accumulated answer text and whether we received any data
    let streamedAnswer = '';
    let receivedData = false;
    let errorHandled = false; // Prevent onerror from overwriting server-sent errors
    
    let partialResult: Partial<QueryResult> = {
      answer: '',
      sql: '',
      rows: [],
      rowCount: 0,
      isMock: false,
    };
    
    // Build URL with query params (GET is more proxy-friendly for SSE)
    const filterParams = new URLSearchParams();
    if (selectedPlanningAreas.length > 0) {
      filterParams.set('filterPlanningArea', selectedPlanningAreas.join(','));
    }
    if (selectedScenarios.length > 0) {
      filterParams.set('filterScenarioId', selectedScenarios.join(','));
    }
    if (selectedPlants.length > 0) {
      filterParams.set('filterPlant', selectedPlants.join(','));
    }
    if (selectedResources.length > 0) {
      filterParams.set('filterResource', selectedResources.join(','));
    }
    if (selectedProducts.length > 0) {
      filterParams.set('filterProduct', selectedProducts.join(','));
    }
    if (selectedWorkcenters.length > 0) {
      filterParams.set('filterWorkcenter', selectedWorkcenters.join(','));
    }
    const filterStr = filterParams.toString();
    const sidParam = sessionId ? `&_sid=${encodeURIComponent(sessionId)}` : '';
    const url = apiUrl(`/api/ask/stream?question=${encodeURIComponent(queryToSend)}&publishDate=${encodeURIComponent(anchorDateStr)}${filterStr ? '&' + filterStr : ''}${sidParam}`);
    console.log('[streaming] Creating EventSource for:', url);
    
    const es = new EventSource(url);
    eventSourceRef.current = es;
    
    es.addEventListener('status', (e) => {
      receivedData = true;
      const data = JSON.parse((e as MessageEvent).data);
      setStreamingStatus(data.message || data.stage);
    });
    
    es.addEventListener('chunk', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      // 2) On each chunk: update message by ID
      streamedAnswer += data.text;
      setMessages(prev =>
        prev.map(m => m.id === assistantId ? { ...m, text: m.text + data.text } : m)
      );
      setStreamingAnswer(streamedAnswer);
      // Smart auto-scroll (respects user manual scroll)
      smartAutoScroll();
    });
    
    es.addEventListener('sql', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      partialResult.sql = data.sql;
    });
    
    es.addEventListener('rows', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      partialResult.rows = data.rows;
      partialResult.rowCount = data.rowCount;
      setShowData(true);
      
      if (data.rows.length > 0) {
        const hasNumericColumns = Object.values(data.rows[0]).some(
          (val: any) => typeof val === 'number' || (!isNaN(parseFloat(val as string)) && isFinite(val as any))
        );
        setShowChart(hasNumericColumns);
        
        const detectedColumns = detectDateTimeColumns(data.rows);
        setDateTimeColumns(detectedColumns);
      }
      
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    });
    
    es.addEventListener('complete', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      console.log('[streaming] Complete event received');
      
      // 3) On complete: finalize message with final answer
      const finalAnswer = data.answer;
      setMessages(prev =>
        prev.map(m => m.id === assistantId ? { ...m, text: finalAnswer ?? m.text } : m)
      );
      setIsStreaming(false);
      
      partialResult.answer = data.answer || streamedAnswer;
      partialResult.suggestions = data.suggestions;
      if (data.sql) partialResult.sql = data.sql;
      if (data.rowCount !== undefined) partialResult.rowCount = data.rowCount;
      if (data.dataLastUpdated) partialResult.dataLastUpdated = data.dataLastUpdated;
      
      // Display the answer immediately
      if (data.answer) {
        streamedAnswer = data.answer;
        setStreamingAnswer(data.answer);
      }
      
      // Handle general/out-of-scope answers
      if (data.isGeneralAnswer || data.isOutOfScope) {
        setGeneralAnswer(data.answer);
      }
      
      // Finish streaming - commit result before returning
      setResult(partialResult as QueryResult);
      setShowData(true);
      setStreamingStatus('Complete');
      setLoading(false);
      es.close();
      eventSourceRef.current = null;
    });
    
    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        errorHandled = true; // Mark that we received a server error
        console.log('[streaming] Server error event received:', data.error);
        if (data.schemaError) {
          setError(data.error || 'Schema validation failed.');
        } else {
          setError(data.error);
        }
      } catch {
        // SSE connection error (not a JSON error event) - let onerror handle it
        console.log('[streaming] Error event parsing failed, delegating to onerror');
        return;
      }
      // Preserve partial results on error
      if (streamedAnswer) {
        setStreamingAnswer(streamedAnswer);
      }
      setStreamingStatus('Error');
      setIsStreaming(false);
      setLoading(false);
      es.close();
      eventSourceRef.current = null;
    });
    
    es.onerror = () => {
      console.log('[streaming] EventSource onerror, receivedData:', receivedData, 'retryCount:', retryCount, 'errorHandled:', errorHandled);
      es.close();
      eventSourceRef.current = null;
      
      // If error was already handled by the 'error' event listener, don't override
      if (errorHandled) {
        console.log('[streaming] Error already handled by server error event, skipping');
        return;
      }
      
      // Auto-retry if we haven't received any data yet and haven't exhausted retries
      if (!receivedData && retryCount < MAX_RETRIES) {
        console.log('[streaming] Auto-retrying in 1 second...');
        setTimeout(() => {
          executeStreamingQuery(queryToSend, anchorDateStr, retryCount + 1);
        }, 1000);
        return;
      }
      
      // Preserve partial results
      if (streamedAnswer) {
        partialResult.answer = streamedAnswer;
        setResult(partialResult as QueryResult);
      }
      setError('Connection lost. Please try again.');
      setStreamingStatus('Error');
      setIsStreaming(false);
      setLoading(false);
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Prevent double-submission while streaming
    if (eventSourceRef.current) return;
    executeQuery(question);
  };

  const handleNewQuestion = () => {
    // Cancel any active stream
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setQuestion('');
    setResult(null);
    setError(null);
    setGeneralAnswer(null);
    setFeedbackGiven(null);
    setShowData(false);
    setShowChart(false);
    setQueryWasTransformed(false);
    setStreamingAnswer('');
    setStreamingStatus(null);
    setIsStreaming(false);
    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (question.trim() && !loading) {
        executeQuery(question);
      }
    }
  };


  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/10">
      {/* Main Content */}
      <div className="max-w-6xl mx-auto p-8 space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold text-primary">AI Analytics</h1>
            <p className="text-sm text-muted-foreground italic">
              Decision intelligence for PlanetTogether
            </p>
          </div>
          <div className="flex items-center gap-1">
            {isCompanyAdmin && (
              <Link href="/admin/users">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  data-testid="button-admin-users"
                  title="Manage user permissions"
                >
                  <Users className="h-4 w-4" />
                </Button>
              </Link>
            )}
            {isCompanyAdmin && (
              <Link href="/dashboard" data-tour="dashboard-link">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  data-testid="button-dashboard"
                  title="Analytics dashboard"
                >
                  <BarChart3 className="h-4 w-4" />
                </Button>
              </Link>
            )}
            <a href="/matrix" target="_blank" rel="noopener noreferrer">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                data-testid="button-matrix"
                title="Query matrix reference"
              >
                <TableProperties className="h-4 w-4" />
              </Button>
            </a>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => { tour.resetTour(); tour.startTour(); }}
              data-testid="button-tour-help"
              title="Getting started tour"
              aria-label="Getting started tour"
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
            <ThemeToggle />
          </div>
        </div>


        {/* Favorite Queries - Collapsible */}
        {favorites.length > 0 && (
          <div className="space-y-1" data-testid="favorites-section">
            <button
              onClick={() => setShowFavorites(!showFavorites)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {showFavorites ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              <Heart className="h-3.5 w-3.5 fill-red-500 text-red-500" />
              Favorites ({favorites.length})
            </button>
            {showFavorites && (
              <div className="flex flex-wrap gap-2 pt-1">
                {favorites.map((fav, idx) => (
                  <div
                    key={fav.question}
                    className="group relative px-3 py-1.5 rounded-full border border-border/50 bg-card/50 hover:bg-primary/10 hover:border-primary/50 transition-all duration-200"
                    data-testid={`favorite-${idx}`}
                  >
                    <button
                      onClick={() => {
                        setQuestion(fav.question);
                        executeQuery(fav.question);
                      }}
                      disabled={loading}
                      className="text-left disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="text-xs text-foreground/70 group-hover:text-foreground">
                        {fav.question}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFavorite(fav.question);
                      }}
                      className="absolute -top-1 -right-1 p-0.5 rounded-full bg-background border border-border opacity-0 group-hover:opacity-100 hover:bg-destructive/20 transition-all"
                      title="Remove from favorites"
                      data-testid={`remove-favorite-${idx}`}
                    >
                      <XCircle className="h-3 w-3 text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <Card ref={queryRef} className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">Ask a Question</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-3">
                {!isCompanyAdmin && entitlements.length === 0 && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-sm" data-testid="no-entitlements-banner">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />
                    <span>Your data access has not been configured yet. Contact your company administrator to get access.</span>
                  </div>
                )}
                {/* Global Filters - Above chat box */}
                <div className="flex flex-wrap items-center gap-3 pb-2 border-b border-border/30" data-tour="global-filters">
                  <MultiSelectFilter
                    label="Planning Area"
                    options={filterOptions.planningAreas}
                    selected={selectedPlanningAreas}
                    onChange={setSelectedPlanningAreas}
                    hasAllAccess={isCompanyAdmin}
                    width="w-[160px]"
                    testId="select-planning-area"
                  />
                  <MultiSelectFilter
                    label="Scenario"
                    options={(filterOptions.scenarios || []).map(s => s.id)}
                    selected={selectedScenarios}
                    onChange={setSelectedScenarios}
                    labels={Object.fromEntries((filterOptions.scenarios || []).map(s =>
                      [s.id, s.name && s.type ? `${s.id} - ${s.name} (${s.type})` : s.id]
                    ))}
                    hasAllAccess={isCompanyAdmin}
                    width="w-[200px]"
                    testId="select-scenario"
                  />
                  <MultiSelectFilter
                    label="Plant"
                    options={filterOptions.plants}
                    selected={selectedPlants}
                    onChange={setSelectedPlants}
                    hasAllAccess={isCompanyAdmin}
                    width="w-[120px]"
                    testId="select-plant"
                  />
                  <MultiSelectFilter
                    label="Resource"
                    options={filterOptions.resources}
                    selected={selectedResources}
                    onChange={setSelectedResources}
                    hasAllAccess={isCompanyAdmin}
                    width="w-[160px]"
                    testId="select-resource"
                  />
                  <MultiSelectFilter
                    label="Product"
                    options={filterOptions.products}
                    selected={selectedProducts}
                    onChange={setSelectedProducts}
                    hasAllAccess={isCompanyAdmin}
                    width="w-[160px]"
                    testId="select-product"
                  />
                  <MultiSelectFilter
                    label="Workcenter"
                    options={filterOptions.workcenters}
                    selected={selectedWorkcenters}
                    onChange={setSelectedWorkcenters}
                    hasAllAccess={isCompanyAdmin}
                    width="w-[160px]"
                    testId="select-workcenter"
                  />
                </div>

                <Textarea
                  placeholder="What would you like to know about your manufacturing data?"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="min-h-[100px] p-3 rounded-lg bg-gradient-to-r from-primary/10 to-primary/5 border border-primary/20 text-base font-medium focus:outline-none focus:ring-2 focus:ring-primary/50"
                  data-testid="input-question"
                  data-tour="ask-input"
                />
                
                {/* Display both Simulated Today (anchor) and Last Publish to Analytics (UTC) */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
                  <div className="flex items-center gap-2" data-testid="today-anchor-display">
                    <span className="font-medium">Simulated Today:</span>
                    <span className="text-foreground/70">
                      {(simulatedToday || getSimulatedTodaySync()).toLocaleDateString('en-US', { 
                        year: 'numeric', 
                        month: 'short', 
                        day: 'numeric' 
                      })}
                    </span>
                  </div>
                  {publishDate && (
                    <div className="flex items-center gap-2" data-testid="publish-date-display">
                      <span className="font-medium">Last Publish to Analytics (UTC):</span>
                      <span className="text-foreground/70">
                        {publishDate.toLocaleString('en-US', { 
                          year: 'numeric', 
                          month: 'numeric', 
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true,
                          timeZone: 'UTC'
                        })}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="flex gap-2">
                <Button 
                  type="submit" 
                  disabled={loading || !question.trim()} 
                  data-testid="button-submit"
                  className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70"
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {loading ? 'Analyzing...' : 'Submit Question'}
                </Button>
                {(question.trim() || result || error || generalAnswer) && (
                  <Button 
                    type="button"
                    variant="outline" 
                    onClick={handleNewQuestion}
                    disabled={loading}
                    data-testid="button-new-question"
                  >
                    New Question
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Loading Progress Indicator with Streaming Status */}
        {loading && (
          <Card className="border-primary/30 bg-card/80 backdrop-blur-sm" data-testid="card-loading">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  {streamingStatus || 'Processing your question...'}
                </CardTitle>
                {isStreaming && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={stopStreaming}
                    className="gap-2 text-destructive border-destructive/50 hover:bg-destructive/10"
                    data-testid="button-stop-streaming"
                  >
                    <XCircle className="h-4 w-4" />
                    Stop
                  </Button>
                )}
              </div>
              {submittedQuestion && (
                <p className="text-sm text-muted-foreground mt-1">
                  "{submittedQuestion}"
                </p>
              )}
            </CardHeader>
            <CardContent>
              <div 
                ref={streamingAnswerRef}
                className="p-4 bg-gradient-to-r from-primary/5 to-primary/10 border border-primary/20 rounded-xl min-h-[60px]" 
                data-testid="streaming-answer"
              >
                {streamingAnswer ? (
                  <div className="text-base leading-relaxed">
                    {streamingAnswer.split('\n').map((line, idx) => {
                      const trimmedLine = line.trim();
                      if (trimmedLine.startsWith('•') || trimmedLine.startsWith('-')) {
                        return (
                          <div key={idx} className="flex gap-2 ml-2 my-1">
                            <span className="flex-shrink-0">{trimmedLine.charAt(0)}</span>
                            <span>{trimmedLine.slice(1).trim()}</span>
                          </div>
                        );
                      } else if (trimmedLine) {
                        return <p key={idx} className="my-1">{line}</p>;
                      } else {
                        return <div key={idx} className="h-2" />;
                      }
                    })}
                    <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5" />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="inline-block w-2 h-4 bg-primary animate-pulse" />
                    <span className="text-sm italic">Waiting for response...</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardHeader>
              <CardTitle className="text-destructive flex items-center gap-2">
                <AlertCircle className="h-5 w-5" />
                System Notification
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p data-testid="text-error" className="whitespace-pre-line">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* General Answer (non-data response) */}
        {generalAnswer && (
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm" data-testid="card-general-answer">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Answer
              </CardTitle>
              {submittedQuestion && (
                <p className="text-sm text-muted-foreground mt-1">
                  "{submittedQuestion}"
                </p>
              )}
            </CardHeader>
            <CardContent>
              <p className="text-foreground leading-relaxed" data-testid="text-general-answer">
                {generalAnswer}
              </p>
              <p className="text-xs text-muted-foreground mt-4 italic">
                This is a general explanation. To query your data, try asking something like "Show me..." or "List all..."
              </p>
            </CardContent>
          </Card>
        )}

        {result && (
          <div ref={resultsRef} className="space-y-4">
            <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span className="text-green-500">✓</span>
                  Results
                </CardTitle>
                {submittedQuestion && (
                  <div className="mt-3 space-y-2">
                    <form 
                      onSubmit={(e) => {
                        e.preventDefault();
                        const queryToRun = refineQuestion.trim() || submittedQuestion;
                        if (queryToRun && !loading) {
                          setQuestion(queryToRun);
                          executeQuery(queryToRun);
                        }
                      }}
                      className="flex items-center gap-2"
                    >
                      <div className="flex-1 relative">
                        <input
                          type="text"
                          value={refineQuestion || submittedQuestion}
                          onChange={(e) => setRefineQuestion(e.target.value)}
                          onFocus={() => {
                            if (!refineQuestion) setRefineQuestion(submittedQuestion);
                          }}
                          className="w-full p-3 pr-10 rounded-lg bg-gradient-to-r from-primary/10 to-primary/5 border border-primary/20 text-base font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                          placeholder="Refine your question..."
                          data-testid="input-refine-question"
                        />
                        <button
                          type="button"
                          onClick={() => toggleFavorite(refineQuestion || submittedQuestion)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full hover:bg-primary/20 transition-colors"
                          title={isFavorite(refineQuestion || submittedQuestion) ? "Remove from favorites" : "Add to favorites"}
                          data-testid="button-toggle-favorite"
                        >
                          <Heart 
                            className={`h-5 w-5 transition-colors ${
                              isFavorite(refineQuestion || submittedQuestion) 
                                ? 'fill-red-500 text-red-500' 
                                : 'text-muted-foreground hover:text-red-500'
                            }`} 
                          />
                        </button>
                      </div>
                      <Button 
                        type="submit" 
                        disabled={loading}
                        size="sm"
                        className="shrink-0 bg-primary hover:bg-primary/90"
                        data-testid="button-refine-submit"
                      >
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                      </Button>
                    </form>
                    {queryWasTransformed && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground px-3" data-testid="text-query-transformed">
                        <Badge variant="outline" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30">
                          Anchored
                        </Badge>
                        <span>
                          Date-relative terms converted to {(simulatedToday || getSimulatedTodaySync()).toLocaleDateString('en-US', { 
                            year: 'numeric', 
                            month: 'short', 
                            day: 'numeric' 
                          })}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Natural Language Answer - Prominent Display */}
                <div className="p-4 bg-gradient-to-r from-primary/5 to-primary/10 border border-primary/20 rounded-xl" data-testid="natural-answer">
                  <div className="text-base leading-relaxed">
                    {result.answer.split('\n').map((line, idx) => {
                      const trimmedLine = line.trim();
                      if (trimmedLine.startsWith('•') || trimmedLine.startsWith('-')) {
                        return (
                          <div key={idx} className="flex gap-2 ml-2 my-1">
                            <span className="flex-shrink-0">{trimmedLine.charAt(0)}</span>
                            <span>{trimmedLine.slice(1).trim()}</span>
                          </div>
                        );
                      } else if (trimmedLine) {
                        return <p key={idx} className="my-1">{line}</p>;
                      } else {
                        return <div key={idx} className="h-2" />;
                      }
                    })}
                  </div>
                </div>
                
                {/* Action Buttons Row */}
                <div className="flex flex-wrap items-center gap-2">
                  {result.rows.length > 0 && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowData(!showData)}
                        className={`gap-2 ${showData ? 'bg-green-500/20 border-green-500/50' : 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30 hover:bg-green-500/20'}`}
                        data-testid="button-toggle-data"
                      >
                        <Database className="h-4 w-4" />
                        {showData ? 'Hide Data' : `Show Data (${deduplicateRows(result.rows).length} rows)`}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowChart(!showChart)}
                        className={`gap-2 ${showChart ? 'bg-green-500/20 border-green-500/50' : 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30 hover:bg-green-500/20'}`}
                        data-testid="button-toggle-chart"
                      >
                        <BarChart3 className="h-4 w-4" />
                        {showChart ? 'Hide Chart' : 'Show Chart'}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-2"
                            data-testid="button-export"
                          >
                            <Download className="h-4 w-4" />
                            Export
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              try {
                                const exportData = deduplicateRows(result.rows).map(filterRowColumns);
                                exportToCSV(exportData, `query-results-${Date.now()}.csv`);
                              } catch (err: any) {
                                setError(`Export failed: ${err.message}`);
                              }
                            }}
                            data-testid="menu-export-csv"
                          >
                            Export as CSV
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              try {
                                const exportData = deduplicateRows(result.rows).map(filterRowColumns);
                                exportToExcel(exportData, `query-results-${Date.now()}.xlsx`);
                              } catch (err: any) {
                                setError(`Export failed: ${err.message}`);
                              }
                            }}
                            data-testid="menu-export-excel"
                          >
                            Export as Excel
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      
                    </>
                  )}
                  {result.sql && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSql(!showSql)}
                      className="gap-2"
                      data-testid="button-toggle-sql"
                    >
                      {showSql ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      SQL
                    </Button>
                  )}
                </div>
                
                {/* SQL Query - Collapsible */}
                {showSql && (
                  <div className="relative">
                    <pre className="bg-muted/50 p-4 pr-12 rounded-xl text-sm overflow-x-auto border border-border/30" data-testid="text-sql">
                      {result.sql}
                    </pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="absolute top-2 right-2 h-8 w-8 p-0"
                      onClick={() => {
                        navigator.clipboard.writeText(result.sql);
                        setSqlCopied(true);
                        setTimeout(() => setSqlCopied(false), 2000);
                      }}
                      data-testid="button-copy-sql"
                    >
                      {sqlCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                )}
                
                {/* Chart visualization */}
                {showChart && result.rows.length > 0 && (() => {
                  const uniqueRows = deduplicateRows(result.rows);
                  return (
                    <div className="border border-border/50 rounded-xl p-4 bg-card/50">
                      <ResultChart 
                        rows={uniqueRows.map(filterRowColumns)} 
                        columns={Object.keys(filterRowColumns(uniqueRows[0]))} 
                      />
                    </div>
                  );
                })()}

                {/* Data Table - Hidden by default */}
                {showData && result.rows.length > 0 && (() => {
                  const uniqueRows = deduplicateRows(result.rows);
                  return (
                    <div>
                      <div className="w-full overflow-x-auto border border-border/50 rounded-xl">
                        <div className="max-h-[420px] overflow-auto">
                          <table className={`w-full text-sm table-auto ${Object.keys(filterRowColumns(uniqueRows[0])).length > 5 ? 'min-w-[900px]' : ''}`}>
                            <thead className="bg-muted sticky top-0 z-10 shadow-sm">
                              <tr>
                                {Object.keys(filterRowColumns(uniqueRows[0])).map((key) => (
                                  <th key={key} className="px-4 py-3 text-left font-medium text-foreground/70">
                                    {key}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {uniqueRows.map((row, idx) => {
                                const filteredRow = filterRowColumns(row);
                                return (
                                  <tr key={idx} className="border-t border-border/30 hover:bg-muted/30 transition-colors" data-testid={`row-result-${idx}`}>
                                    {Object.entries(filteredRow).map(([columnName, value]: [string, any], cellIdx) => (
                                      <td key={cellIdx} className="px-4 py-3">
                                        {value === null ? (
                                          <span className="text-muted-foreground italic">null</span>
                                        ) : (
                                          formatCellValue(value, columnName, dateTimeColumns)
                                        )}
                                      </td>
                                    ))}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground mt-3">
                        Showing {uniqueRows.length} rows
                      </p>
                    </div>
                  );
                })()}

                {/* No results message */}
                {result.rows.length === 0 && (
                  <div className="p-6 text-center border border-border/50 rounded-xl bg-muted/30" data-testid="no-results-message">
                    <div className="text-4xl mb-3">📭</div>
                    <h3 className="font-semibold text-lg mb-2">No matching records found</h3>
                    <p className="text-sm text-muted-foreground">
                      Your query ran successfully, but no data matched the criteria.
                    </p>
                    {result.nearestDates && (result.nearestDates.before || result.nearestDates.after) && (
                      <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-left" data-testid="nearest-dates-hint">
                        <p className="text-sm font-medium text-blue-600 dark:text-blue-400 mb-2">
                          Data availability:
                        </p>
                        <div className="text-sm text-muted-foreground space-y-1">
                          {result.nearestDates.before && (
                            <p>Earliest date: <span className="font-medium text-foreground">{result.nearestDates.before}</span></p>
                          )}
                          {result.nearestDates.after && (
                            <p>Latest date: <span className="font-medium text-foreground">{result.nearestDates.after}</span></p>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          Note: Data may have gaps between these dates.
                        </p>
                      </div>
                    )}
                    {!result.nearestDates && (
                      <p className="text-sm text-muted-foreground mt-2">
                        Try adjusting the date range or filters in your question.
                      </p>
                    )}
                  </div>
                )}

                {/* Feedback Section */}
                <div className="pt-4 border-t border-border/30 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Was this helpful?</span>
                    <Button
                      variant={feedbackGiven === 'up' ? "default" : "outline"}
                      size="sm"
                      onClick={() => submitFeedback('up')}
                      disabled={feedbackLoading || feedbackGiven !== null || showFeedbackComment}
                      data-testid="button-feedback-up"
                      className={feedbackGiven === 'up' ? "bg-green-500 hover:bg-green-600" : ""}
                    >
                      <ThumbsUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant={feedbackGiven === 'down' || showFeedbackComment ? "default" : "outline"}
                      size="sm"
                      onClick={handleThumbsDown}
                      disabled={feedbackLoading || feedbackGiven !== null}
                      data-testid="button-feedback-down"
                      className={feedbackGiven === 'down' || showFeedbackComment ? "bg-red-500 hover:bg-red-600" : ""}
                    >
                      <ThumbsDown className="h-4 w-4" />
                    </Button>
                    {feedbackGiven && (
                      <span className="text-sm text-muted-foreground ml-2">Thanks for your feedback!</span>
                    )}
                  </div>
                  {showFeedbackComment && !feedbackGiven && (
                    <div className="flex gap-2 items-end">
                      <div className="flex-1">
                        <Textarea
                          placeholder="What went wrong? (optional)"
                          value={feedbackComment}
                          onChange={(e) => setFeedbackComment(e.target.value)}
                          className="min-h-[60px] text-sm"
                          data-testid="input-feedback-comment"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setShowFeedbackComment(false);
                            setFeedbackComment('');
                          }}
                          disabled={feedbackLoading}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => submitFeedback('down', feedbackComment)}
                          disabled={feedbackLoading}
                          className="bg-red-500 hover:bg-red-600"
                        >
                          {feedbackLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Did you mean? Suggestions */}
                {result.suggestions && result.suggestions.length > 0 && (
                  <div className="pt-4 border-t border-border/30">
                    <div className="flex items-center gap-2 mb-2">
                      <Lightbulb className="h-4 w-4 text-yellow-500" />
                      <span className="text-sm font-medium">Related questions you might ask:</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {result.suggestions.map((suggestion, idx) => (
                        <Button
                          key={idx}
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setQuestion(suggestion);
                            executeQuery(suggestion);
                          }}
                          disabled={loading}
                          data-testid={`button-suggestion-${idx}`}
                          className="text-xs bg-yellow-500/5 border-yellow-500/30 hover:bg-yellow-500/10"
                        >
                          {suggestion}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* New Question Button */}
                <div className="pt-4 border-t border-border/30 mt-4">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuestion('');
                      queryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className="w-full gap-2"
                    data-testid="button-new-question"
                  >
                    <MessageSquare className="h-4 w-4" />
                    New Question
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <footer className="mt-12 pb-6 text-center">
          <p className="text-xs text-muted-foreground" data-testid="text-app-version">
            AI Analytics v{APP_VERSION}
          </p>
        </footer>
      </div>

      {/* Getting Started Tour */}
      <TourOverlay
        isActive={tour.isActive}
        step={tour.currentStepData}
        currentStep={tour.currentStep}
        totalSteps={tour.totalSteps}
        onNext={tour.nextStep}
        onPrev={tour.prevStep}
        onSkip={tour.skipTour}
      />
    </div>
  );
}
