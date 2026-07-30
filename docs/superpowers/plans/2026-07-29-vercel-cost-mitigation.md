# Vercel Cost Mitigation — July 2026 Overage Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**

Eliminate the July 2026 Vercel Pro on-demand overages: ~$18/mo Build CPU Minutes (frequent pushes x 14 projects x performance build machines), ~$8/mo Observability Events (chatty logging), plus three latent runtime burners (OpenCRM minutely cron = 43,200 invocations/mo, SimCRM-v10 250ms client polling, floatfuel `no-store` API responses that defeat CDN caching), and cap the blast radius with Spend Management.

**Architecture**

Each fix lives in its own repo (OpenCRM, SimCRM-v10, floatfuel, DiscoverAIWithNico, DonorHunterPro are separate git repos under `C:\programming\nicos-apps\`), so commits and pre-push gates run per-repo. Build savings come from two account-wide levers (standard build machines + ignored-build-step for docs-only pushes); runtime savings come from moving cron scheduling into Supabase pg_cron, stretching client poll intervals with proportional batch sizes, and letting Vercel's CDN absorb repeat API hits via `s-maxage`/`stale-while-revalidate`. Spend Management is a dashboard-only safety net.

**Tech Stack**

Next.js 15/16 (OpenCRM, SimCRM-v10, DiscoverAIWithNico, DonorHunterPro), Vite + Vercel serverless functions (floatfuel), Supabase Postgres (pg_cron + pg_net), Vercel Pro (crons, CDN, build machines), pnpm (OpenCRM, DiscoverAIWithNico, DonorHunterPro) and npm (SimCRM-v10, floatfuel).

**Verified per-repo gate commands** (checked against each repo's real `package.json` scripts):

| Repo | Typecheck | Build |
|---|---|---|
| OpenCRM | `pnpm typecheck` | `pnpm build` |
| SimCRM-v10 | `npx tsc --noEmit` (no `typecheck` script exists) | `npm run build` |
| floatfuel | (none; build runs `tsc -b`) | `npm run build` |
| DiscoverAIWithNico | `pnpm typecheck` | `pnpm build` |
| DonorHunterPro | `pnpm typecheck` | `pnpm build` |

---

## Task 1: Standard build machines + ignored-build-step (all 14 projects) — biggest saver (~$18/mo)

Build machine size is a **project setting, not a vercel.json key** — it must be changed in the dashboard (or Vercel API); the ignored-build-step CAN be committed via `ignoreCommand` in each repo's `vercel.json`.

**Files:**
- Modify: `C:\programming\nicos-apps\OpenCRM\vercel.json` (whole file, 9 lines)
- Modify: `C:\programming\nicos-apps\floatfuel\vercel.json` (whole file, 10 lines)
- Modify: `C:\programming\nicos-apps\DiscoverAIWithNico\vercel.json` (whole file, 18 lines)
- Modify: `C:\programming\nicos-apps\DonorHunterPro\vercel.json` (whole file, 23 lines)
- Create: `C:\programming\nicos-apps\SimCRM-v10\vercel.json` (repo has none today)

### Steps

- [ ] **Manual dashboard checklist — build machine.** For each of the 14 Vercel projects: Vercel Dashboard → select project → Settings → Build and Deployment → Build Machine → select **Standard (4 vCPU → 2 vCPU / 8 GB → 4 GB)** → Save. Expected result: setting shows "Standard" for every project. (Repos with local checkouts: opencrm, simcrm-v10, floatfuel, discoveraiwithnico, donorhunterpro; repeat for the other 9 projects in the team list.) *_(pending: Nico dashboard action)_*

- [x] Add `ignoreCommand` to `C:\programming\nicos-apps\OpenCRM\vercel.json`. Old content (entire file):

  ```json
  {
    "crons": [
      {
        "path": "/api/worker/drain",
        "schedule": "* * * * *"
      }
    ]
  }
  ```

  New content (entire file — note this also stages Task 3's cron removal; if executing Task 1 before Task 3, keep the `crons` block and only add `ignoreCommand`, then Task 3 removes `crons`):

  ```json
  {
    "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ':(exclude)*.md' ':(exclude)docs' ':(exclude).wiki'",
    "crons": [
      {
        "path": "/api/worker/drain",
        "schedule": "* * * * *"
      }
    ]
  }
  ```

  How it works: `ignoreCommand` exiting **0** means "skip the build". `git diff --quiet` exits 0 when nothing outside markdown/docs/.wiki changed, so docs-only pushes skip the build entirely.

- [x] Add the same key to `C:\programming\nicos-apps\floatfuel\vercel.json`. Old content (entire file):

  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "framework": "vite",
    "buildCommand": "npm run build",
    "outputDirectory": "dist",
    "rewrites": [
      { "source": "/(.*)", "destination": "/index.html" }
    ]
  }
  ```

  New content (entire file):

  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "framework": "vite",
    "buildCommand": "npm run build",
    "outputDirectory": "dist",
    "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ':(exclude)*.md' ':(exclude)docs' ':(exclude).wiki'",
    "rewrites": [
      { "source": "/(.*)", "destination": "/index.html" }
    ]
  }
  ```

- [x] Add the key to `C:\programming\nicos-apps\DiscoverAIWithNico\vercel.json` (insert as the second property; the `crons` array is edited later in Task 6). Old first lines:

  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "crons": [
  ```

  New first lines:

  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ':(exclude)*.md' ':(exclude)docs' ':(exclude).wiki'",
    "crons": [
  ```

- [x] Add the key to `C:\programming\nicos-apps\DonorHunterPro\vercel.json` the same way. Old first lines:

  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "crons": [
  ```

  New first lines:

  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ':(exclude)*.md' ':(exclude)docs' ':(exclude).wiki'",
    "crons": [
  ```

- [x] Create `C:\programming\nicos-apps\SimCRM-v10\vercel.json` (new file — repo has none):

  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ':(exclude)*.md' ':(exclude)docs' ':(exclude).wiki'"
  }
  ```

- [x] Verify each JSON parses. From each repo root:

  ```bash
  node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('vercel.json OK')"
  ```

  Expected output: `vercel.json OK`

- [x] Commit per repo (these are config/JSON-only edits, but each repo still gets its build gate before push — run the gate from the table above first; e.g. in OpenCRM: `pnpm typecheck && pnpm build`). Then in each repo:

  ```bash
  # OpenCRM
  git add vercel.json
  git commit -m "chore: skip Vercel builds for docs-only pushes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push
  ```

  Repeat identically in floatfuel, DiscoverAIWithNico, DonorHunterPro, and SimCRM-v10 (SimCRM commit message: `chore: add vercel.json with docs-only build skip`), each ending with the same `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

- [ ] Verify on Vercel: push a markdown-only commit to one repo and confirm the deployment list shows the build was **Canceled/Skipped** ("The Deployment has been canceled as a result of running the command defined in the Ignored Build Step setting"). *_(will be proven by the next docs-only push)_*

---

## Task 2: Quiet logs — remove per-request console.log in API routes (~$8/mo Observability Events)

Grep audit results (2026-07-29):

- **OpenCRM** `app/api/**`: no `console.log/info/debug` — nothing to do.
- **floatfuel** `api/**`: no matches — nothing to do.
- **DonorHunterPro** `app/**`: no matches — nothing to do.
- **SimCRM-v10**: one hit at `app\api\test\e2e\route.ts:21` — `console.log(\`[E2E TEST] ${msg}\`);` — test-only route, leave as-is (it only fires when the E2E route is explicitly invoked, not per user request).
- **DiscoverAIWithNico**: 4 hits, all in request paths — fix these.

**Files:**
- Modify: `C:\programming\nicos-apps\DiscoverAIWithNico\src\app\api\discovery\route.ts` (line 129)
- Modify: `C:\programming\nicos-apps\DiscoverAIWithNico\src\app\api\assessment\route.ts` (lines 195, 215, 472)

### Steps

- [x] In `src\app\api\discovery\route.ts` line 129, old:

  ```ts
      console.log("[api/discovery] received (no supabase configured):", email);
  ```

  New (misconfiguration is warn-worthy and rare, keep as warn; it only fires when Supabase env is missing):

  ```ts
      console.warn("[api/discovery] received (no supabase configured):", email);
  ```

- [x] In `src\app\api\assessment\route.ts` lines 195 and 215 — these fire per assessment request on unmatched roles (high-frequency). Old (line 195):

  ```ts
      console.log(`[api/assessment] no match: ${role}`);
  ```

  New: delete the line entirely (the surrounding code already returns the no-match result to the caller; the log adds an Observability Event per request with no action value).

  Old (line 215, now shifted up one after the previous deletion):

  ```ts
        console.log(`[api/assessment] no match: ${role} (no hours and no band)`);
  ```

  New: delete the line entirely.

- [x] In `src\app\api\assessment\route.ts` line 472 (now ~470), old:

  ```ts
      console.log("[api/assessment] received (no supabase configured)");
  ```

  New:

  ```ts
      console.warn("[api/assessment] received (no supabase configured)");
  ```

- [x] Verify no per-request info logs remain:

  ```bash
  cd C:/programming/nicos-apps/DiscoverAIWithNico
  grep -rn "console.log" src/app/api
  ```

  Expected output: no lines (exit code 1).

- [x] Gate and commit (DiscoverAIWithNico repo):

  ```bash
  pnpm typecheck
  pnpm build
  git add src/app/api/discovery/route.ts src/app/api/assessment/route.ts
  git commit -m "chore: drop per-request console.log in API routes to cut observability events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push
  ```

  Expected: typecheck exits 0, build ends with `✓ Compiled successfully` / route table.

---

## Task 3: OpenCRM — move minutely drain cron to Supabase pg_cron (kills 43,200 Vercel cron invocations/mo)

The drain route (`app/api/worker/drain/route.ts`) authenticates a `Bearer` token that must equal either `WORKER_SECRET` or `CRON_SECRET` (verified: `isAuthorized()`, lines 18-28; GET delegates to POST, lines 43-46). Its own doc comment already blesses pg_cron as the scheduler. pg_net's `http_post` mirrors the documented curl exactly.

**Files:**
- Modify: `C:\programming\nicos-apps\OpenCRM\vercel.json` (remove `crons` block, lines 2-7 of the Task-1 version)
- Create: `C:\programming\nicos-apps\OpenCRM\supabase\migrations\20260729T000000_schedule_worker_drain.sql`

### Steps

- [x] Create the migration `supabase\migrations\20260729T000000_schedule_worker_drain.sql` (replace `https://<OPENCRM_PROD_URL>` with the project's live production URL from Vercel → opencrm project → Domains before running):

  ```sql
  -- Schedules the jobs-worker drain from inside Supabase (pg_cron + pg_net),
  -- replacing the Vercel cron that cost 43,200 function-trigger events/month.
  -- Mirrors the route's documented self-host contract (route.ts lines 13-14):
  --   * * * * * curl -fsS -X POST -H "Authorization: Bearer $WORKER_SECRET" https://host/api/worker/drain
  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  -- Store the secret once in Postgres settings so it is not inlined in cron.job.command.
  -- Run this line manually with the real value of WORKER_SECRET (same value as the
  -- Vercel env var of that name) before applying the schedule:
  --   alter database postgres set app.worker_secret = '<WORKER_SECRET value>';

  select cron.unschedule(jobid) from cron.job where jobname = 'opencrm-worker-drain';

  select cron.schedule(
    'opencrm-worker-drain',
    '* * * * *',
    $$
    select net.http_post(
      url     := 'https://<OPENCRM_PROD_URL>/api/worker/drain',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.worker_secret'),
        'Content-Type', 'application/json'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
    $$
  );
  ```

- [x] Apply it: Supabase Dashboard → the OpenCRM project → SQL Editor → first run `alter database postgres set app.worker_secret = '<WORKER_SECRET value>';` (copy the value from Vercel → opencrm → Settings → Environment Variables → `WORKER_SECRET`), then paste and run the migration file contents. Expected output: `CREATE EXTENSION` (x2, or no-op notices) and a `schedule` row id.

- [x] Verify the job fires:

  ```sql
  select jobname, schedule, active from cron.job where jobname = 'opencrm-worker-drain';
  -- expect: opencrm-worker-drain | * * * * * | t
  select status, (response).status_code
  from net._http_response order by created desc limit 3;
  -- expect within 2 minutes: rows with status_code 200
  ```

  Also confirm in Vercel → opencrm → Logs that `/api/worker/drain` shows fresh 200s with no `unauthorized` responses.

- [x] Only after the 200s are confirmed, remove the Vercel cron. `vercel.json` old content (post-Task 1):

  ```json
  {
    "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ':(exclude)*.md' ':(exclude)docs' ':(exclude).wiki'",
    "crons": [
      {
        "path": "/api/worker/drain",
        "schedule": "* * * * *"
      }
    ]
  }
  ```

  New content (entire file):

  ```json
  {
    "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ':(exclude)*.md' ':(exclude)docs' ':(exclude).wiki'"
  }
  ```

  (Ordering safety per house rule "optional hardening never blocks boot": the drain route is concurrency-safe via `claim_jobs FOR UPDATE SKIP LOCKED`, so pg_cron and Vercel cron overlapping during the transition is harmless.)

- [x] Gate and commit (OpenCRM repo):

  ```bash
  pnpm typecheck
  pnpm build
  git add vercel.json supabase/migrations/20260729T000000_schedule_worker_drain.sql
  git commit -m "feat: schedule worker drain via Supabase pg_cron, drop Vercel cron

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push
  ```

- [ ] Post-deploy verify on the LIVE OpenCRM URL: create a job through the app (any action that enqueues), wait up to 90 seconds, confirm it completes — proof that pg_cron is now the only scheduler and jobs still drain. *_(pg_cron verified via 200s + job_run_details succeeded; in-app job creation not exercised)_*

---

## Task 4: SimCRM-v10 — stretch the run ticker 250ms → 2000ms with proportional batch (8x fewer function invocations, same sim speed)

`lib/store.tsx` lines 203-217 tick every 250ms with `'step', 15` (= 60 steps/sec). New: every 2000ms with `'step', 120` (= 60 steps/sec — identical on screen). The server accepts this: `lib/schemas.ts:40` caps `batchSize` at `z.number().int().min(1).max(200)`, so 120 is valid.

**Audit discrepancy — middleware left alone:** the audit suggested narrowing `middleware.ts` to exclude `/api`, but the matcher IS the API auth gate — `middleware.ts` lines 8-10 return 401 for any unauthenticated `/api/*` request. Excluding `/api` from the matcher would remove authentication from every API route. The static-asset exclusions the audit wanted are already present in the matcher (line 24 excludes `_next/static`, `_next/image`, favicon, and image extensions). The interval stretch alone delivers the invocation reduction; middleware stays as-is.

**Files:**
- Modify: `C:\programming\nicos-apps\SimCRM-v10\lib\store.tsx` (lines 207 and 217)

### Steps

- [x] In `lib\store.tsx`, old (lines 203-217):

  ```ts
      const timer = setInterval(async () => {
        if (isExecutingRef.current) return;
        isExecutingRef.current = true;
        try {
          const data = await apiClient.runAction(activeRun.id, 'step', 15);
          applyRunActionData(data);
          if (data.run && data.run.status !== 'running') {
            await refreshState();
          }
        } catch (err: any) {
          console.error('Error executing run step on server', err);
        } finally {
          isExecutingRef.current = false;
        }
      }, 250);
  ```

  New:

  ```ts
      const timer = setInterval(async () => {
        if (isExecutingRef.current) return;
        isExecutingRef.current = true;
        try {
          // 2000ms x 120 steps = same 60 steps/sec as the old 250ms x 15,
          // at 1/8th the request (and Vercel invocation) rate.
          const data = await apiClient.runAction(activeRun.id, 'step', 120);
          applyRunActionData(data);
          if (data.run && data.run.status !== 'running') {
            await refreshState();
          }
        } catch (err: any) {
          console.error('Error executing run step on server', err);
        } finally {
          isExecutingRef.current = false;
        }
      }, 2000);
  ```

- [x] Gate and commit (SimCRM-v10 repo; note there is no `typecheck` script — use tsc directly):

  ```bash
  cd C:/programming/nicos-apps/SimCRM-v10
  npx tsc --noEmit
  npm run build
  git add lib/store.tsx
  git commit -m "perf: tick run execution every 2s with 120-step batches (8x fewer API calls, same sim speed)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push
  ```

  Expected: tsc silent exit 0; `next build` route table prints.

- [ ] **Behavioral verification on the LIVE deployed SimCRM URL (never localhost).** Open the production URL, sign in, start (or resume) a simulation run. Observe: (1) the run's progress counters advance at the same apparent rate as before — roughly 60 sim steps per second, now arriving in visible chunks every ~2 seconds instead of a near-continuous trickle; (2) in browser DevTools → Network, `runs/<id>/action` POSTs fire every ~2s, not 4x/second; (3) pausing and resuming the run still works instantly. If progress appears to stall for more than ~3 seconds while status is "running", the change regressed — investigate before closing. *_(blocked by auth wall; needs a signed-in manual pass)_*

---

## Task 5: floatfuel — replace `no-store` with CDN caching on the four API functions

All four handlers set `Cache-Control: no-store`, so every client's 15s/60s/300s poll (intervals verified in `src\lib\engine\live.ts` lines 26-30) invokes a function. With `s-maxage` + `stale-while-revalidate`, Vercel's CDN serves repeat hits within the window — for N concurrent users the function runs ~once per window instead of N times.

**Files:**
- Modify: `C:\programming\nicos-apps\floatfuel\api\market.ts` (line 190)
- Modify: `C:\programming\nicos-apps\floatfuel\api\halts.ts` (line 129)
- Modify: `C:\programming\nicos-apps\floatfuel\api\news.ts` (line 136)
- Modify: `C:\programming\nicos-apps\floatfuel\api\edgar.ts` (line 132)

### Steps

- [x] `api\market.ts` line 190 (client polls every 15s), old:

  ```ts
    res.setHeader('Cache-Control', 'no-store')
  ```

  New:

  ```ts
    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30')
  ```

- [x] `api\halts.ts` line 129 (client polls every 60s), old:

  ```ts
    res.setHeader('Cache-Control', 'no-store')
  ```

  New:

  ```ts
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
  ```

- [x] `api\news.ts` line 136 (client polls every 300s), old:

  ```ts
    res.setHeader('Cache-Control', 'no-store')
  ```

  New:

  ```ts
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  ```

- [x] `api\edgar.ts` line 132 (client refreshes every 6h; audit prescribes the news window), old:

  ```ts
    res.setHeader('Cache-Control', 'no-store')
  ```

  New:

  ```ts
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  ```

- [x] Gate and commit (floatfuel repo; build script already includes `tsc -b`):

  ```bash
  cd C:/programming/nicos-apps/floatfuel
  npm run build
  git add api/market.ts api/halts.ts api/news.ts api/edgar.ts
  git commit -m "perf: serve market/halts/news/edgar from CDN with s-maxage + SWR instead of no-store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push
  ```

  Expected: `tsc -b` silent, `vite build` prints `✓ built in …`.

- [x] Verify against the LIVE floatfuel URL after deploy:

  ```bash
  curl -sI "https://<FLOATFUEL_PROD_URL>/api/market?symbols=AAPL" | grep -iE "cache-control|x-vercel-cache"
  ```

  Expected first hit: `cache-control: public, s-maxage=15, stale-while-revalidate=30` and `x-vercel-cache: MISS`. Re-run within 15 seconds: `x-vercel-cache: HIT`. Repeat for `/api/halts`, `/api/news?symbols=AAPL&token=<token>`, `/api/edgar?symbols=AAPL` with their respective windows. Then load the live app and confirm quotes still visibly refresh every ~15s (staleness within one poll window is the accepted trade).

---

## Task 6: DiscoverAIWithNico — library-assets cron hourly → every 6h; chat maxDuration 300 → 120

The library-assets cron is a webhook-drop safety net by its own doc comment (route.ts lines 9-27) — recovery, not throughput — so 6-hourly is aligned with its design. Its own `maxDuration = 300` and `WORK_BUDGET_MS = 270_000` stay (a recovery pass that does find work needs the budget). Chat drops 300 → 120. **Risk note:** `src/app/api/chat/route.ts` lines 11-13 say the post-stream discovery engine runs via `after()` and "needs function lifetime beyond the stream itself"; 120s still covers stream + post-work for normal chats, but if artifact generation starts getting truncated (symptom: chats stop producing follow-up artifacts), revert this one line.

**Files:**
- Modify: `C:\programming\nicos-apps\DiscoverAIWithNico\vercel.json` (line 6 of the pre-Task-1 file: library-assets schedule)
- Modify: `C:\programming\nicos-apps\DiscoverAIWithNico\src\app\api\chat\route.ts` (lines 11-13)

### Steps

- [x] In `vercel.json`, old cron entry:

  ```json
      {
        "path": "/api/cron/library-assets",
        "schedule": "0 * * * *"
      },
  ```

  New:

  ```json
      {
        "path": "/api/cron/library-assets",
        "schedule": "0 */6 * * *"
      },
  ```

  (Leave `/api/cron/newsletter` `17 12 * * 1` and `/api/cron/retention` `0 4 * * *` untouched — already infrequent.)

- [x] In `src\app\api\chat\route.ts`, old (lines 11-13):

  ```ts
  // Post-stream discovery engine (analysis + artifact generation via after()) needs
  // function lifetime beyond the stream itself; Vercel Pro allows up to 300s.
  export const maxDuration = 300;
  ```

  New:

  ```ts
  // Post-stream discovery engine (analysis + artifact generation via after()) needs
  // function lifetime beyond the stream itself. 120s covers stream + after() work
  // at 2.5x less billed GB-hours ceiling than the old 300s (cost audit 2026-07-29).
  export const maxDuration = 120;
  ```

- [x] Gate and commit (DiscoverAIWithNico repo):

  ```bash
  pnpm typecheck
  pnpm build
  git add vercel.json src/app/api/chat/route.ts
  git commit -m "perf: run library-assets reconciler 6-hourly and cap chat at 120s

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push
  ```

- [x] Verify on the LIVE DiscoverAIWithNico URL: (1) Vercel Dashboard → project → Settings → Cron Jobs shows `library-assets` at `0 */6 * * *`; (2) send a chat message on the live site and confirm the full streamed reply arrives and, where applicable, the follow-up artifact still appears (exercises the `after()` window under the new 120s cap).

---

## Task 7: DonorHunterPro — heartbeat cron every 15 min → hourly

**Files:**
- Modify: `C:\programming\nicos-apps\DonorHunterPro\vercel.json` (line 4 of the pre-Task-1 file)

### Steps

- [x] Old:

  ```json
      { "path": "/api/cron/heartbeat", "schedule": "*/15 * * * *" },
  ```

  New:

  ```json
      { "path": "/api/cron/heartbeat", "schedule": "0 * * * *" },
  ```

  Note: `/api/cron/report-delivery` also runs hourly at `20 * * * *`; staggering heartbeat to minute 0 keeps them from stacking. All other crons in this file are daily/annual — leave untouched.

- [x] Gate and commit (DonorHunterPro repo):

  ```bash
  pnpm typecheck
  pnpm build
  git add vercel.json
  git commit -m "perf: run heartbeat cron hourly instead of every 15 minutes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push
  ```

- [x] Verify: Vercel Dashboard → donorhunterpro → Settings → Cron Jobs shows heartbeat at `0 * * * *` after the next deploy, and Logs show the route firing once per hour (2,880 → 720 invocations/mo).

---

## Task 8: Account level — enable Spend Management (manual dashboard checklist)

No code. Exact click path:

- [ ] Vercel Dashboard → switch to the team (top-left team picker) → **Team Settings** → **Billing** → scroll to **Spend Management** → toggle **On**. *_(pending: Nico dashboard action)_*
- [ ] Set **notification threshold: $10** (email/webhook notice when on-demand spend passes $10).
- [ ] Set **pause threshold: $40** with action **"Pause all projects"** (hard stop before a runaway bill).
- [ ] Save. Expected result: Spend Management panel shows "Enabled — notify at $10.00, pause at $40.00".
- [ ] Sanity check a week later: Billing → Usage shows Build Minutes and Observability Events trending well below July's levels; no pause events triggered.

---

## Self-review checklist (run after all tasks)

- [x] Every audit finding has a task: build machines + ignored-build-step (T1), chatty logs (T2), OpenCRM cron (T3), SimCRM polling (T4), floatfuel caching (T5), DiscoverAI cron + maxDuration (T6), DonorHunterPro heartbeat (T7), spend cap (T8).
- [x] No placeholders remain except the two deploy-time substitutions that cannot be committed: `<OPENCRM_PROD_URL>` / `<WORKER_SECRET value>` (Task 3 — secret must never be committed) and `<FLOATFUEL_PROD_URL>` (Task 5 curl check) — both are filled at execution time from the Vercel dashboard, per instructions in the steps.
- [x] Each repo committed and pushed separately with its own gates; every commit message carries the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

## Execution log (2026-07-29)

**Commits per repo:**

- **OpenCRM:** `3145e9d`, `568671e`, `7f0ee45` (+ docs commit pending separately)
- **SimCRM-v10:** `6fb32c7`, `63a066c`, `ae35346`
- **floatfuel:** `2eb61d2`, `af1c05b`, `f7d7741`
- **DiscoverAIWithNico:** `f4ad727`, `de44138`, `777ad6f`, `38de12e`, `062bcba`
- **DonorHunterPro:** `981667c`, `47c1349`, `620489e`

**Deviations from plan:**

1. **Task 3:** the secret is stored in Supabase Vault instead of a database GUC — `alter database ... set` was denied (42501); the cron command reads it from Vault inside a fail-loud DO block.
2. **Tasks 4/6, tuned by review:** SimCRM ticks 1000ms/60 steps (not 2000ms/120) with `maxDuration = 60` on the action route; DiscoverAI chat `maxDuration = 180` (not 120).

**Additional fix (Task 5):** cacheable headers are set only on 200 responses; 400/405 error paths return `no-store` so errors are never CDN-cached.
