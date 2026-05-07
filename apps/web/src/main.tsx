import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { AuthGate, AuthProvider } from "./auth-provider";
import { queryClient } from "./query";
import { router } from "./router";
import "./styles.css";

const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: "sanemail-query-cache-v2",
});

registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 12 }}
    >
      <AuthProvider>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </AuthProvider>
    </PersistQueryClientProvider>
  </React.StrictMode>,
);
