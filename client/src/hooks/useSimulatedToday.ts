import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '@/lib/api-config';

interface ConfigResponse {
  simulatedToday: string | null;
  serverTime: string;
}

// React Query hook — fetches the simulated "today" date from /api/config.
// Used in query.tsx to anchor all relative date expressions (e.g. "last 30 days").
export function useSimulatedToday() {
  return useQuery({
    queryKey: ['simulated-today'],
    queryFn: async (): Promise<Date | null> => {
      const response = await fetch(apiUrl('/api/config'));
      if (!response.ok) {
        throw new Error('Failed to fetch config');
      }
      
      const data: ConfigResponse = await response.json();
      
      if (data.simulatedToday) {
        const [year, month, day] = data.simulatedToday.split('-').map(Number);
        return new Date(year, month - 1, day);
      }
      
      return null;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1,
  });
}

// Synchronous fallback — returns the cached simulated date or VITE_DEV_FIXED_TODAY
// or real Date.now(). Used when the React Query hook hasn't resolved yet.
export function getSimulatedTodaySync(): Date {
  const fixed = import.meta.env.VITE_DEV_FIXED_TODAY as string;
  if (fixed) {
    const [year, month, day] = fixed.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  
  return new Date();
}
