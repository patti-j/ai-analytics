import { useQuery } from '@tanstack/react-query';

interface PublishDateResponse {
  ok: boolean;
  lastUpdate: string | null;
}

/**
 * Hook to fetch and cache the latest publish date from the database
 * This is used as an anchor for date-relative queries in demo data
 */
export function usePublishDate() {
  return useQuery({
    queryKey: ['publish-date'],
    queryFn: async (): Promise<Date | null> => {
      try {
        const response = await fetch('/api/last-update');
        if (!response.ok) return null;
        const data: PublishDateResponse = await response.json();
        if (data.ok && data.lastUpdate) {
          return new Date(data.lastUpdate);
        }
        return null;
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });
}
