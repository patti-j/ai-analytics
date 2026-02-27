import { useState, useEffect, useCallback } from 'react';
import { useEmbedSession } from '@/contexts/EmbedSessionContext';

export interface FavoriteQuery {
  id: string;
  question: string;
  mode: string;
  savedAt: string;
}

const STORAGE_KEY = 'query-insight-favorites';

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function loadLocalFavorites(): FavoriteQuery[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveLocalFavorites(favorites: FavoriteQuery[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
}

export function useFavoriteQueries() {
  const [favorites, setFavorites] = useState<FavoriteQuery[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { isAuthenticated, email } = useEmbedSession();
  const useApi = isAuthenticated && !!email;

  useEffect(() => {
    if (useApi) {
      fetch('/api/favorites', { credentials: 'include' })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => {
          const apiFavs: FavoriteQuery[] = (data.favorites || []).map((f: any) => ({
            id: generateId(),
            question: f.question,
            mode: 'all',
            savedAt: f.savedAt,
          }));
          const localFavs = loadLocalFavorites();
          const serverQuestions = new Set(apiFavs.map(f => f.question.trim().toLowerCase()));
          const localOnly = localFavs.filter(
            lf => !serverQuestions.has(lf.question.trim().toLowerCase())
          );
          if (localOnly.length > 0) {
            for (const lf of localOnly) {
              fetch('/api/favorites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ question: lf.question.trim() }),
              }).catch(() => {});
            }
          }
          const merged = [...apiFavs, ...localOnly];
          setFavorites(merged);
          saveLocalFavorites(merged);
          setLoaded(true);
        })
        .catch(() => {
          setFavorites(loadLocalFavorites());
          setLoaded(true);
        });
    } else {
      setFavorites(loadLocalFavorites());
      setLoaded(true);
    }
  }, [useApi]);

  const addFavorite = useCallback((question: string) => {
    const normalizedQ = question.trim().toLowerCase();
    const exists = favorites.some(f => f.question.trim().toLowerCase() === normalizedQ);
    if (exists) return;

    const newFavorite: FavoriteQuery = {
      id: generateId(),
      question,
      mode: 'all',
      savedAt: new Date().toISOString(),
    };
    const updated = [newFavorite, ...favorites];
    setFavorites(updated);

    if (useApi) {
      fetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ question: question.trim() }),
      }).catch(err => console.error('[favorites] Failed to save to server:', err));
    }
    saveLocalFavorites(updated);
  }, [favorites, useApi]);

  const removeFavorite = useCallback((id: string) => {
    const fav = favorites.find(f => f.id === id);
    const updated = favorites.filter(f => f.id !== id);
    setFavorites(updated);

    if (useApi && fav) {
      fetch('/api/favorites', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ question: fav.question.trim() }),
      }).catch(err => console.error('[favorites] Failed to remove from server:', err));
    }
    saveLocalFavorites(updated);
  }, [favorites, useApi]);

  const isFavorite = useCallback((question: string) => {
    const normalizedQ = question.trim().toLowerCase();
    return favorites.some(f => f.question.trim().toLowerCase() === normalizedQ);
  }, [favorites]);

  const toggleFavorite = useCallback((question: string) => {
    const normalizedQ = question.trim().toLowerCase();
    const existing = favorites.find(f => f.question.trim().toLowerCase() === normalizedQ);
    if (existing) {
      removeFavorite(existing.id);
    } else {
      addFavorite(question);
    }
  }, [favorites, addFavorite, removeFavorite]);

  return {
    favorites,
    addFavorite,
    removeFavorite,
    isFavorite,
    toggleFavorite,
  };
}
