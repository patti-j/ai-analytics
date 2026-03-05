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
        isAdmin: data.isAdmin,
        entitlementCount: data.entitlements?.length,
        favoriteCount: data.favorites?.length,
      });
      setState(prev => ({
        ...prev,
        isAuthenticated: true,
        isLoading: false,
        email: data.session.email,
        companyId: data.session.companyId,
        isCompanyAdmin: data.session.isCompanyAdmin,
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
    console.log('[embed-auth] Init:', {
      isEmbedded,
      currentOrigin: window.location.origin,
    });

    if (!isEmbedded) {
      console.error('[embed-auth] Not embedded in an iframe. This app must be loaded within the Blazor parent application.');
      setState(prev => ({
        ...prev,
        isLoading: false,
        isAuthenticated: false,
        error: 'This application must be accessed through the parent application.',
      }));
      return;
    }

    let messageCount = 0;
    let authenticated = false;
    const handleMessage = (event: MessageEvent) => {
      messageCount++;
      const msgType = typeof event.data === 'object' ? event.data?.type : typeof event.data;
      console.log(`[embed-auth] postMessage #${messageCount} received:`, {
        origin: event.origin,
        dataType: msgType,
      });

      if (!isAllowedOrigin(event.origin)) {
        console.warn('[embed-auth] Rejected postMessage from untrusted origin:', event.origin);
        return;
      }

      const data = event.data;
      if (!data || data.type !== 'PT.EMBED.AUTH' || data.version !== 1) {
        return;
      }

      if (authenticated) {
        console.log('[embed-auth] Already authenticated, ignoring duplicate PT.EMBED.AUTH');
        if (data.payload?.ui?.theme) {
          applyTheme(data.payload.ui.theme);
        }
        return;
      }

      const payload = data.payload;
      if (!payload?.embedToken) {
        console.error('[embed-auth] PT.EMBED.AUTH message missing embedToken');
        return;
      }

      if (payload.ui?.theme) {
        applyTheme(payload.ui.theme);
      }

      authenticated = true;
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
