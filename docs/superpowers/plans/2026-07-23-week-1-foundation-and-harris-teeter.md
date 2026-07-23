# Week 1 — Foundation and Harris Teeter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working Next.js app deployed to Vercel that authenticates two users, pulls this week's deals from Harris Teeter via the Kroger Products API, and renders them on a home page. Establishes the foundation every subsequent week builds on.

**Architecture:** Next.js 14 (App Router) + Tailwind + shadcn/ui on Vercel. Supabase Postgres for persistence. Single-repo GitHub deploy. Shared-password auth via signed HttpOnly cookie. Kroger Products API for HT deals; response normalized to a common `NormalizedDeal` shape stored in `deals` table. Home page reads today's deals and renders them.

**Tech Stack:** TypeScript, Next.js 14, React 18, Tailwind CSS, shadcn/ui, `@supabase/supabase-js`, `jose` (JWT signing), Vitest, MSW (mock HTTP for tests), Node 20+.

---

## File Structure

```
grocery-planner/
├── .env.local.example
├── .gitignore
├── next.config.mjs
├── package.json
├── postcss.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── vitest.config.ts
├── middleware.ts                        # Auth middleware (all routes except /login, /api/auth/*)
├── app/
│   ├── layout.tsx                       # Root layout
│   ├── page.tsx                         # Home: this week's HT deals
│   ├── login/page.tsx                   # Password entry
│   └── api/
│       ├── auth/
│       │   ├── login/route.ts           # POST: verify password, set cookie
│       │   └── logout/route.ts          # POST: clear cookie
│       └── admin/
│           └── refresh-ht/route.ts      # POST (dev-only): trigger HT refresh
├── lib/
│   ├── auth/
│   │   ├── session.ts                   # signSession / verifySession
│   │   └── password.ts                  # constantTimeEqual
│   ├── db/
│   │   ├── client.ts                    # Supabase server client
│   │   └── types.ts                     # Typed schema (hand-written for now)
│   ├── ingestion/
│   │   ├── types.ts                     # NormalizedDeal + shared types
│   │   └── harris-teeter/
│   │       ├── auth.ts                  # Kroger OAuth token
│   │       ├── locations.ts             # Find HT stores near zip
│   │       ├── products.ts              # Search products at store
│   │       ├── normalize.ts             # Kroger response → NormalizedDeal
│   │       └── index.ts                 # fetchDeals(zip) orchestrator
│   └── canonical-ingredients/
│       └── seed-data.ts                 # 200-ingredient seed list
├── supabase/
│   └── migrations/
│       └── 0001_initial_schema.sql      # All 14 tables
├── seed/
│   └── run.ts                           # One-shot seeding script
└── tests/
    ├── auth/
    │   ├── session.test.ts
    │   └── password.test.ts
    ├── ingestion/
    │   └── harris-teeter/
    │       ├── auth.test.ts
    │       ├── locations.test.ts
    │       ├── products.test.ts
    │       ├── normalize.test.ts
    │       └── fixtures/
    │           ├── token-response.json
    │           ├── locations-response.json
    │           └── products-response.json
    └── setup.ts
```

Each file has one responsibility. Ingestion is split by concern (auth, locations, products, normalize) so a Kroger API change to any one endpoint touches exactly one file.

---

## Task 1: Bootstrap Next.js project and tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `.gitignore`, `.env.local.example`
- Create: `app/layout.tsx`, `app/page.tsx` (placeholder)

- [ ] **Step 1: Initialize the Next.js app**

From within `~/Documents/Coding/grocery-planner`:

```bash
npx create-next-app@latest . --typescript --tailwind --app --no-src-dir --import-alias "@/*" --eslint --use-npm
```

When prompted about existing files (git repo/spec), say **Yes** to continuing.

- [ ] **Step 2: Install runtime and dev dependencies**

```bash
npm install @supabase/supabase-js jose
npm install -D vitest @vitest/ui msw @types/node
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
```

- [ ] **Step 4: Create `tests/setup.ts`**

```ts
import { beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';

export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

- [ ] **Step 5: Add npm scripts and env example**

Edit `package.json` scripts:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Create `.env.local.example`:

```
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Kroger API
KROGER_CLIENT_ID=
KROGER_CLIENT_SECRET=

# Anthropic
ANTHROPIC_API_KEY=

