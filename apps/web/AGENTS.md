# Web - Next.js Dashboard

Frontend for the Kodus platform.

## What Agents Get Wrong

- UI components use **Radix UI** (themes + primitives) with **CVA** for variants — not shadcn, not Material UI
- Styling is **TailwindCSS 4** (not v3) — uses CSS variables for theming, dark theme by default
- State management: **no store library** (no Redux, no Zustand). Uses React Query for server state, React Context for app state (SelectedTeam, Permissions, Byok), nuqs for URL params
- Auth is **NextAuth v5 beta** with JWT sessions — not cookie sessions, not custom auth
- Route structure uses App Router **grouped routes**: `(app)` for authenticated, `(auth)` for public, `(setup)` for onboarding
- Cockpit dashboard uses **parallel routes** (`@bugRatioAnalytics`, `@prCycleTimeAnalytics`, etc.) — not regular nested routes
- Forms use **react-hook-form + Zod** — not Formik, not uncontrolled forms
- Rich text editor is **TipTap** — not Slate, not Draft.js
- Charts use **Victory** and **react-google-charts**
- No i18n. English only
