import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '@/lib/api-config';

interface ConfigResponse {
  simulatedToday: string | null;
  serverTime: string;
}

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

let cachedSimulatedToday: Date | null = null;
let cacheInitialized = false;

export async function fetchSimulatedToday(): Promise<Date> {
  if (cacheInitialized && cachedSimulatedToday) {
    return cachedSimulatedToday;
  }
  
  try {
    const response = await fetch(apiUrl('/api/config'));
    if (response.ok) {
      const data: ConfigResponse = await response.json();
      if (data.simulatedToday) {
        const [year, month, day] = data.simulatedToday.split('-').map(Number);
        cachedSimulatedToday = new Date(year, month - 1, day);
        cacheInitialized = true;
        return cachedSimulatedToday;
      }
    }
  } catch (e) {
    console.warn('[useSimulatedToday] Failed to fetch server config, using fallback');
  }
  
  const fixed = import.meta.env.VITE_DEV_FIXED_TODAY as string;
  if (fixed) {
    const [year, month, day] = fixed.split('-').map(Number);
    cachedSimulatedToday = new Date(year, month - 1, day);
    cacheInitialized = true;
    return cachedSimulatedToday;
  }
  
  return new Date();
}

export function getSimulatedTodaySync(): Date {
  if (cachedSimulatedToday) {
    return cachedSimulatedToday;
  }
  
  const fixed = import.meta.env.VITE_DEV_FIXED_TODAY as string;
  if (fixed) {
    const [year, month, day] = fixed.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  
  return new Date();
}