# Auth
SHARED_PASSWORD=changeme
SESSION_SECRET=at-least-32-random-chars-please-generate-one
CRON_SECRET=
```

Append to `.gitignore` if not already present:

```
.env.local
.env*.local
tests/**/fixtures/*.local.json
```

- [ ] **Step 6: Verify tooling works**

```bash
npm run test
```
Expected: `No test files found` (that's OK — we haven't written tests yet).

```bash
npm run dev
```
Expected: Server starts on `http://localhost:3000`. Kill with Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Scaffold Next.js app with TypeScript, Tailwind, Vitest, and MSW"
```

---

## Task 2: Create Supabase project and apply schema

**Files:**
- Create: `supabase/migrations/0001_initial_schema.sql`

- [ ] **Step 1: Create the Supabase project (manual)**

Go to [supabase.com](https://supabase.com), sign in, click "New project."
- Name: `grocery-planner`
- Region: `East US (North Virginia)` (closest to Baltimore)
- Database password: generate a strong one, save to your password manager

Wait ~2 minutes for provisioning.

- [ ] **Step 2: Copy credentials into `.env.local`**

From the Supabase dashboard → **Project Settings → API**:
- Copy `Project URL` → `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`
- Copy `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Copy `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (⚠️ **server-side only**, never send to browser)

Create `.env.local` from the example and paste in the values:

```bash
cp .env.local.example .env.local
# then edit .env.local with the four Supabase values
```

Also generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output into `SESSION_SECRET` in `.env.local`. Also set `SHARED_PASSWORD` to something you and your wife will remember.

- [ ] **Step 3: Create the initial schema migration**

Create `supabase/migrations/0001_initial_schema.sql`:

```sql
-- Retailers and their stores
create table retailers (
  id serial primary key,
  name text not null unique,
  deep_link_pattern text
);

create table stores (
  id serial primary key,
  retailer_id int not null references retailers(id),
  store_number text not null,
  address text,
  zip text,
  is_active boolean not null default true,
  unique (retailer_id, store_number)
);

-- Canonical ingredient vocabulary
create table canonical_ingredients (
  id text primary key,           -- e.g. 'chicken_breast'
  name text not null,
  category text,
  default_unit text,
  aisle_group text
);

create table retailer_skus (
  id serial primary key,
  retailer_id int not null references retailers(id),
  sku text not null,
  product_name text not null,
  package_size numeric,
  package_unit text,
  image_url text,
  canonical_ingredient_id text references canonical_ingredients(id),
  mapping_confidence numeric,
  mapping_verified boolean not null default false,
  unique (retailer_id, sku)
);

create table deals (
  id serial primary key,
  retailer_sku_id int not null references retailer_skus(id),
  store_id int not null references stores(id),
  week_of date not null,
  regular_price numeric,
  sale_price numeric,
  unit_price numeric,
  valid_from date,
  valid_until date,
  source text not null,          -- 'api' | 'flipp'
  unique (retailer_sku_id, store_id, week_of)
);

-- Pantry, plans, shopping lists
create table pantry (
  id serial primary key,
  canonical_ingredient_id text not null references canonical_ingredients(id) unique,
  quantity numeric,
  unit text,
  updated_at timestamptz not null default now()
);

create table meal_plans (
  id serial primary key,
  week_of date not null,
  status text not null default 'draft',
  created_at timestamptz not null default now()
);

create table meals (
  id serial primary key,
  meal_plan_id int not null references meal_plans(id) on delete cascade,
  day text not null,
  meal_type text not null,
  name text not null,
  cuisine text,
  cook_time_minutes int,
  servings int,
  notes text
);

create table meal_ingredients (
  id serial primary key,
  meal_id int not null references meals(id) on delete cascade,
  canonical_ingredient_id text not null references canonical_ingredients(id),
  quantity numeric,
  unit text
);

create table recipe_steps (
  id serial primary key,
  meal_id int not null references meals(id) on delete cascade unique,
  steps_json jsonb not null,
  generated_at timestamptz not null default now()
);

create table meal_ratings (
  id serial primary key,
  meal_id int not null references meals(id) on delete cascade,
  rating text not null,          -- 'up' | 'down'
  note text,
  created_at timestamptz not null default now()
);

create table shopping_lists (
  id serial primary key,
  meal_plan_id int not null references meal_plans(id) on delete cascade,
  max_stores int not null default 3,
  created_at timestamptz not null default now()
);

create table shopping_list_items (
  id serial primary key,
  shopping_list_id int not null references shopping_lists(id) on delete cascade,
  canonical_ingredient_id text not null references canonical_ingredients(id),
  quantity numeric,
  unit text,
  assigned_store_id int references stores(id),
  retailer_sku_id int references retailer_skus(id),
  price numeric,
  deep_link_url text,
  purchased_at timestamptz
);

-- Health monitoring
create table retailer_health (
  id serial primary key,
  retailer_id int not null references retailers(id) unique,
  last_success_at timestamptz,
  last_status text,
  last_error text
);

-- Household preferences (see spec Section 12)
create table household_preferences (
  id int primary key default 1 check (id = 1),
  dietary_flags jsonb not null default '[]'::jsonb,
  disliked_ingredients jsonb not null default '[]'::jsonb,
  liked_ingredients jsonb not null default '[]'::jsonb,
  disliked_cuisines jsonb not null default '[]'::jsonb,
  liked_cuisines jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Seed the single household_preferences row
insert into household_preferences (id) values (1);

-- Seed retailers
insert into retailers (name, deep_link_pattern) values
  ('harris-teeter', 'https://www.harristeeter.com/product/{sku}'),
  ('target',        'https://www.target.com/p/-/A-{sku}'),
  ('safeway',       'https://www.safeway.com/shop/product-details.{sku}.html'),
  ('giant',         'https://giantfood.com/product/{sku}'),
  ('sprouts',       null);

-- Index for deal lookups
create index idx_deals_week on deals(week_of);
create index idx_deals_store on deals(store_id);
```

- [ ] **Step 4: Apply the migration**

In the Supabase dashboard → **SQL Editor**, paste the entire contents of `0001_initial_schema.sql` and click **Run**.

Expected: green success message. Under **Table Editor** you should see all 14 tables listed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0001_initial_schema.sql .env.local.example
git commit -m "Add initial Supabase schema with 14 tables"
```

---

## Task 3: Supabase client and typed schema

**Files:**
- Create: `lib/db/client.ts`
- Create: `lib/db/types.ts`

- [ ] **Step 1: Create `lib/db/types.ts` (hand-written types matching schema)**

```ts
export type Retailer = {
  id: number;
  name: 'harris-teeter' | 'target' | 'safeway' | 'giant' | 'sprouts';
  deep_link_pattern: string | null;
};

export type Store = {
  id: number;
  retailer_id: number;
  store_number: string;
  address: string | null;
  zip: string | null;
  is_active: boolean;
};

export type CanonicalIngredient = {
  id: string;
  name: string;
  category: string | null;
  default_unit: string | null;
  aisle_group: string | null;
};

export type RetailerSku = {
  id: number;
  retailer_id: number;
  sku: string;
  product_name: string;
  package_size: number | null;
  package_unit: string | null;
  image_url: string | null;
  canonical_ingredient_id: string | null;
  mapping_confidence: number | null;
  mapping_verified: boolean;
};

export type Deal = {
  id: number;
  retailer_sku_id: number;
  store_id: number;
  week_of: string;            // ISO date
  regular_price: number | null;
  sale_price: number | null;
  unit_price: number | null;
  valid_from: string | null;
  valid_until: string | null;
  source: 'api' | 'flipp';
};

export type RetailerHealth = {
  id: number;
  retailer_id: number;
  last_success_at: string | null;
  last_status: 'OK' | 'DEGRADED' | 'FAILED' | null;
  last_error: string | null;
};

export type Tables = {
  retailers: Retailer;
  stores: Store;
  canonical_ingredients: CanonicalIngredient;
  retailer_skus: RetailerSku;
  deals: Deal;
  retailer_health: RetailerHealth;
};
```

- [ ] **Step 2: Create `lib/db/client.ts`**

```ts
import { createClient } from '@supabase/supabase-js';

export function getServerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/db
git commit -m "Add Supabase server client and typed schema"
```

---

## Task 4: Session cookie utilities (TDD)

**Files:**
- Create: `lib/auth/session.ts`
- Create: `tests/auth/session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/session.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { signSession, verifySession } from '@/lib/auth/session';

describe('session', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'a'.repeat(64);
  });

  it('signs and verifies a session round-trip', async () => {
    const token = await signSession({ userId: 'household' });
    const payload = await verifySession(token);
    expect(payload.userId).toBe('household');
  });

  it('rejects tampered tokens', async () => {
    const token = await signSession({ userId: 'household' });
    const tampered = token.slice(0, -2) + 'xx';
    await expect(verifySession(tampered)).rejects.toThrow();
  });

  it('rejects expired tokens', async () => {
    const token = await signSession({ userId: 'household' }, { expiresInSeconds: -1 });
    await expect(verifySession(token)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test -- tests/auth/session.test.ts
```
Expected: FAIL with "Cannot find module '@/lib/auth/session'".

- [ ] **Step 3: Implement `lib/auth/session.ts`**

```ts
import { SignJWT, jwtVerify } from 'jose';

const DEFAULT_EXPIRES_SECONDS = 60 * 60 * 24 * 30; // 30 days

type SessionPayload = { userId: string };

function secret() {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 chars');
  }
  return new TextEncoder().encode(raw);
}

export async function signSession(
  payload: SessionPayload,
  opts: { expiresInSeconds?: number } = {}
): Promise<string> {
  const expires = opts.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
  return await new SignJWT({ userId: payload.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expires}s`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, secret());
  if (typeof payload.userId !== 'string') {
    throw new Error('Invalid session payload');
  }
  return { userId: payload.userId };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm run test -- tests/auth/session.test.ts
```
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/session.ts tests/auth/session.test.ts
git commit -m "Add session signing and verification utilities"
```

---

## Task 5: Constant-time password compare (TDD)

**Files:**
- Create: `lib/auth/password.ts`
- Create: `tests/auth/password.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/password.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { constantTimeEqual } from '@/lib/auth/password';

describe('constantTimeEqual', () => {
  it('returns true for matching strings', () => {
    expect(constantTimeEqual('hunter2', 'hunter2')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(constantTimeEqual('hunter2', 'hunter3')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(constantTimeEqual('short', 'much longer string')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test -- tests/auth/password.test.ts
```
Expected: FAIL with "Cannot find module '@/lib/auth/password'".

- [ ] **Step 3: Implement `lib/auth/password.ts`**

```ts
import { timingSafeEqual } from 'node:crypto';

export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm run test -- tests/auth/password.test.ts
```
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/password.ts tests/auth/password.test.ts
git commit -m "Add constant-time password comparison utility"
```

---

## Task 6: Login page and auth API routes

**Files:**
- Create: `app/login/page.tsx`
- Create: `app/api/auth/login/route.ts`
- Create: `app/api/auth/logout/route.ts`
- Create: `middleware.ts`

- [ ] **Step 1: Create the login API route**

Create `app/api/auth/login/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { constantTimeEqual } from '@/lib/auth/password';
import { signSession } from '@/lib/auth/session';

const COOKIE_NAME = 'gp_session';

export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({}));
  const expected = process.env.SHARED_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  if (typeof password !== 'string' || !constantTimeEqual(password, expected)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  const token = await signSession({ userId: 'household' });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
  return res;
}
```

- [ ] **Step 2: Create the logout API route**

Create `app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from 'next/server';

const COOKIE_NAME = 'gp_session';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', { maxAge: 0, path: '/' });
  return res;
}
```

- [ ] **Step 3: Create the middleware**

Create `middleware.ts` at the project root:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { verifySession } from '@/lib/auth/session';

const COOKIE_NAME = 'gp_session';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/logout'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }
  try {
    await verifySession(token);
    return NextResponse.next();
  } catch {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

- [ ] **Step 4: Create the login page**

Create `app/login/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setPending(false);
    if (!res.ok) {
      setError('Incorrect password.');
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Grocery Planner</h1>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded border px-3 py-2"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded bg-black px-3 py-2 text-white disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Manually verify the auth flow**

Start the dev server:

```bash
npm run dev
```

Open `http://localhost:3000` in a browser. Expected: redirect to `/login`.

Enter the wrong password. Expected: "Incorrect password."

Enter the correct password (from `.env.local`). Expected: redirect to `/`.

Kill the server with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add app/login app/api/auth middleware.ts
git commit -m "Add password login, logout, and auth middleware"
```

---

## Task 7: Seed canonical ingredients

**Files:**
- Create: `lib/canonical-ingredients/seed-data.ts`
- Create: `seed/run.ts`
- Modify: `package.json` (add seed script)

- [ ] **Step 1: Create the seed data**

Create `lib/canonical-ingredients/seed-data.ts`:

```ts
import type { CanonicalIngredient } from '@/lib/db/types';

// 200-ingredient starter list. IDs are stable; names are display-only.
// aisle_group values: produce | dairy | meat | seafood | pantry | frozen | bakery | deli | beverage | snack
export const CANONICAL_INGREDIENTS: CanonicalIngredient[] = [
  // Produce - vegetables
  { id: 'yellow_onion', name: 'Yellow Onion', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'red_onion', name: 'Red Onion', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'garlic', name: 'Garlic', category: 'vegetable', default_unit: 'head', aisle_group: 'produce' },
  { id: 'ginger', name: 'Ginger', category: 'vegetable', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'carrot', name: 'Carrots', category: 'vegetable', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'celery', name: 'Celery', category: 'vegetable', default_unit: 'bunch', aisle_group: 'produce' },
  { id: 'potato_russet', name: 'Russet Potato', category: 'vegetable', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'potato_yukon', name: 'Yukon Gold Potato', category: 'vegetable', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'sweet_potato', name: 'Sweet Potato', category: 'vegetable', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'broccoli', name: 'Broccoli', category: 'vegetable', default_unit: 'head', aisle_group: 'produce' },
  { id: 'cauliflower', name: 'Cauliflower', category: 'vegetable', default_unit: 'head', aisle_group: 'produce' },
  { id: 'spinach', name: 'Spinach', category: 'vegetable', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'kale', name: 'Kale', category: 'vegetable', default_unit: 'bunch', aisle_group: 'produce' },
  { id: 'romaine', name: 'Romaine Lettuce', category: 'vegetable', default_unit: 'head', aisle_group: 'produce' },
  { id: 'iceberg', name: 'Iceberg Lettuce', category: 'vegetable', default_unit: 'head', aisle_group: 'produce' },
  { id: 'arugula', name: 'Arugula', category: 'vegetable', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'tomato', name: 'Tomato', category: 'vegetable', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'cherry_tomato', name: 'Cherry Tomatoes', category: 'vegetable', default_unit: 'pint', aisle_group: 'produce' },
  { id: 'bell_pepper_red', name: 'Red Bell Pepper', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'bell_pepper_green', name: 'Green Bell Pepper', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'jalapeno', name: 'Jalapeño', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'cucumber', name: 'Cucumber', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'zucchini', name: 'Zucchini', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'yellow_squash', name: 'Yellow Squash', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'mushroom_white', name: 'White Mushrooms', category: 'vegetable', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'mushroom_baby_bella', name: 'Baby Bella Mushrooms', category: 'vegetable', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'green_bean', name: 'Green Beans', category: 'vegetable', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'asparagus', name: 'Asparagus', category: 'vegetable', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'brussels_sprout', name: 'Brussels Sprouts', category: 'vegetable', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'cabbage_green', name: 'Green Cabbage', category: 'vegetable', default_unit: 'head', aisle_group: 'produce' },
  { id: 'corn_ear', name: 'Corn on the Cob', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'scallion', name: 'Scallions', category: 'vegetable', default_unit: 'bunch', aisle_group: 'produce' },
  { id: 'shallot', name: 'Shallot', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'leek', name: 'Leek', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },
  { id: 'avocado', name: 'Avocado', category: 'vegetable', default_unit: 'each', aisle_group: 'produce' },

  // Produce - fruit
  { id: 'lemon', name: 'Lemon', category: 'fruit', default_unit: 'each', aisle_group: 'produce' },
  { id: 'lime', name: 'Lime', category: 'fruit', default_unit: 'each', aisle_group: 'produce' },
  { id: 'orange', name: 'Orange', category: 'fruit', default_unit: 'each', aisle_group: 'produce' },
  { id: 'apple', name: 'Apple', category: 'fruit', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'banana', name: 'Banana', category: 'fruit', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'strawberry', name: 'Strawberries', category: 'fruit', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'blueberry', name: 'Blueberries', category: 'fruit', default_unit: 'pint', aisle_group: 'produce' },
  { id: 'raspberry', name: 'Raspberries', category: 'fruit', default_unit: 'pint', aisle_group: 'produce' },
  { id: 'grape', name: 'Grapes', category: 'fruit', default_unit: 'lb', aisle_group: 'produce' },
  { id: 'pineapple', name: 'Pineapple', category: 'fruit', default_unit: 'each', aisle_group: 'produce' },

  // Herbs (fresh)
  { id: 'basil_fresh', name: 'Fresh Basil', category: 'herb', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'cilantro_fresh', name: 'Fresh Cilantro', category: 'herb', default_unit: 'bunch', aisle_group: 'produce' },
  { id: 'parsley_fresh', name: 'Fresh Parsley', category: 'herb', default_unit: 'bunch', aisle_group: 'produce' },
  { id: 'rosemary_fresh', name: 'Fresh Rosemary', category: 'herb', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'thyme_fresh', name: 'Fresh Thyme', category: 'herb', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'dill_fresh', name: 'Fresh Dill', category: 'herb', default_unit: 'bunch', aisle_group: 'produce' },
  { id: 'mint_fresh', name: 'Fresh Mint', category: 'herb', default_unit: 'oz', aisle_group: 'produce' },

  // Meat & poultry
  { id: 'chicken_breast', name: 'Chicken Breast (Boneless, Skinless)', category: 'poultry', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'chicken_thigh', name: 'Chicken Thighs (Boneless, Skinless)', category: 'poultry', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'chicken_thigh_bone_in', name: 'Chicken Thighs (Bone-in)', category: 'poultry', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'chicken_drumstick', name: 'Chicken Drumsticks', category: 'poultry', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'chicken_whole', name: 'Whole Chicken', category: 'poultry', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'chicken_wing', name: 'Chicken Wings', category: 'poultry', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'ground_beef_80', name: 'Ground Beef (80/20)', category: 'beef', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'ground_beef_90', name: 'Ground Beef (90/10)', category: 'beef', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'beef_chuck', name: 'Beef Chuck Roast', category: 'beef', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'beef_sirloin', name: 'Beef Sirloin Steak', category: 'beef', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'beef_ribeye', name: 'Ribeye Steak', category: 'beef', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'beef_flank', name: 'Flank Steak', category: 'beef', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'pork_chop', name: 'Pork Chops', category: 'pork', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'pork_tenderloin', name: 'Pork Tenderloin', category: 'pork', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'pork_shoulder', name: 'Pork Shoulder', category: 'pork', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'ground_pork', name: 'Ground Pork', category: 'pork', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'bacon', name: 'Bacon', category: 'pork', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'italian_sausage', name: 'Italian Sausage', category: 'pork', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'ground_turkey', name: 'Ground Turkey', category: 'poultry', default_unit: 'lb', aisle_group: 'meat' },
  { id: 'turkey_breast', name: 'Turkey Breast', category: 'poultry', default_unit: 'lb', aisle_group: 'meat' },

  // Seafood
  { id: 'salmon_fillet', name: 'Salmon Fillet', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood' },
  { id: 'tuna_steak', name: 'Tuna Steak', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood' },
  { id: 'shrimp', name: 'Shrimp', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood' },
  { id: 'cod_fillet', name: 'Cod Fillet', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood' },
  { id: 'tilapia_fillet', name: 'Tilapia Fillet', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood' },
  { id: 'tuna_canned', name: 'Canned Tuna', category: 'seafood', default_unit: 'can', aisle_group: 'pantry' },
  { id: 'sardines_canned', name: 'Canned Sardines', category: 'seafood', default_unit: 'can', aisle_group: 'pantry' },

  // Dairy & eggs
  { id: 'egg_large', name: 'Large Eggs', category: 'dairy', default_unit: 'dozen', aisle_group: 'dairy' },
  { id: 'milk_whole', name: 'Whole Milk', category: 'dairy', default_unit: 'gal', aisle_group: 'dairy' },
  { id: 'milk_2', name: '2% Milk', category: 'dairy', default_unit: 'gal', aisle_group: 'dairy' },
  { id: 'milk_skim', name: 'Skim Milk', category: 'dairy', default_unit: 'gal', aisle_group: 'dairy' },
  { id: 'butter_unsalted', name: 'Unsalted Butter', category: 'dairy', default_unit: 'lb', aisle_group: 'dairy' },
  { id: 'butter_salted', name: 'Salted Butter', category: 'dairy', default_unit: 'lb', aisle_group: 'dairy' },
  { id: 'heavy_cream', name: 'Heavy Cream', category: 'dairy', default_unit: 'pint', aisle_group: 'dairy' },
  { id: 'sour_cream', name: 'Sour Cream', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'greek_yogurt_plain', name: 'Plain Greek Yogurt', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'cream_cheese', name: 'Cream Cheese', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'cheese_cheddar', name: 'Cheddar Cheese', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'cheese_mozzarella', name: 'Mozzarella Cheese', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'cheese_parmesan', name: 'Parmesan Cheese', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'cheese_feta', name: 'Feta Cheese', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'cheese_goat', name: 'Goat Cheese', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'cheese_ricotta', name: 'Ricotta Cheese', category: 'dairy', default_unit: 'oz', aisle_group: 'dairy' },

  // Pantry - grains & starches
  { id: 'rice_white_long', name: 'Long-Grain White Rice', category: 'grain', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'rice_brown', name: 'Brown Rice', category: 'grain', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'rice_basmati', name: 'Basmati Rice', category: 'grain', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'rice_jasmine', name: 'Jasmine Rice', category: 'grain', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'quinoa', name: 'Quinoa', category: 'grain', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'pasta_spaghetti', name: 'Spaghetti', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'pasta_penne', name: 'Penne', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'pasta_rigatoni', name: 'Rigatoni', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'pasta_farfalle', name: 'Farfalle', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'pasta_orzo', name: 'Orzo', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'pasta_linguine', name: 'Linguine', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'lasagna_noodle', name: 'Lasagna Noodles', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'noodle_ramen', name: 'Ramen Noodles', category: 'pasta', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'noodle_udon', name: 'Udon Noodles', category: 'pasta', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'noodle_rice', name: 'Rice Noodles', category: 'pasta', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'flour_ap', name: 'All-Purpose Flour', category: 'baking', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'flour_bread', name: 'Bread Flour', category: 'baking', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'oats_rolled', name: 'Rolled Oats', category: 'grain', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'bread_sliced', name: 'Sliced Bread', category: 'bread', default_unit: 'loaf', aisle_group: 'bakery' },
  { id: 'bread_baguette', name: 'Baguette', category: 'bread', default_unit: 'each', aisle_group: 'bakery' },
  { id: 'tortilla_flour', name: 'Flour Tortillas', category: 'bread', default_unit: 'pack', aisle_group: 'bakery' },
  { id: 'tortilla_corn', name: 'Corn Tortillas', category: 'bread', default_unit: 'pack', aisle_group: 'bakery' },
  { id: 'bun_hamburger', name: 'Hamburger Buns', category: 'bread', default_unit: 'pack', aisle_group: 'bakery' },
  { id: 'bun_hotdog', name: 'Hot Dog Buns', category: 'bread', default_unit: 'pack', aisle_group: 'bakery' },
  { id: 'panko', name: 'Panko Breadcrumbs', category: 'baking', default_unit: 'oz', aisle_group: 'pantry' },

  // Pantry - beans & legumes
  { id: 'black_bean_canned', name: 'Canned Black Beans', category: 'legume', default_unit: 'can', aisle_group: 'pantry' },
  { id: 'kidney_bean_canned', name: 'Canned Kidney Beans', category: 'legume', default_unit: 'can', aisle_group: 'pantry' },
  { id: 'chickpea_canned', name: 'Canned Chickpeas', category: 'legume', default_unit: 'can', aisle_group: 'pantry' },
  { id: 'pinto_bean_canned', name: 'Canned Pinto Beans', category: 'legume', default_unit: 'can', aisle_group: 'pantry' },
  { id: 'cannellini_canned', name: 'Canned Cannellini Beans', category: 'legume', default_unit: 'can', aisle_group: 'pantry' },
  { id: 'lentil_dry', name: 'Dry Lentils', category: 'legume', default_unit: 'lb', aisle_group: 'pantry' },

  // Pantry - canned & jarred
  { id: 'tomato_crushed_canned', name: 'Canned Crushed Tomatoes', category: 'canned', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'tomato_diced_canned', name: 'Canned Diced Tomatoes', category: 'canned', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'tomato_paste', name: 'Tomato Paste', category: 'canned', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'tomato_sauce_canned', name: 'Canned Tomato Sauce', category: 'canned', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'pasta_sauce_jar', name: 'Jarred Pasta Sauce', category: 'canned', default_unit: 'jar', aisle_group: 'pantry' },
  { id: 'salsa_jar', name: 'Salsa', category: 'canned', default_unit: 'jar', aisle_group: 'pantry' },
  { id: 'coconut_milk_canned', name: 'Canned Coconut Milk', category: 'canned', default_unit: 'can', aisle_group: 'pantry' },
  { id: 'broth_chicken', name: 'Chicken Broth', category: 'canned', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'broth_vegetable', name: 'Vegetable Broth', category: 'canned', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'broth_beef', name: 'Beef Broth', category: 'canned', default_unit: 'oz', aisle_group: 'pantry' },

  // Pantry - oils, vinegars, condiments
  { id: 'olive_oil', name: 'Olive Oil', category: 'oil', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'vegetable_oil', name: 'Vegetable Oil', category: 'oil', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'sesame_oil', name: 'Sesame Oil', category: 'oil', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'vinegar_white', name: 'White Vinegar', category: 'vinegar', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'vinegar_apple_cider', name: 'Apple Cider Vinegar', category: 'vinegar', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'vinegar_balsamic', name: 'Balsamic Vinegar', category: 'vinegar', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'vinegar_rice', name: 'Rice Vinegar', category: 'vinegar', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'soy_sauce', name: 'Soy Sauce', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'fish_sauce', name: 'Fish Sauce', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'hot_sauce', name: 'Hot Sauce', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'sriracha', name: 'Sriracha', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'ketchup', name: 'Ketchup', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'mustard_dijon', name: 'Dijon Mustard', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'mustard_yellow', name: 'Yellow Mustard', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'mayo', name: 'Mayonnaise', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'honey', name: 'Honey', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'maple_syrup', name: 'Maple Syrup', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'peanut_butter', name: 'Peanut Butter', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'jam_strawberry', name: 'Strawberry Jam', category: 'condiment', default_unit: 'oz', aisle_group: 'pantry' },

  // Spices & seasonings
  { id: 'salt_kosher', name: 'Kosher Salt', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'pepper_black', name: 'Black Pepper', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'garlic_powder', name: 'Garlic Powder', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'onion_powder', name: 'Onion Powder', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'paprika', name: 'Paprika', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'smoked_paprika', name: 'Smoked Paprika', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'cumin_ground', name: 'Ground Cumin', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'coriander_ground', name: 'Ground Coriander', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'chili_powder', name: 'Chili Powder', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'cayenne', name: 'Cayenne', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'red_pepper_flakes', name: 'Red Pepper Flakes', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'cinnamon_ground', name: 'Ground Cinnamon', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'oregano_dried', name: 'Dried Oregano', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'basil_dried', name: 'Dried Basil', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'thyme_dried', name: 'Dried Thyme', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'bay_leaf', name: 'Bay Leaves', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'italian_seasoning', name: 'Italian Seasoning', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'curry_powder', name: 'Curry Powder', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'garam_masala', name: 'Garam Masala', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'turmeric', name: 'Turmeric', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'ginger_ground', name: 'Ground Ginger', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'nutmeg', name: 'Nutmeg', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'vanilla_extract', name: 'Vanilla Extract', category: 'spice', default_unit: 'oz', aisle_group: 'pantry' },

  // Sweeteners & baking
  { id: 'sugar_white', name: 'White Sugar', category: 'baking', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'sugar_brown', name: 'Brown Sugar', category: 'baking', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'sugar_powdered', name: 'Powdered Sugar', category: 'baking', default_unit: 'lb', aisle_group: 'pantry' },
  { id: 'baking_powder', name: 'Baking Powder', category: 'baking', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'baking_soda', name: 'Baking Soda', category: 'baking', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'yeast', name: 'Active Dry Yeast', category: 'baking', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'cornstarch', name: 'Cornstarch', category: 'baking', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'cocoa_powder', name: 'Cocoa Powder', category: 'baking', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'chocolate_chip', name: 'Chocolate Chips', category: 'baking', default_unit: 'oz', aisle_group: 'pantry' },

  // Nuts & seeds
  { id: 'almond', name: 'Almonds', category: 'nut', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'walnut', name: 'Walnuts', category: 'nut', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'pecan', name: 'Pecans', category: 'nut', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'cashew', name: 'Cashews', category: 'nut', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'peanut', name: 'Peanuts', category: 'nut', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'pine_nut', name: 'Pine Nuts', category: 'nut', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'sesame_seed', name: 'Sesame Seeds', category: 'seed', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'chia_seed', name: 'Chia Seeds', category: 'seed', default_unit: 'oz', aisle_group: 'pantry' },
  { id: 'flax_seed', name: 'Flax Seeds', category: 'seed', default_unit: 'oz', aisle_group: 'pantry' },

  // Frozen
  { id: 'frozen_peas', name: 'Frozen Peas', category: 'frozen', default_unit: 'oz', aisle_group: 'frozen' },
  { id: 'frozen_corn', name: 'Frozen Corn', category: 'frozen', default_unit: 'oz', aisle_group: 'frozen' },
  { id: 'frozen_broccoli', name: 'Frozen Broccoli', category: 'frozen', default_unit: 'oz', aisle_group: 'frozen' },
  { id: 'frozen_spinach', name: 'Frozen Spinach', category: 'frozen', default_unit: 'oz', aisle_group: 'frozen' },
  { id: 'frozen_berry_mix', name: 'Frozen Berry Mix', category: 'frozen', default_unit: 'oz', aisle_group: 'frozen' },
  { id: 'ice_cream_vanilla', name: 'Vanilla Ice Cream', category: 'frozen', default_unit: 'pint', aisle_group: 'frozen' },
  { id: 'frozen_pizza', name: 'Frozen Pizza', category: 'frozen', default_unit: 'each', aisle_group: 'frozen' },

  // Deli / misc
  { id: 'deli_turkey', name: 'Deli Turkey', category: 'deli', default_unit: 'lb', aisle_group: 'deli' },
  { id: 'deli_ham', name: 'Deli Ham', category: 'deli', default_unit: 'lb', aisle_group: 'deli' },
  { id: 'hummus', name: 'Hummus', category: 'deli', default_unit: 'oz', aisle_group: 'deli' },
  { id: 'olives', name: 'Olives', category: 'deli', default_unit: 'oz', aisle_group: 'deli' },
  { id: 'pickles', name: 'Pickles', category: 'condiment', default_unit: 'jar', aisle_group: 'pantry' },
  { id: 'tofu_firm', name: 'Firm Tofu', category: 'protein', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'tofu_extra_firm', name: 'Extra Firm Tofu', category: 'protein', default_unit: 'oz', aisle_group: 'produce' },
  { id: 'tempeh', name: 'Tempeh', category: 'protein', default_unit: 'oz', aisle_group: 'produce' },

  // Beverages
  { id: 'coffee_ground', name: 'Ground Coffee', category: 'beverage', default_unit: 'oz', aisle_group: 'beverage' },
  { id: 'tea_black', name: 'Black Tea', category: 'beverage', default_unit: 'oz', aisle_group: 'beverage' },
  { id: 'oj', name: 'Orange Juice', category: 'beverage', default_unit: 'oz', aisle_group: 'dairy' },
  { id: 'sparkling_water', name: 'Sparkling Water', category: 'beverage', default_unit: 'liter', aisle_group: 'beverage' },

  // Snacks
  { id: 'tortilla_chips', name: 'Tortilla Chips', category: 'snack', default_unit: 'oz', aisle_group: 'snack' },
  { id: 'crackers', name: 'Crackers', category: 'snack', default_unit: 'oz', aisle_group: 'snack' },
  { id: 'granola_bar', name: 'Granola Bars', category: 'snack', default_unit: 'box', aisle_group: 'snack' },
];
```

- [ ] **Step 2: Create the seed runner**

Install `tsx` for running TS scripts:

```bash
npm install -D tsx dotenv
```

Create `seed/run.ts`:

```ts
import 'dotenv/config';
import { getServerClient } from '@/lib/db/client';
import { CANONICAL_INGREDIENTS } from '@/lib/canonical-ingredients/seed-data';

async function main() {
  const supabase = getServerClient();

  console.log(`Seeding ${CANONICAL_INGREDIENTS.length} canonical ingredients…`);
  const { error } = await supabase
    .from('canonical_ingredients')
    .upsert(CANONICAL_INGREDIENTS, { onConflict: 'id' });

  if (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
  console.log('Seed complete.');
}

main();
```

- [ ] **Step 3: Add the seed script to `package.json`**

```json
{
  "scripts": {
    "seed": "tsx seed/run.ts"
  }
}
```

- [ ] **Step 4: Run the seed**

```bash
npm run seed
```
Expected: `Seeding 200 canonical ingredients…` followed by `Seed complete.`

Verify in Supabase → Table Editor → `canonical_ingredients` → should see 200 rows.

- [ ] **Step 5: Commit**

```bash
git add lib/canonical-ingredients seed package.json package-lock.json
git commit -m "Seed 200 canonical ingredients"
```

---

## Task 8: Kroger OAuth token client (TDD)

**Files:**
- Create: `lib/ingestion/harris-teeter/auth.ts`
- Create: `tests/ingestion/harris-teeter/auth.test.ts`
- Create: `tests/ingestion/harris-teeter/fixtures/token-response.json`

**Prerequisite (manual):** Register a Kroger developer account at [developer.kroger.com](https://developer.kroger.com), create a new app, and copy the `client_id` and `client_secret` into `.env.local`. This can be done anytime before Task 12.

- [ ] **Step 1: Add the token fixture**

Create `tests/ingestion/harris-teeter/fixtures/token-response.json`:

```json
{
  "access_token": "fake-access-token-abc123",
  "expires_in": 1800,
  "token_type": "bearer"
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/ingestion/harris-teeter/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/setup';
import fixture from './fixtures/token-response.json';
import { getKrogerAccessToken } from '@/lib/ingestion/harris-teeter/auth';

describe('getKrogerAccessToken', () => {
  beforeEach(() => {
    process.env.KROGER_CLIENT_ID = 'test-client-id';
    process.env.KROGER_CLIENT_SECRET = 'test-client-secret';
  });

  it('exchanges client credentials for an access token', async () => {
    let capturedAuth: string | null = null;
    let capturedBody: string | null = null;

    server.use(
      http.post('https://api.kroger.com/v1/connect/oauth2/token', async ({ request }) => {
        capturedAuth = request.headers.get('authorization');
        capturedBody = await request.text();
        return HttpResponse.json(fixture);
      })
    );

    const token = await getKrogerAccessToken();
    expect(token).toBe('fake-access-token-abc123');

    // Verify Basic auth header uses base64(client_id:client_secret)
    const expected = 'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64');
    expect(capturedAuth).toBe(expected);

    // Verify body uses correct scope
    expect(capturedBody).toContain('grant_type=client_credentials');
    expect(capturedBody).toContain('scope=product.compact');
  });

  it('throws when credentials are missing', async () => {
    delete process.env.KROGER_CLIENT_ID;
    await expect(getKrogerAccessToken()).rejects.toThrow(/KROGER_CLIENT_ID/);
  });

  it('throws on non-2xx response', async () => {
    server.use(
      http.post('https://api.kroger.com/v1/connect/oauth2/token', () =>
        HttpResponse.json({ error: 'invalid_client' }, { status: 401 })
      )
    );
    await expect(getKrogerAccessToken()).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npm run test -- tests/ingestion/harris-teeter/auth.test.ts
```
Expected: FAIL with "Cannot find module '@/lib/ingestion/harris-teeter/auth'".

- [ ] **Step 4: Implement `lib/ingestion/harris-teeter/auth.ts`**

```ts
const TOKEN_URL = 'https://api.kroger.com/v1/connect/oauth2/token';

export async function getKrogerAccessToken(): Promise<string> {
  const clientId = process.env.KROGER_CLIENT_ID;
  const clientSecret = process.env.KROGER_CLIENT_SECRET;
  if (!clientId) throw new Error('KROGER_CLIENT_ID is not set');
  if (!clientSecret) throw new Error('KROGER_CLIENT_SECRET is not set');

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'product.compact',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Kroger OAuth failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}
```

- [ ] **Step 5: Run to verify pass**

```bash
npm run test -- tests/ingestion/harris-teeter/auth.test.ts
```
Expected: 3 passing tests.

- [ ] **Step 6: Commit**

```bash
git add lib/ingestion/harris-teeter/auth.ts tests/ingestion/harris-teeter/
git commit -m "Add Kroger OAuth access token client"
```

---

## Task 9: Kroger locations client (TDD)

**Files:**
- Create: `lib/ingestion/harris-teeter/locations.ts`
- Create: `tests/ingestion/harris-teeter/locations.test.ts`
- Create: `tests/ingestion/harris-teeter/fixtures/locations-response.json`

- [ ] **Step 1: Add the locations fixture**

Create `tests/ingestion/harris-teeter/fixtures/locations-response.json`:

```json
{
  "data": [
    {
      "locationId": "09700123",
      "chain": "HARRISTEETER",
      "name": "Harris Teeter Locust Point",
      "address": {
        "addressLine1": "1801 Whetstone Way",
        "city": "Baltimore",
        "state": "MD",
        "zipCode": "21230"
      }
    },
    {
      "locationId": "09700456",
      "chain": "HARRISTEETER",
      "name": "Harris Teeter Federal Hill",
      "address": {
        "addressLine1": "500 E Fort Ave",
        "city": "Baltimore",
        "state": "MD",
        "zipCode": "21230"
      }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/ingestion/harris-teeter/locations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/setup';
import fixture from './fixtures/locations-response.json';
import { findHarrisTeeterStores } from '@/lib/ingestion/harris-teeter/locations';

describe('findHarrisTeeterStores', () => {
  it('returns HT stores near the given zip', async () => {
    let capturedUrl: URL | null = null;
    let capturedAuth: string | null = null;

    server.use(
      http.get('https://api.kroger.com/v1/locations', ({ request }) => {
        capturedUrl = new URL(request.url);
        capturedAuth = request.headers.get('authorization');
        return HttpResponse.json(fixture);
      })
    );

    const stores = await findHarrisTeeterStores('21224', 'fake-token');
    expect(stores).toHaveLength(2);
    expect(stores[0]).toEqual({
      store_number: '09700123',
      name: 'Harris Teeter Locust Point',
      address: '1801 Whetstone Way, Baltimore, MD 21230',
      zip: '21230',
    });

    // Verify the query params and bearer token
    expect(capturedUrl?.searchParams.get('filter.zipCode.near')).toBe('21224');
    expect(capturedUrl?.searchParams.get('filter.chain')).toBe('HARRISTEETER');
    expect(capturedAuth).toBe('Bearer fake-token');
  });

  it('throws on non-2xx response', async () => {
    server.use(
      http.get('https://api.kroger.com/v1/locations', () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 })
      )
    );
    await expect(findHarrisTeeterStores('21224', 'fake-token')).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npm run test -- tests/ingestion/harris-teeter/locations.test.ts
```
Expected: FAIL with "Cannot find module '@/lib/ingestion/harris-teeter/locations'".

- [ ] **Step 4: Implement `lib/ingestion/harris-teeter/locations.ts`**

```ts
const LOCATIONS_URL = 'https://api.kroger.com/v1/locations';

export type HTStore = {
  store_number: string;
  name: string;
  address: string;
  zip: string;
};

type KrogerLocation = {
  locationId: string;
  name: string;
  address: {
    addressLine1: string;
    city: string;
    state: string;
    zipCode: string;
  };
};

export async function findHarrisTeeterStores(
  zip: string,
  accessToken: string,
  radiusMiles = 15
): Promise<HTStore[]> {
  const url = new URL(LOCATIONS_URL);
  url.searchParams.set('filter.zipCode.near', zip);
  url.searchParams.set('filter.chain', 'HARRISTEETER');
  url.searchParams.set('filter.radiusInMiles', String(radiusMiles));

  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Kroger locations failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data: KrogerLocation[] };
  return data.data.map((loc) => ({
    store_number: loc.locationId,
    name: loc.name,
    address: `${loc.address.addressLine1}, ${loc.address.city}, ${loc.address.state} ${loc.address.zipCode}`,
    zip: loc.address.zipCode,
  }));
}
```

- [ ] **Step 5: Run to verify pass**

```bash
npm run test -- tests/ingestion/harris-teeter/locations.test.ts
```
Expected: 2 passing tests.

- [ ] **Step 6: Commit**

```bash
git add lib/ingestion/harris-teeter/locations.ts tests/ingestion/harris-teeter/locations.test.ts tests/ingestion/harris-teeter/fixtures/locations-response.json
git commit -m "Add Kroger locations client to find HT stores near zip"
```

---

## Task 10: Kroger products client (TDD)

**Files:**
- Create: `lib/ingestion/harris-teeter/products.ts`
- Create: `tests/ingestion/harris-teeter/products.test.ts`
- Create: `tests/ingestion/harris-teeter/fixtures/products-response.json`

- [ ] **Step 1: Add the products fixture**

Create `tests/ingestion/harris-teeter/fixtures/products-response.json`:

```json
{
  "data": [
    {
      "productId": "0001111041700",
      "description": "Kroger Boneless Skinless Chicken Breast",
      "brand": "Kroger",
      "categories": ["Meat & Seafood"],
      "images": [
        {
          "sizes": [{ "size": "medium", "url": "https://www.kroger.com/product/images/medium/1111041700" }]
        }
      ],
      "items": [
        {
          "itemId": "0001111041700",
          "size": "1 lb",
          "price": { "regular": 4.99, "promo": 3.49 },
          "fulfillment": { "instore": true, "curbside": false, "delivery": false, "shiptohome": false }
        }
      ]
    },
    {
      "productId": "0002222055500",
      "description": "Organic Baby Spinach",
      "brand": "Simple Truth",
      "categories": ["Produce"],
      "images": [],
      "items": [
        {
          "itemId": "0002222055500",
          "size": "5 oz",
          "price": { "regular": 3.99, "promo": 0 },
          "fulfillment": { "instore": true, "curbside": false, "delivery": false, "shiptohome": false }
        }
      ]
    }
  ],
  "meta": { "pagination": { "start": 1, "limit": 50, "total": 2 } }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/ingestion/harris-teeter/products.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/setup';
import fixture from './fixtures/products-response.json';
import { searchKrogerProducts } from '@/lib/ingestion/harris-teeter/products';

describe('searchKrogerProducts', () => {
  it('returns raw Kroger products for a store', async () => {
    let capturedUrl: URL | null = null;

    server.use(
      http.get('https://api.kroger.com/v1/products', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(fixture);
      })
    );

    const products = await searchKrogerProducts({
      storeId: '09700123',
      term: 'chicken',
      accessToken: 'fake-token',
    });

    expect(products).toHaveLength(2);
    expect(products[0].productId).toBe('0001111041700');
    expect(products[0].items[0].price.regular).toBe(4.99);
    expect(products[0].items[0].price.promo).toBe(3.49);

    expect(capturedUrl?.searchParams.get('filter.locationId')).toBe('09700123');
    expect(capturedUrl?.searchParams.get('filter.term')).toBe('chicken');
    expect(capturedUrl?.searchParams.get('filter.limit')).toBe('50');
  });

  it('throws on non-2xx response', async () => {
    server.use(
      http.get('https://api.kroger.com/v1/products', () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 })
      )
    );
    await expect(
      searchKrogerProducts({ storeId: 'x', term: 'y', accessToken: 't' })
    ).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npm run test -- tests/ingestion/harris-teeter/products.test.ts
```
Expected: FAIL with "Cannot find module '@/lib/ingestion/harris-teeter/products'".

- [ ] **Step 4: Implement `lib/ingestion/harris-teeter/products.ts`**

```ts
const PRODUCTS_URL = 'https://api.kroger.com/v1/products';

export type KrogerProduct = {
  productId: string;
  description: string;
  brand?: string;
  categories?: string[];
  images?: Array<{ sizes: Array<{ size: string; url: string }> }>;
  items: Array<{
    itemId: string;
    size?: string;
    price?: { regular: number; promo: number };
    fulfillment?: { instore: boolean };
  }>;
};

export async function searchKrogerProducts(args: {
  storeId: string;
  term: string;
  accessToken: string;
  limit?: number;
}): Promise<KrogerProduct[]> {
  const url = new URL(PRODUCTS_URL);
  url.searchParams.set('filter.locationId', args.storeId);
  url.searchParams.set('filter.term', args.term);
  url.searchParams.set('filter.limit', String(args.limit ?? 50));

  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Kroger products failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data: KrogerProduct[] };
  return data.data;
}
```

- [ ] **Step 5: Run to verify pass**

```bash
npm run test -- tests/ingestion/harris-teeter/products.test.ts
```
Expected: 2 passing tests.

- [ ] **Step 6: Commit**

```bash
git add lib/ingestion/harris-teeter/products.ts tests/ingestion/harris-teeter/products.test.ts tests/ingestion/harris-teeter/fixtures/products-response.json
git commit -m "Add Kroger products search client"
```

---

## Task 11: HT normalizer and fetchDeals orchestrator (TDD)

**Files:**
- Create: `lib/ingestion/types.ts`
- Create: `lib/ingestion/harris-teeter/normalize.ts`
- Create: `lib/ingestion/harris-teeter/index.ts`
- Create: `tests/ingestion/harris-teeter/normalize.test.ts`

- [ ] **Step 1: Create the shared ingestion types**

Create `lib/ingestion/types.ts`:

```ts
export type NormalizedDeal = {
  retailer: 'harris-teeter' | 'target' | 'safeway' | 'giant' | 'sprouts';
  store_number: string;
  sku: string;
  product_name: string;
  package_size: number | null;
  package_unit: string | null;
  image_url: string | null;
  regular_price: number | null;
  sale_price: number | null;
  on_sale: boolean;
  source: 'api' | 'flipp';
};
```

- [ ] **Step 2: Write the failing normalize test**

Create `tests/ingestion/harris-teeter/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeKrogerProducts } from '@/lib/ingestion/harris-teeter/normalize';
import type { KrogerProduct } from '@/lib/ingestion/harris-teeter/products';

const chicken: KrogerProduct = {
  productId: '0001111041700',
  description: 'Kroger Boneless Skinless Chicken Breast',
  images: [{ sizes: [{ size: 'medium', url: 'https://img/chicken' }] }],
  items: [
    {
      itemId: '0001111041700',
      size: '1 lb',
      price: { regular: 4.99, promo: 3.49 },
      fulfillment: { instore: true },
    },
  ],
};

const spinach: KrogerProduct = {
  productId: '0002222055500',
  description: 'Organic Baby Spinach',
  images: [],
  items: [
    {
      itemId: '0002222055500',
      size: '5 oz',
      price: { regular: 3.99, promo: 0 },
      fulfillment: { instore: true },
    },
  ],
};

describe('normalizeKrogerProducts', () => {
  it('flags items with promo price as on_sale', () => {
    const [deal] = normalizeKrogerProducts([chicken], '09700123');
    expect(deal).toMatchObject({
      retailer: 'harris-teeter',
      store_number: '09700123',
      sku: '0001111041700',
      product_name: 'Kroger Boneless Skinless Chicken Breast',
      package_size: 1,
      package_unit: 'lb',
      image_url: 'https://img/chicken',
      regular_price: 4.99,
      sale_price: 3.49,
      on_sale: true,
      source: 'api',
    });
  });

  it('marks items without promo as not on sale', () => {
    const [deal] = normalizeKrogerProducts([spinach], '09700123');
    expect(deal.on_sale).toBe(false);
    expect(deal.sale_price).toBeNull();
    expect(deal.regular_price).toBe(3.99);
    expect(deal.package_size).toBe(5);
    expect(deal.package_unit).toBe('oz');
  });

  it('skips products with no items array or no first item', () => {
    const broken: KrogerProduct = { productId: 'x', description: 'y', items: [] };
    expect(normalizeKrogerProducts([broken], 's')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npm run test -- tests/ingestion/harris-teeter/normalize.test.ts
```
Expected: FAIL with "Cannot find module '@/lib/ingestion/harris-teeter/normalize'".

- [ ] **Step 4: Implement `lib/ingestion/harris-teeter/normalize.ts`**

```ts
import type { NormalizedDeal } from '@/lib/ingestion/types';
import type { KrogerProduct } from './products';

const SIZE_RE = /^\s*([\d.]+)\s*(\w+)\s*$/;

function parseSize(size?: string): { value: number | null; unit: string | null } {
  if (!size) return { value: null, unit: null };
  const m = size.match(SIZE_RE);
  if (!m) return { value: null, unit: null };
  return { value: parseFloat(m[1]), unit: m[2].toLowerCase() };
}

function firstImage(p: KrogerProduct): string | null {
  const url = p.images?.[0]?.sizes?.[0]?.url;
  return url ?? null;
}

export function normalizeKrogerProducts(
  products: KrogerProduct[],
  storeNumber: string
): NormalizedDeal[] {
  const deals: NormalizedDeal[] = [];
  for (const p of products) {
    const item = p.items?.[0];
    if (!item) continue;
    const { value: package_size, unit: package_unit } = parseSize(item.size);
    const regular = item.price?.regular ?? null;
    const promo = item.price?.promo && item.price.promo > 0 ? item.price.promo : null;
    deals.push({
      retailer: 'harris-teeter',
      store_number: storeNumber,
      sku: item.itemId,
      product_name: p.description,
      package_size,
      package_unit,
      image_url: firstImage(p),
      regular_price: regular,
      sale_price: promo,
      on_sale: promo !== null && regular !== null && promo < regular,
      source: 'api',
    });
  }
  return deals;
}
```

- [ ] **Step 5: Run to verify pass**

```bash
npm run test -- tests/ingestion/harris-teeter/normalize.test.ts
```
Expected: 3 passing tests.

- [ ] **Step 6: Create the fetchDeals orchestrator**

Create `lib/ingestion/harris-teeter/index.ts`:

```ts
import { getKrogerAccessToken } from './auth';
import { findHarrisTeeterStores } from './locations';
import { searchKrogerProducts } from './products';
import { normalizeKrogerProducts } from './normalize';
import type { NormalizedDeal } from '@/lib/ingestion/types';

// Broad category search terms — covers most weekly deals in a few calls.
// We accept some duplicate SKUs across terms; the caller de-dupes by (sku).
const SEARCH_TERMS = [
  'chicken', 'beef', 'pork', 'seafood', 'produce', 'dairy',
  'bread', 'pasta', 'rice', 'cheese', 'yogurt', 'cereal',
  'snack', 'frozen', 'canned', 'oil',
];

export async function fetchHarrisTeeterDeals(zip: string): Promise<{
  stores: Array<{ store_number: string; name: string; address: string; zip: string }>;
  deals: NormalizedDeal[];
}> {
  const token = await getKrogerAccessToken();
  const stores = await findHarrisTeeterStores(zip, token);
  if (stores.length === 0) return { stores: [], deals: [] };

  // MVP: pull deals from the closest store only.
  const store = stores[0];
  const seenSkus = new Set<string>();
  const allDeals: NormalizedDeal[] = [];

  for (const term of SEARCH_TERMS) {
    try {
      const products = await searchKrogerProducts({
        storeId: store.store_number,
        term,
        accessToken: token,
      });
      const normalized = normalizeKrogerProducts(products, store.store_number);
      for (const d of normalized) {
        if (seenSkus.has(d.sku)) continue;
        seenSkus.add(d.sku);
        allDeals.push(d);
      }
    } catch (err) {
      console.warn(`Kroger search failed for term "${term}":`, err);
    }
  }

  return { stores, deals: allDeals };
}
```

- [ ] **Step 7: Commit**

```bash
git add lib/ingestion/
git commit -m "Add HT normalizer and fetchDeals orchestrator"
```

---

## Task 12: Wire ingestion to database and expose dev endpoint

**Files:**
- Create: `lib/ingestion/harris-teeter/persist.ts`
- Create: `app/api/admin/refresh-ht/route.ts`

- [ ] **Step 1: Create the persist helper**

Create `lib/ingestion/harris-teeter/persist.ts`:

```ts
import { getServerClient } from '@/lib/db/client';
import type { NormalizedDeal } from '@/lib/ingestion/types';
import type { HTStore } from './locations';

function currentWeekOfISO(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - day);
  return sunday.toISOString().slice(0, 10);
}

export async function persistHarrisTeeterDeals(input: {
  stores: HTStore[];
  deals: NormalizedDeal[];
}) {
  const supabase = getServerClient();

  const { data: retailerRow, error: rErr } = await supabase
    .from('retailers')
    .select('id')
    .eq('name', 'harris-teeter')
    .single();
  if (rErr || !retailerRow) throw new Error('harris-teeter retailer row missing');
  const retailerId = retailerRow.id;

  // Upsert stores
  const storeRows = input.stores.map((s) => ({
    retailer_id: retailerId,
    store_number: s.store_number,
    address: s.address,
    zip: s.zip,
    is_active: true,
  }));
  const { error: sErr } = await supabase
    .from('stores')
    .upsert(storeRows, { onConflict: 'retailer_id,store_number' });
  if (sErr) throw sErr;

  // Reload store IDs
  const { data: storeIdRows, error: sIdErr } = await supabase
    .from('stores')
    .select('id, store_number')
    .eq('retailer_id', retailerId);
  if (sIdErr || !storeIdRows) throw sIdErr ?? new Error('no stores');
  const storeIdByNumber = new Map(storeIdRows.map((r) => [r.store_number, r.id]));

  // Upsert retailer_skus
  const skuRows = input.deals.map((d) => ({
    retailer_id: retailerId,
    sku: d.sku,
    product_name: d.product_name,
    package_size: d.package_size,
    package_unit: d.package_unit,
    image_url: d.image_url,
  }));
  const { error: skuErr } = await supabase
    .from('retailer_skus')
    .upsert(skuRows, { onConflict: 'retailer_id,sku', ignoreDuplicates: false });
  if (skuErr) throw skuErr;

  // Reload SKU IDs
  const skus = input.deals.map((d) => d.sku);
  const { data: skuIdRows, error: skuIdErr } = await supabase
    .from('retailer_skus')
    .select('id, sku')
    .eq('retailer_id', retailerId)
    .in('sku', skus);
  if (skuIdErr || !skuIdRows) throw skuIdErr ?? new Error('no skus');
  const skuIdByCode = new Map(skuIdRows.map((r) => [r.sku, r.id]));

  // Upsert deals
  const weekOf = currentWeekOfISO();
  const dealRows = input.deals
    .map((d) => {
      const storeId = storeIdByNumber.get(d.store_number);
      const skuId = skuIdByCode.get(d.sku);
      if (!storeId || !skuId) return null;
      return {
        retailer_sku_id: skuId,
        store_id: storeId,
        week_of: weekOf,
        regular_price: d.regular_price,
        sale_price: d.sale_price,
        unit_price: null,
        valid_from: null,
        valid_until: null,
        source: d.source,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const { error: dErr } = await supabase
    .from('deals')
    .upsert(dealRows, { onConflict: 'retailer_sku_id,store_id,week_of' });
  if (dErr) throw dErr;

  // Update health
  await supabase
    .from('retailer_health')
    .upsert(
      { retailer_id: retailerId, last_success_at: new Date().toISOString(), last_status: 'OK', last_error: null },
      { onConflict: 'retailer_id' }
    );

  return { dealsUpserted: dealRows.length };
}
```

- [ ] **Step 2: Create the dev-only refresh endpoint**

Create `app/api/admin/refresh-ht/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { fetchHarrisTeeterDeals } from '@/lib/ingestion/harris-teeter';
import { persistHarrisTeeterDeals } from '@/lib/ingestion/harris-teeter/persist';

const ZIP = '21224';

export async function POST() {
  try {
    const result = await fetchHarrisTeeterDeals(ZIP);
    const persist = await persistHarrisTeeterDeals(result);
    return NextResponse.json({
      ok: true,
      stores: result.stores.length,
      dealsFetched: result.deals.length,
      dealsUpserted: persist.dealsUpserted,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Manually trigger the refresh**

Make sure `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` are set in `.env.local`.

Start the dev server:

```bash
npm run dev
```

Log in via the browser at `http://localhost:3000` first (so you have an auth cookie). Then open DevTools → Console on any authenticated page and run:

```js
await fetch('/api/admin/refresh-ht', { method: 'POST' }).then((r) => r.json())
```

Expected output shape:

```json
{ "ok": true, "stores": 3, "dealsFetched": 250, "dealsUpserted": 250 }
```

Verify in Supabase → Table Editor:
- `stores` → HT rows populated
- `retailer_skus` → hundreds of rows
- `deals` → hundreds of rows for `week_of` = this Sunday's date
- `retailer_health` → HT row with `last_status = 'OK'`

Kill the dev server.

- [ ] **Step 4: Commit**

```bash
git add lib/ingestion/harris-teeter/persist.ts app/api/admin/refresh-ht
git commit -m "Persist HT deals to Supabase; add dev refresh endpoint"
```

---

## Task 13: Home page renders this week's HT deals

**Files:**
- Create: `app/page.tsx` (replace scaffold)
- Create: `lib/deals/read.ts`
- Modify: `app/layout.tsx` (add basic nav / title)

- [ ] **Step 1: Create a deals reader**

Create `lib/deals/read.ts`:

```ts
import { getServerClient } from '@/lib/db/client';

export type DealForDisplay = {
  product_name: string;
  regular_price: number | null;
  sale_price: number | null;
  image_url: string | null;
  retailer_name: string;
};

function currentWeekOfISO(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - day);
  return sunday.toISOString().slice(0, 10);
}

export async function getCurrentWeekOnSaleDeals(limit = 60): Promise<DealForDisplay[]> {
  const supabase = getServerClient();
  const weekOf = currentWeekOfISO();

  const { data, error } = await supabase
    .from('deals')
    .select(
      `regular_price, sale_price,
       retailer_skus!inner (product_name, image_url,
         retailers!inner (name))`
    )
    .eq('week_of', weekOf)
    .not('sale_price', 'is', null)
    .order('sale_price', { ascending: true })
    .limit(limit);

  if (error) throw error;
  if (!data) return [];

  return data.map((row: any) => ({
    product_name: row.retailer_skus.product_name,
    regular_price: row.regular_price,
    sale_price: row.sale_price,
    image_url: row.retailer_skus.image_url,
    retailer_name: row.retailer_skus.retailers.name,
  }));
}
```

- [ ] **Step 2: Update `app/layout.tsx`**

Replace `app/layout.tsx` with:

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Grocery Planner',
  description: 'Deals-first weekly meal planner',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900 antialiased">
        <div className="mx-auto max-w-2xl p-4">
          <header className="mb-6 flex items-center justify-between">
            <h1 className="text-xl font-semibold">Grocery Planner</h1>
            <form action="/api/auth/logout" method="POST">
              <button type="submit" className="text-sm text-neutral-500 hover:underline">
                Log out
              </button>
            </form>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Replace `app/page.tsx`**

```tsx
import { getCurrentWeekOnSaleDeals } from '@/lib/deals/read';

export const dynamic = 'force-dynamic';

function formatPrice(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}

export default async function HomePage() {
  const deals = await getCurrentWeekOnSaleDeals();

  return (
    <main>
      <section className="mb-6">
        <h2 className="text-lg font-semibold">This Week's Deals</h2>
        <p className="text-sm text-neutral-500">
          {deals.length > 0
            ? `${deals.length} items on sale`
            : 'No deals loaded yet. Trigger a refresh via /api/admin/refresh-ht.'}
        </p>
      </section>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {deals.map((d, i) => (
          <li
            key={i}
            className="flex items-start gap-3 rounded border bg-white p-3 shadow-sm"
          >
            {d.image_url && (
              <img
                src={d.image_url}
                alt=""
                className="h-14 w-14 rounded object-cover"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium">{d.product_name}</p>
              <p className="text-xs text-neutral-500 capitalize">{d.retailer_name}</p>
              <p className="mt-1 text-sm">
                <span className="font-semibold text-green-700">
                  {formatPrice(d.sale_price)}
                </span>
                {d.regular_price !== null && d.sale_price !== null && (
                  <span className="ml-2 text-neutral-400 line-through">
                    {formatPrice(d.regular_price)}
                  </span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 4: Manually verify end-to-end**

Start the dev server:

```bash
npm run dev
```

Open `http://localhost:3000`. Log in.

Expected: Home page shows this week's HT deals rendered as cards. If deals count is 0, trigger the refresh again from the browser console:

```js
await fetch('/api/admin/refresh-ht', { method: 'POST' }).then((r) => r.json())
```

Refresh the page — deals should appear. Kill the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/ lib/deals
git commit -m "Home page: render this week's HT deals from DB"
```

---

## Task 14: Push to GitHub and deploy to Vercel

**Files:**
- Create: `README.md` (project readme)

- [ ] **Step 1: Create a minimal `README.md`**

```markdown
# Grocery Planner

Personal deals-first weekly meal planner for Baltimore (21224).

## Setup

1. Copy `.env.local.example` to `.env.local` and fill in values.
2. Create a Supabase project and apply `supabase/migrations/0001_initial_schema.sql`.
3. Register a Kroger developer app at developer.kroger.com; add credentials to `.env.local`.
4. Install and run:

   ```bash
   npm install
   npm run seed        # seeds canonical ingredients
   npm run dev
   ```

## Deploy

Push to GitHub, then import the repo in Vercel. Set all env vars from `.env.local` in Vercel project settings.
```

- [ ] **Step 2: Create the GitHub repo (manual)**

On [github.com](https://github.com/new): create a new **private** repo named `grocery-planner`. Do not initialize with README, .gitignore, or license — the local repo already has those.

Add the remote and push:

```bash
git remote add origin git@github.com:<your-github-username>/grocery-planner.git
# or use HTTPS: git remote add origin https://github.com/<your-github-username>/grocery-planner.git
git push -u origin main
```

- [ ] **Step 3: Import into Vercel (manual)**

On [vercel.com/new](https://vercel.com/new):
- Import the `grocery-planner` GitHub repo
- Framework preset: Next.js (auto-detected)
- Under **Environment Variables**, add every variable from `.env.local` (all of `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `SHARED_PASSWORD`, `SESSION_SECRET`; leave `ANTHROPIC_API_KEY` and `CRON_SECRET` blank for now — added in later weeks)
- Click **Deploy**

Wait ~2 minutes for the first build.

- [ ] **Step 4: Verify the production deploy**

Open the Vercel-provided URL (e.g., `grocery-planner.vercel.app`).

Expected:
- Redirect to `/login`.
- Enter shared password → land on home page.
- Home page says "0 deals loaded yet" (production DB has no deals — we only did the refresh locally).

Trigger a production refresh from the browser console (while logged in on the Vercel URL):

```js
await fetch('/api/admin/refresh-ht', { method: 'POST' }).then((r) => r.json())
```

Refresh the page — deals should now appear.

- [ ] **Step 5: Commit and push the README**

```bash
git add README.md
git commit -m "Add project README"
git push
```

Vercel auto-redeploys on push. Verify the new deploy succeeds in the Vercel dashboard.

---

## Week 1 done. Verify:

- [ ] Local `npm run test` — all tests pass
- [ ] Production Vercel URL loads the login page
- [ ] Correct password lets you in; wrong password rejects
- [ ] Home page renders HT deals after a refresh
- [ ] Supabase Table Editor shows populated `stores`, `retailer_skus`, `deals`, `retailer_health`

If any of these fail, don't proceed to Week 2 — fix first.
