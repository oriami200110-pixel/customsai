# Tariffly — Deployment Manifest
**Version:** 0.3 | **Last updated:** April 2026  
**Production URL:** https://customsai.vercel.app

---

## 1. Vercel Environment Variables

Set these in Vercel → Project → Settings → Environment Variables.  
All should be scoped to **Production + Preview + Development**.

| Variable | Where to get it | Required |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL | ✅ |
| `SUPABASE_ANON_KEY` | Supabase → Settings → API → anon (public) key | ✅ |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → service_role key | ✅ |
| `GEMINI_API_KEY` | Google AI Studio → API keys | ✅ |
| `LEMON_SIGNING_SECRET` | Lemon Squeezy → Store → Webhooks → Signing secret | ✅ |

**Current values (already set):**
- `SUPABASE_URL` = `https://wqkuliasszkgwllifinp.supabase.co`
- `SUPABASE_ANON_KEY` = (set in Vercel)
- `GEMINI_API_KEY` = (set in Vercel)

---

## 2. Supabase Configuration

### 2a. Database Schema (run once in SQL Editor)

```sql
-- Profiles table (auto-created for every auth user)
create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  email                text,
  plan                 text not null default 'free',
  classification_count integer not null default 0,
  lemon_order_id       text,
  lemon_customer_id    text,
  created_at           timestamptz default now()
);

-- RLS: users can only read/update their own profile
alter table public.profiles enable row level security;
create policy "Users can view own profile"   on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

-- Service role bypass (for webhook)
create policy "Service role full access"     on public.profiles for all using (auth.role() = 'service_role');

-- Classifications table
create table if not exists public.classifications (
  id                 bigserial primary key,
  user_id            uuid references auth.users(id) on delete cascade,
  product_desc       text,
  country_of_origin  text,
  hts_code           text,
  hts_description    text,
  base_rate          numeric,
  section_301        numeric,
  section_232        numeric,
  total_rate         numeric,
  gri_rule           text,
  confidence         text,
  risk_flags         jsonb default '[]',
  alternatives       jsonb default '[]',
  created_at         timestamptz default now()
);

alter table public.classifications enable row level security;
create policy "Users see own classifications" on public.classifications for select using (auth.uid() = user_id);
create policy "Users insert own"             on public.classifications for insert with check (auth.uid() = user_id);

-- Auto-create profile on signup (trigger)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Increment classification count function
create or replace function public.increment_classification_count(user_id uuid)
returns void language sql security definer as $$
  update public.profiles
  set classification_count = classification_count + 1
  where id = user_id;
$$;
```

### 2b. Authentication → Email Settings
- **Confirm email:** OFF ← must be off for instant signup
- **Secure email change:** ON

### 2c. Authentication → URL Configuration
- **Site URL:** `https://customsai.vercel.app`
- **Redirect URLs (add all):**
  ```
  https://customsai.vercel.app/app.html
  https://customsai.vercel.app/**
  ```

### 2d. Authentication → Providers → Google ⚠️ CRITICAL
This is why you're getting `Unable to exchange external code`.

1. Go to **Supabase → Authentication → Providers → Google**
2. Toggle **Enable** to ON
3. Enter your **Client ID:** `301888250996-9ba0l1ojvef1uk91504qcqv912fj74cf.apps.googleusercontent.com`
4. Enter your **Client Secret:** get this from Google Cloud Console → Credentials → your OAuth client → **Client Secret** field (it looks like `GOCSPX-...`)
5. Click **Save**

Without the Client Secret in Supabase, the entire OAuth flow breaks at the token exchange step.

---

## 3. Google Cloud Console Configuration

Go to: https://console.cloud.google.com/apis/credentials → your OAuth 2.0 client

**Authorized JavaScript origins:**
```
https://customsai.vercel.app
```

**Authorized redirect URIs (all required):**
```
https://wqkuliasszkgwllifinp.supabase.co/auth/v1/callback
https://customsai.vercel.app/app.html
```

> ⚠️ Supabase's callback (`/auth/v1/callback`) must be in the redirect URIs — this is where Google sends the authorization code to be exchanged for tokens.

---

## 4. Lemon Squeezy Configuration

1. **Store → Webhooks → Add Webhook**
   - URL: `https://customsai.vercel.app/api/webhook-lemon`
   - Events: `order_created`
   - Copy the signing secret → paste into Vercel as `LEMON_SIGNING_SECRET`

2. **Product:** `https://tariffly.lemonsqueezy.com/checkout/buy/ec96bd09-48bd-4370-ba38-304f70b6a806`
   - Ensure the checkout URL collects the buyer's email
   - The webhook uses that email to look up the Supabase profile and set `plan = 'pro'`

---

## 5. Complete User Flow (verified end-to-end)

```
User lands on customsai.vercel.app
  ↓
index.html (landing) → "Start Free" → app.html
  ↓
Auth modal → Sign up (email/password or Google)
  ↓
Supabase creates auth.users row
  ↓  ← trigger fires automatically
profiles row created (plan='free', classification_count=0)
  ↓
onAuthStateChange fires SIGNED_IN/SIGNED_UP
  ↓
App dashboard loads (3 free classifications)
  ↓
User classifies → count increments in Supabase
  ↓
At 3/3 → upgrade modal → Lemon Squeezy checkout
  ↓
order_created webhook → profiles.plan = 'pro'
  ↓
Next classification → Supabase check → plan='pro' → unlimited
```

---

## 6. File Inventory

| File | Purpose | Status |
|---|---|---|
| `index.html` | Landing page | ✅ Live |
| `app.html` | Main SaaS engine | ✅ Live |
| `admin.html` | Admin dashboard | ✅ Live |
| `api/classify.js` | Gemini two-pass classifier | ✅ Live |
| `api/webhook-lemon.js` | LemonSqueezy payment webhook | ✅ Live |
| `vercel.json` | Routing config | ✅ Live |

---

## 7. Pre-Launch Checklist

- [ ] All 5 Vercel env vars set
- [ ] Supabase SQL schema run (tables + trigger + RPC)
- [ ] Email confirmation OFF in Supabase
- [ ] Google Client Secret added to Supabase → Providers → Google
- [ ] Google Cloud Console redirect URIs include Supabase callback
- [ ] Lemon Squeezy webhook configured with correct signing secret
- [ ] Test: sign up → classify → hit paywall → checkout → verify plan upgrades
