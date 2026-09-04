# Star Chicken Backend (Node.js + Supabase + Render)

A REST API backend for the Star Chicken Inventory & Branch Management frontend.
Handles products, the Slaughter House warehouse, branches, stock transfers
(with a pending → received workflow), stock requests, sales/invoices,
customers, and PIN-based staff login — all persisted in Supabase (Postgres).

## Project structure
```
star-chicken-backend/
├── sql/schema.sql        # Run this in Supabase SQL Editor first
├── scripts/seedAdmin.js  # Creates the first Super Admin + Slaughter House
├── src/
│   ├── server.js         # Express app entrypoint
│   ├── supabaseClient.js
│   ├── middleware/auth.js
│   └── routes/           # auth, products, branches, stock, transfers,
│                          # stockRequests, sales, customers, employees
├── .env.example
└── package.json
```

---

## Step 1 — Create the Supabase project

1. Go to https://supabase.com → **New project**.
2. Pick a name, database password (save it), and region close to your users.
3. Wait ~2 minutes for it to provision.
4. In the left sidebar go to **SQL Editor → New query**, paste the entire
   contents of `sql/schema.sql`, and click **Run**. This creates every table
   (products, locations, stock, transfers, sales, users, etc.) plus the
   transaction-safe functions used for transfers and sales.
5. Go to **Project Settings → API**. Copy:
   - **Project URL** → this is `SUPABASE_URL`
   - **service_role key** (NOT the `anon` key — this backend needs full
     access) → this is `SUPABASE_SERVICE_ROLE_KEY`

   ⚠️ The service role key bypasses all row-level security and must **never**
   be exposed to a browser/frontend. It only ever lives in this backend's
   environment variables.

---

## Step 2 — Run it locally first (recommended)

```bash
cd star-chicken-backend
npm install
cp .env.example .env
```

Edit `.env` and fill in:
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
JWT_SECRET=some-long-random-string
CORS_ORIGIN=http://localhost:5500
```

Create the first admin account and the Slaughter House location:
```bash
npm run seed:admin
```
This prints a Super Admin id and PIN (`1234` by default — change
`SEED_ADMIN_PIN` in `.env` first if you want a different one) and a
Slaughter House id. **Save both** — you'll need the Slaughter House id when
adding products with initial stock, or when approving stock requests.

Start the server:
```bash
npm start
```
Visit `http://localhost:4000/health` — you should see `{"status":"healthy"}`.

Test login:
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"userId":"<admin id from seed output>","pin":"1234"}'
```
You'll get back a `token` — use it as `Authorization: Bearer <token>` on
every other request.

---

## Step 3 — Push the code to GitHub

Render deploys from a Git repo.
```bash
cd star-chicken-backend
git init
git add .
git commit -m "Star Chicken backend"
```
Create a new empty repo on GitHub, then:
```bash
git remote add origin https://github.com/YOUR-USERNAME/star-chicken-backend.git
git branch -M main
git push -u origin main
```
(`.env` is already in `.gitignore` — it will never be pushed.)

---

## Step 4 — Deploy on Render

1. Go to https://render.com and sign in (GitHub login is easiest).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account and select the `star-chicken-backend` repo.
4. Fill in:
   - **Name**: `star-chicken-backend` (or anything)
   - **Region**: closest to your users
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` (fine to start; it sleeps after inactivity —
     upgrade to a paid tier later for an always-on API)
5. Under **Environment Variables**, click **Add Environment Variable** and
   add each of these (same values as your local `.env`, except `CORS_ORIGIN`
   — set it to wherever your frontend will actually be hosted):
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   JWT_SECRET=some-long-random-string
   CORS_ORIGIN=https://your-frontend-domain.com
   ```
   (`PORT` does not need to be set — Render provides it automatically.)
6. Click **Create Web Service**. Render will install dependencies, run
   `npm start`, and give you a live URL like:
   `https://star-chicken-backend.onrender.com`
7. Confirm it's alive: open
   `https://star-chicken-backend.onrender.com/health` in a browser.

That's it — your backend is now online, backed by Supabase Postgres, with
every product, transfer, sale, and stock change permanently recorded.

---

## Step 5 — Point the frontend at it

In your `18.html` frontend, replace the local-storage / in-memory logic
with `fetch` calls to your Render URL, e.g.:

```js
const API_BASE = 'https://star-chicken-backend.onrender.com/api';
let authToken = null; // set after login, keep in memory (not localStorage)

async function apiLogin(userId, pin) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pin })
  });
  if (!res.ok) throw new Error((await res.json()).error);
  const { token, user } = await res.json();
  authToken = token;
  return user;
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
```

I can do this rewiring for you, section by section (login screen first,
then products, then transfers/sales) — just say which part to start with.

---

## API reference (summary)

All routes except `/health`, `/`, and `/api/auth/*` require
`Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/roster` | List active users for the login screen |
| POST | `/api/auth/login` | `{userId, pin}` → JWT token |
| GET | `/api/products` | List active products |
| POST | `/api/products` | Create product (Super Admin) |
| PUT | `/api/products/:id` | Edit product — updates system-wide (Super Admin) |
| DELETE | `/api/products/:id` | Deactivate product (Super Admin) |
| GET | `/api/branches` | List locations (`?type=branch` or `?type=warehouse`) |
| POST | `/api/branches` | Create a branch (Super Admin) |
| GET | `/api/stock?location_id=` | Stock levels at a location |
| POST | `/api/stock/adjust` | Manual add/remove stock |
| POST | `/api/stock/physical-count` | Save a physical count, auto-computes difference |
| GET | `/api/stock/difference` | Latest expected vs physical differences |
| GET | `/api/transfers` | List transfers (`?status=`, `?location_id=`) |
| POST | `/api/transfers` | Create a pending transfer |
| POST | `/api/transfers/:id/receive` | Confirm receiving — moves stock |
| POST | `/api/transfers/:id/reject` | Reject a pending transfer |
| GET | `/api/stock-requests` | List branch stock/purchase requests |
| POST | `/api/stock-requests` | Branch creates a request |
| POST | `/api/stock-requests/:id/approve` | Approve + auto-create transfer |
| POST | `/api/stock-requests/:id/reject` | Reject a request |
| GET | `/api/sales` | List invoices (`?location_id=`, `?date=`) |
| POST | `/api/sales` | Create invoice — deducts branch stock atomically |
| GET | `/api/customers` | List customers with purchase summary |
| POST | `/api/customers` | Add customer |
| GET | `/api/employees` | List staff (Super Admin) |
| POST | `/api/employees` | Add staff with PIN + role + module access (Super Admin) |
| PUT | `/api/employees/:id` | Edit staff (Super Admin) |
| DELETE | `/api/employees/:id` | Deactivate staff (Super Admin) |

Every write also inserts a row into `activity_log` (who did what, when) —
that's your permanent audit trail.
