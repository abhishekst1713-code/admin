# Admin Panel

A unified dashboard that brings together three things Infopace runs separately: assessment reporting, social media management, and sales/leads CRM.

Access is role-based: **admin** sees everything below; **finance** is scoped to the Sales module only (see "Managing User Accounts & Roles").

---

## Features

### Main Dashboard (assessment reporting)
- **Overview** — cross-tool landing page: connection status for all 6 assessment databases, summary stats, and a condensed version of the Analytics charts.
- **Analytics** — cross-tool signals: health checks, alerts, and report-generation monitoring across every connected database.
- **Tool Performance** — per-tool scoring/attempt breakdowns.
- **Weekly Review** — a rolled-up activity digest across tools.
- **Supabase Settings** — connect/reconfigure any of the 6 database projects' URL + key directly from the UI, without editing `.env` (see "Connecting Your Live Supabase Databases").
- **Tool Categories** — an accordion grouping all 6 assessment tools by category (currently "AI Assessment" and "Psychometric"); expanding a tool opens its candidate list, individual report view, and PDF export.

### Social (`social-*` views)
- **Dashboard** — rolled-up KPI landing page across every connected platform.
- **Compose** — a three-panel editor/publishing/preview layout for creating and scheduling a post to one or more connected accounts at once.
- **Posts** — scheduled and published posts, as Scheduled/Published sub-tabs, with quick actions (edit, cancel, duplicate).
- **Inbox** — a unified view over mentions and direct messages across platforms, with per-platform column and assignee dropdown for routing conversations to a team member.
- **Analytics** — a channel-card grid with engagement charts (followers, reach, engagement) per connected account — Phase 4's "Brand Health" view.
- **Connect Accounts** — OAuth connect/disconnect flow for YouTube, Google Business Profile, Facebook, Instagram, LinkedIn, and WhatsApp (Cloud API). Tokens are encrypted at rest (AES-256-GCM).
- Scheduled posts publish via a BullMQ + Redis queue — one job per (post, target account), so a post targeting three accounts retries/fails/succeeds independently per platform.

### Sales (`leads-*` views) — finance + admin only
- **Dashboard** — a CRM-style view: sales funnel, leads-over-time chart, and pipeline summary.
- **All Leads** — a filterable/searchable table (status, campaign, assignee, free-text search) with a lead details drawer, status pipeline (New → Contacted → Qualified → Proposal → Won/Lost), and assignment to any finance or admin team member.
- **Excel export** — exports whatever filters are currently applied to the table, with an optional date-range picker (blank = all time).
- **Automatic lead capture** — polls connected Facebook accounts' Meta Lead Ads forms every 5 minutes, inserts genuinely new leads (deduped by `leadgen_id`), and fires two independent emails per lead: an internal "New lead" alert to everyone in `LEADS_NOTIFY_EMAIL`, and a short acknowledgement straight to the person who submitted the form.
- **Notification digest** — a catch-up tool (CLI script or `POST /api/leads/notify-pending`) that sends one summary email for any leads whose internal notification didn't go out, rather than one email per lead.

### Authentication & Roles
- Email/password login, JWT-based sessions.
- Two roles: **admin** (everything) and **finance** (Sales module only, enforced both in the sidebar and on the backend via `restrictFinanceToSalesOnly`/`requireRole`).
- Role changes take effect on the user's next request — no restart or re-login required.

## Project Architecture

```
├── backend/
│   ├── adapters/          # One file per assessment DB (db1.js–db6.js), each
│   │                       mapping that project's schema to a common shape
│   ├── social/
│   │   ├── adapters/      # One file per platform (youtube, google-business,
│   │   │                    facebook, instagram, linkedin, whatsapp)
│   │   ├── queue.js       # BullMQ + Redis publish queue for scheduled posts
│   │   ├── scheduler.js   # Legacy interval-based scheduler (Phase 1)
│   │   ├── pollers.js     # Inbound sync: mentions/inbox
│   │   └── db.js          # Client for the dedicated "social" Supabase project
│   ├── leads/
│   │   ├── poller.js      # Polls Meta Lead Ads forms, inserts new leads,
│   │   │                    sends internal + lead-acknowledgement emails
│   │   └── digest.js       # Shared digest-email logic (CLI script + HTTP route)
│   ├── routes/             # Express route modules (leads, social, etc.)
│   ├── migrations/         # SQL migrations for the social Supabase project
│   ├── scripts/            # One-off / maintenance scripts (see below)
│   ├── lib/                # Shared helpers: email, users, GA4
│   ├── server.js           # Express app entry point, auth, role gates
│   ├── .env                # Configuration (not committed — see .env.example)
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx         # Main app shell, auth, sidebar/routing
│   │   ├── social/         # Social module UI (Dashboard, Compose, Inbox, Analytics)
│   │   ├── leads/           # Sales module UI (Leads table, Dashboard)
│   │   └── main.jsx
│   ├── index.html
│   └── package.json
│
└── package.json             # Root workspace config (runs both via concurrently)
```

