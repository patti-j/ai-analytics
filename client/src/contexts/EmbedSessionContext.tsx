import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { AiUserEntitlement } from "@shared/schema";
import { apiUrl } from "@/lib/api-config";

export interface FavoriteQuestion {
  question: string;
  savedAt: string;
}

interface EmbedSessionState {
  isAuthenticated: boolean;
  isLoading: boolean;
  email: string | null;
  companyId: number | null;
  isCompanyAdmin: boolean;
  isPtAdmin: boolean;
  hasAIAnalyticsRole: boolean;
  error: string | null;
  entitlements: AiUserEntitlement[];
  entitlementsLoaded: boolean;
  favorites: FavoriteQuestion[];
  favoritesLoaded: boolean;
  isEmbedded: boolean;
  sessionId: string | null;
}

interface EmbedSessionContextValue extends EmbedSessionState {
  addFavorite: (question: string) => void;
  removeFavorite: (question: string) => void;
  toggleFavorite: (question: string) => void;
  isFavorite: (question: string) => boolean;
}

const EmbedSessionContext = createContext<EmbedSessionContextValue | null>(null);

const ALLOWED_ORIGINS = [
  'https://planettogether.com',
  'https://www.planettogether.com',
  'https://app.planettogether.com',
  'https://localhost',
  'http://localhost',
  'http://localhost:5173',
  'http://localhost:3000',
];

