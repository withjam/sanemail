import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

export const queryKeys = {
  status: ["status"] as const,
  home: ["home"] as const,
  messages: ["messages"] as const,
  today: ["today"] as const,
  message: (id: string) => ["message", id] as const,
  aiControl: ["ai-control"] as const,
  recentClassifications: ["recent-classifications"] as const,
};