### Key Design Patterns

1. **Database Adapter Pattern** — every assessment tool has its own schema, so `backend/adapters/` has one file per project that queries it and normalizes the output into a shared shape the frontend renders generically.
2. **Role-Based Access Control** — `requireRole()` and `restrictFinanceToSalesOnly()` in `server.js` gate every route; the frontend mirrors the same split in the sidebar, but the backend is the actual enforcement point.
3. **Background Jobs Need a Persistent Process** — the leads poller, social scheduler, inbound-mention sync, and the BullMQ publish worker all run as long-lived loops started from `server.js`'s `app.listen()` callback. This only works on a host that keeps the process running continuously (e.g. Render) — it does **not** work on Vercel or other serverless platforms, where the process is frozen/killed between requests.
4. **Encrypted Token Storage** — social account access/refresh tokens are encrypted at rest (AES-256-GCM) using `SOCIAL_TOKEN_ENCRYPTION_KEY` before being stored in Supabase.

---

## Getting Started

### 1. Prerequisite
[Node.js](https://nodejs.org/) v18+ and a local or managed Redis instance (needed for the social publish queue).

### 2. Install and configure
```bash
npm run install:all
cp backend/.env.example backend/.env
# fill in backend/.env — see "Environment Variables" below
```

### 3. Start the development servers
From the root project directory:
```bash
npm run dev
```
- **Frontend**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:5000](http://localhost:5000)

---

## Environment Variables

See `backend/.env.example` for the full list with inline setup notes. Broadly:

| Group | Vars |
|---|---|
| Assessment DBs | `SUPABASE_URL_1..6`, `SUPABASE_KEY_1..6` |
| Analytics | `GA4_SERVICE_ACCOUNT_KEY`, `GA4_PROPERTY_ID_1..6` |
| Social module | `SUPABASE_URL_SOCIAL`, `SUPABASE_KEY_SOCIAL`, `SOCIAL_TOKEN_ENCRYPTION_KEY`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `META_APP_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET`, `REDIS_URL` |
| URLs | `BACKEND_PUBLIC_URL`, `FRONTEND_URL` (used to build OAuth redirect URIs) |
| Leads notifications | `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM`, `LEADS_NOTIFY_EMAIL`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` |

When `BACKEND_PUBLIC_URL` changes (e.g. after deploying), the OAuth redirect URIs built from it must be re-added to the corresponding Google/Meta/LinkedIn app configs — see the comments above each credential block in `.env.example` for the exact URIs each provider needs.

---

## Managing User Accounts & Roles

There's no public self-registration flow for roles beyond `admin`. To create or promote an account:
```bash
node backend/scripts/set-user-role.js <email> <admin|finance>
node backend/scripts/set-user-role.js <email> <admin|finance> --password <password>
```
`--password` creates the account if it doesn't exist, or resets an existing one's password. Takes effect immediately — no restart or re-login required.

---

## Maintenance Scripts

All under `backend/scripts/`, run with `node backend/scripts/<name>.js`:

- `set-user-role.js` — create/promote accounts (see above)
- `backfill-lead-notification-digest.js` — sends one digest email for any leads whose internal notification hasn't gone out yet (`--dry-run` to preview). Also reachable over HTTP as `POST /api/leads/notify-pending` (finance/admin only) for hosts without Shell access.
- `backfill-lead-fields.js` — one-off data backfill for lead records
- `register-whatsapp-number.js`, `check-whatsapp-subscription.js`, `subscribe-whatsapp-webhook.js`, `diagnose-whatsapp-waba.js` — WhatsApp Cloud API setup/diagnostics (see `backend/social/adapters/whatsapp.js`)

---

## Deployment

**Backend** needs a host that runs a persistent Node process (Render, Railway, Fly.io — not Vercel/serverless), because of the background jobs described above. It also needs a reachable Redis instance for the publish queue.

**Frontend** is a static Vite build (`npm run build` → `dist/`) and can be hosted anywhere static, including Vercel. It reads the backend's URL from `VITE_API_BASE` at build time — set this in your hosting provider's environment variables, no `/api` suffix.

After deploying the backend, update `BACKEND_PUBLIC_URL` (and OAuth redirect URIs, per the table above) and the frontend's `FRONTEND_URL` to match.