const ALLOWED_ORIGIN_SUFFIXES = [
  '.azurewebsites.net',
];

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (ALLOWED_ORIGINS.some(allowed => {
      const allowedUrl = new URL(allowed);
      return url.hostname === allowedUrl.hostname && url.protocol === allowedUrl.protocol
        && (allowedUrl.port ? url.port === allowedUrl.port : true);
    })) {
      return true;
    }
    if (url.protocol === 'https:' && ALLOWED_ORIGIN_SUFFIXES.some(suffix => url.hostname.endsWith(suffix))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function applyTheme(theme: 'dark' | 'light') {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  localStorage.setItem('query-insight-theme', theme);
  window.dispatchEvent(new CustomEvent('theme-override', { detail: theme }));
}

function applySessionData(data: any): Partial<EmbedSessionState> {
  return {
    entitlements: data.entitlements || [],
    entitlementsLoaded: true,
    favorites: (data.favorites || []).map((f: any) => ({
      question: f.question,
      savedAt: f.savedAt,
    })),
    favoritesLoaded: true,
  };
}

export function EmbedSessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<EmbedSessionState>({
    isAuthenticated: false,
    isLoading: true,
    email: null,
    companyId: null,
    isCompanyAdmin: false,
    isPtAdmin: false,
    hasAIAnalyticsRole: false,
    error: null,
    entitlements: [],
    entitlementsLoaded: false,
    favorites: [],
    favoritesLoaded: false,
    isEmbedded: window.parent !== window,
    sessionId: null,
  });

  const addFavorite = useCallback((question: string) => {
    const trimmed = question.trim();
    const normalizedQ = trimmed.toLowerCase();
    setState(prev => {
      if (prev.favorites.some(f => f.question.trim().toLowerCase() === normalizedQ)) {
        return prev;
      }
      return {
        ...prev,
        favorites: [{ question: trimmed, savedAt: new Date().toISOString() }, ...prev.favorites],
      };
    });
    fetch(apiUrl('/api/my-favorites'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ question: trimmed }),
    }).catch(err => console.error('[favorites] Failed to save:', err));
  }, []);

  const removeFavoriteByQuestion = useCallback((question: string) => {
    const normalizedQ = question.trim().toLowerCase();
    setState(prev => ({
      ...prev,
      favorites: prev.favorites.filter(f => f.question.trim().toLowerCase() !== normalizedQ),
    }));
    fetch(apiUrl('/api/my-favorites'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ question: question.trim() }),
    }).catch(err => console.error('[favorites] Failed to remove:', err));
  }, []);

  const isFavorite = useCallback((question: string) => {
    const normalizedQ = question.trim().toLowerCase();
    return state.favorites.some(f => f.question.trim().toLowerCase() === normalizedQ);
  }, [state.favorites]);

  const toggleFavorite = useCallback((question: string) => {
    if (isFavorite(question)) {
      removeFavoriteByQuestion(question);
    } else {
      addFavorite(question);
    }
  }, [isFavorite, removeFavoriteByQuestion, addFavorite]);

  const authenticateWithToken = useCallback(async (embedToken: string) => {
    try {
      const targetUrl = apiUrl('/api/session/from-embed');
      console.log('[embed-auth] POST', targetUrl, '(token length:', embedToken.length + ')');
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ embedToken }),
      });

      console.log('[embed-auth] Response:', res.status, res.statusText);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Authentication failed' }));
        console.error('[embed-auth] Auth failed:', res.status, errData);
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: errData.error || 'Authentication failed',
        }));
        return;
      }

      const data = await res.json();
      console.log('[embed-auth] Session response from server:', {
        email: data.session?.email,
        companyId: data.session?.companyId,
        isCompanyAdmin: data.session?.isCompanyAdmin,
        isPtAdmin: data.isPtAdmin,
        isAdmin: data.isAdmin,
        entitlementCount: data.entitlements?.length,
        favoriteCount: data.favorites?.length,
        scopeTypes: data.scopeTypes,
      });
      setState(prev => ({
        ...prev,
        isAuthenticated: true,
        isLoading: false,
        email: data.session.email,
        companyId: data.session.companyId,
        isCompanyAdmin: data.session.isCompanyAdmin,
        isPtAdmin: data.isPtAdmin || false,
        hasAIAnalyticsRole: true,
        error: null,
        sessionId: data.sessionId || null,
        ...applySessionData(data),
      }));
    } catch (err: any) {
      console.error('[embed-auth] Auth request exception:', err.message || err);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: err.message || 'Authentication failed',
      }));
    }
  }, []);

  useEffect(() => {
    const isEmbedded = window.parent !== window;
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('embedToken');
    console.log('[embed-auth] Init:', {
      isEmbedded,
      currentOrigin: window.location.origin,
      currentUrl: window.location.href,
      hasUrlToken: !!urlToken,
      urlTokenLength: urlToken?.length,
      parentSameOrigin: (() => { try { return !!window.parent.location.href; } catch { return false; } })(),
    });

    if (urlToken) {
      console.log('[embed-auth] Found embedToken in URL, authenticating...');
      const urlTheme = urlParams.get('theme');
      if (urlTheme === 'dark' || urlTheme === 'light') {
        console.log('[embed-auth] Applying theme from URL:', urlTheme);
        applyTheme(urlTheme);
      }
      authenticateWithToken(urlToken);
      if (window.history.replaceState) {
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
      }
      return;
    }

    if (!isEmbedded) {
      console.log('[embed-auth] Not embedded, checking existing session cookie...');
      checkExistingSession();
      return;
    }

    let messageCount = 0;
    const handleMessage = (event: MessageEvent) => {
      messageCount++;
      const msgType = typeof event.data === 'object' ? event.data?.type : typeof event.data;
      console.log(`[embed-auth] postMessage #${messageCount} received:`, {
        origin: event.origin,
        dataType: msgType,
        dataKeys: typeof event.data === 'object' && event.data ? Object.keys(event.data) : [],
        rawData: typeof event.data === 'string' ? event.data : undefined,
      });

      if (!isAllowedOrigin(event.origin)) {
        console.warn('[embed-auth] Rejected postMessage from untrusted origin:', event.origin);
        return;
      }

      const data = event.data;
      if (!data || data.type !== 'PT.EMBED.AUTH' || data.version !== 1) {
        console.log('[embed-auth] Ignoring non-auth message (type=' + (data?.type || 'none') + ', version=' + (data?.version || 'none') + ')');
        return;
      }

      const payload = data.payload;
      console.log('[embed-auth] Received PT.EMBED.AUTH from parent:', {
        origin: event.origin,
        hasEmbedToken: !!payload?.embedToken,
        tokenLength: payload?.embedToken?.length,
        ui: payload?.ui,
        payloadKeys: payload ? Object.keys(payload) : [],
      });
      if (!payload?.embedToken) {
        console.error('[embed-auth] PT.EMBED.AUTH message missing embedToken');
        return;
      }

      if (payload.ui?.theme) {
        applyTheme(payload.ui.theme);
      }

      authenticateWithToken(payload.embedToken);
    };

    window.addEventListener('message', handleMessage);

    try {
      window.parent.postMessage('PT.EMBED.READY', '*');
      console.log('[embed-auth] Sent PT.EMBED.READY to parent');
    } catch (err) {
      console.error('[embed-auth] Failed to post PT.EMBED.READY:', err);
    }

    const timeout = setTimeout(() => {
      setState(prev => {
        if (!prev.isAuthenticated && prev.isLoading) {
          console.error('[embed-auth] TIMEOUT after 10s. Messages received:', messageCount, '. Parent did not send valid PT.EMBED.AUTH.');
          return {
            ...prev,
            isLoading: false,
            error: 'Embed authentication timeout. Parent did not send auth token.',
          };
        }
        return prev;
      });
    }, 10000);

    return () => {
      window.removeEventListener('message', handleMessage);
      clearTimeout(timeout);
    };
  }, [authenticateWithToken]);

  async function checkExistingSession() {
    try {
      console.log('[embed-auth] Checking existing session at', apiUrl('/api/session'));
      const res = await fetch(apiUrl('/api/session'), { credentials: 'include' });
      console.log('[embed-auth] Session check response:', res.status, res.statusText);
      if (res.ok) {
        const data = await res.json();
        console.log('[embed-auth] Existing session found:', {
          email: data.email,
          companyId: data.companyId,
          isCompanyAdmin: data.isCompanyAdmin,
          isPtAdmin: data.isPtAdmin,
          isAdmin: data.isAdmin,
          entitlementCount: data.entitlements?.length,
        });
        setState(prev => ({
          ...prev,
          isAuthenticated: true,
          isLoading: false,
          email: data.email,
          companyId: data.companyId,
          isCompanyAdmin: data.isCompanyAdmin,
          isPtAdmin: data.isPtAdmin || false,
          hasAIAnalyticsRole: data.hasAIAnalyticsRole,
          ...applySessionData(data),
        }));
      } else {
        console.warn('[embed-auth] No existing session (HTTP', res.status + '). Not authenticated.');
        setState(prev => ({
          ...prev,
          isLoading: false,
          isAuthenticated: false,
          error: 'Not authenticated. Session may have expired.',
        }));
      }
    } catch (err: any) {
      console.error('[embed-auth] Session check failed:', err.message);
      setState(prev => ({
        ...prev,
        isLoading: false,
        isAuthenticated: false,
        error: 'Unable to reach the server.',
      }));
    }
  }

  const contextValue: EmbedSessionContextValue = {
    ...state,
    addFavorite,
    removeFavorite: removeFavoriteByQuestion,
    toggleFavorite,
    isFavorite,
  };

  return (
    <EmbedSessionContext.Provider value={contextValue}>
      {children}
    </EmbedSessionContext.Provider>
  );
}

export function useEmbedSession() {
  const context = useContext(EmbedSessionContext);
  if (!context) {
    throw new Error('useEmbedSession must be used within EmbedSessionProvider');
  }
  return context;
}
