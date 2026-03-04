import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '@/lib/api-config';

interface PublishDateResponse {
  ok: boolean;
  lastUpdate: string | null;
}

export function usePublishDate() {
  return useQuery({
    queryKey: ['publish-date'],
    queryFn: async (): Promise<Date | null> => {
      try {
        const response = await fetch(apiUrl('/api/last-update'), { credentials: 'include' });
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
