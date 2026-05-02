# Frontend App Stack Recommendation

## Recommendation

The app now uses a Bun-powered TypeScript workspace:

```text
apps/
  api/       Bun HTTP API, Gmail OAuth, sync, local/dev storage
  web/       Vite React PWA
packages/
  shared/    shared schemas, DTOs, route types, fixtures
```

For the web app:

- Bun for package management, scripts, TypeScript execution, and fast local dev.
- React + TypeScript.
- Vite for the web build.
- TanStack Router for type-safe file-based routes.
- TanStack Query for server state, mutations, cache invalidation, and optimistic UI.
- TanStack Virtual for long message lists.
- vite-plugin-pwa with Workbox for installability, app-shell caching, and custom
  offline behavior.
- IndexedDB, preferably through Dexie, for offline mail snapshots and queued
  SaneMail-only actions.
- Tailwind CSS v4 plus shadcn/ui/Radix primitives for accessible, dense,
  mobile-capable UI.
- lucide-react for icons.

## Why `render.mjs` Was Removed

`render.mjs` was useful for proving the Gmail ingestion spine, but it was the
wrong place for the product experience:

- no component model
- no client-side navigation
- no durable offline story
- no installable PWA shell
- no ergonomic mobile interactions
- no clear separation between API state and view state

It has been retired. The API now serves JSON and can serve the built React PWA
for production-style local runs.

## Why Not TanStack Start Yet

TanStack Start is a good option and is currently documented as a release
candidate with stable APIs. It provides SSR, streaming, server functions, API
routes, and full-stack bundling on top of TanStack Router and Vite.

For SaneMail's next step, I recommend **Vite + TanStack Router + explicit Bun
API** instead:

- Email is behind auth, so SEO is not important.
- The PWA/offline model is client-first.
- We will eventually have mobile clients and background workers that should talk
  to the same API.
- Gmail OAuth, tokens, sync jobs, model calls, and future queue workers belong
  behind a stable API boundary.
- It keeps the migration from the current Node server straightforward.

Revisit TanStack Start when we want SSR, server functions, or one integrated
full-stack routing/runtime model more than we want a clean API split.

## PWA Strategy

The app should behave like a calm email client even on flaky mobile connections.

Initial offline scope:

- Cache the app shell and static assets.
- Persist TanStack Query cache.
- Store the latest `Today`, `All Mail` metadata, snippets, and message detail
  views in IndexedDB.
- Queue SaneMail-only feedback actions while offline.
- Show a clear offline state.

Careful default:

- Do not aggressively store all email bodies offline by default.
- Start with metadata/snippets and recently opened message bodies.
- Add an explicit "offline mail cache" setting later for users who want more.

Future offline scope:

- Workbox Background Sync for queued feedback and SaneMail-only mutations.
- Attachment metadata offline; attachment bodies only by explicit user action.
- Encrypted-at-rest local cache if the product commits to offline full-body mail.

## First Migration Slice

1. Convert the repo to Bun scripts and add a lockfile.
2. Move current server code into `apps/api`.
3. Add JSON API routes:
   - `GET /api/status`
   - `GET /api/messages`
   - `GET /api/messages/:id`
   - `GET /api/today`
   - `POST /api/messages/:id/feedback`
   - `GET /api/connect/gmail`
   - `GET /api/oauth/google/callback`
   - `POST /api/sync/gmail`
4. Scaffold `apps/web` with Vite, React, TypeScript, and TanStack Router.
5. Rebuild the existing screens in React:
   - connect/settings
   - `Today`
   - `All Mail`
   - message detail
   - feedback actions
6. Add TanStack Query for data loading and mutations.
7. Add PWA manifest and service worker.
8. Add IndexedDB-backed offline cache.
9. Replace server-rendered routes with the React app.

## Testing

- Bun/Node unit tests for classifier, Gmail normalization, and API handlers.
- React Testing Library or Vitest for component behavior.
- Playwright for browser smoke tests, mobile viewport checks, and installability
  basics.
- Lighthouse/PWA checks once the service worker and manifest exist.

## References

- TanStack Start overview:
  https://tanstack.com/start/docs/docs
- Bun guide for TanStack Start:
  https://bun.com/docs/guides/ecosystem/tanstack-start
- TanStack Router docs:
  https://tanstack.com/router/router/docs
- TanStack Query persistence:
  https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient/
- vite-plugin-pwa:
  https://www.npmjs.com/package/vite-plugin-pwa
- Workbox Background Sync:
  https://developer.chrome.com/docs/workbox/reference/workbox-background-sync
- shadcn/ui Vite setup:
  https://ui.shadcn.com/docs/installation/vite
- Radix Primitives:
  https://www.radix-ui.com/primitives/docs/overview/introduction
