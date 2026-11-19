# Athena — Codebase Review & Suggested Remediation

**Reviewed:** 2026-11-19
**Baseline Commit:** `5257b31` (`main`)
**Verified Local Gates:**
- `pnpm typecheck` — PASS (0 errors; `strict: true`, `noUncheckedIndexedAccess: true`)
- `pnpm lint` — PASS (0 errors/warnings; zero `any` or lint/TS suppressions in `src/`)
- `pnpm build` — PASS (`tsup`, 174ms)
- `pnpm test` — PASS (145/145 test files, 1,460/1,460 tests in 141.2s)

---

## 1. High Priority — Security

### 1.1 SSRF Bypass via IPv6-Mapped IPv4 Canonicalization
- **Location:** `src/tools/webfetch.ts` (lines 22–47), also imported by `src/harness/mcp.ts` (line 10) for HTTP MCP servers.
- **Root Cause:**
  - Node's WHATWG `URL` parser canonicalizes IPv4-mapped IPv6 addresses to hex notation: `new URL('http://[::ffff:127.0.0.1]/').hostname` becomes `[::ffff:7f00:1]`.
  - `isPrivateAddress()` only checks `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` for mapped addresses and exact string equality (`lower === '::' || lower === '::1'`) for loopback/unspecified.
  - As a result, `::ffff:7f00:1` (`127.0.0.1`), `::ffff:a9fe:a9fe` (`169.254.169.254` cloud metadata), and expanded forms such as `0:0:0:0:0:0:0:1` return `false` and pass `assertPublicUrl()`.
- **Suggested Remediation:**
  1. Add a pure IPv6-to-8-hextet parser in `src/tools/webfetch.ts` that expands `::` compression and converts an embedded dotted-quad IPv4 tail (if present) into the final two 16-bit hextets.
  2. Evaluate private/reserved ranges directly on the normalized 8-hextet array:
     - Unspecified (`0:0:0:0:0:0:0:0`) and loopback (`0:0:0:0:0:0:0:1`)
     - IPv4-mapped (`0:0:0:0:0:ffff:xxxx:xxxx`) and IPv4-translated/SIIT (`0:0:0:0:ffff:0:xxxx:xxxx`): reconstruct the 4 IPv4 octets from the last two hextets and delegate to the IPv4 branch of `isPrivateAddress()`.
     - Unique Local Addresses (`fc00::/7`, i.e. `(h0 & 0xfe00) === 0xfc00`)
     - Link-local (`fe80::/10`, i.e. `(h0 & 0xffc0) === 0xfe80`)
     - Multicast (`ff00::/8`, i.e. `(h0 & 0xff00) === 0xff00`)
     - Fail closed (`return true`) on any unparseable address.
- **Verification (TDD):**
  - Add failing unit tests in `tests/tools/webfetch.test.ts` covering `http://[::ffff:127.0.0.1]/`, `http://[::ffff:7f00:1]/`, `http://[::ffff:169.254.169.254]/`, `http://[::ffff:a9fe:a9fe]/`, `http://[0:0:0:0:0:0:0:1]/`, and `http://[::ffff:10.0.0.1]/` against both `isPrivateAddress()` and `assertPublicUrl()`.
  - Verify `tests/harness/mcp.test.ts` (HTTP MCP SSRF tests) remains green.

---

## 2. Medium Priority — Behavior, Validation & Maintainability

### 2.1 Project Librarian Context Suppresses Reflection Journal Retrieval
- **Location:** `src/harness/controller.ts` (line 490)
- **Root Cause:**
  ```ts
  historicalContext: (prompt): string =>
    library?.selected ? library.context() : reflectionJournal.retrieve(prompt),
  ```
  Once `LibraryRead` selects notes during a turn, `reflectionJournal.retrieve(prompt)` is skipped for the remainder of that turn.
- **Suggested Remediation:**
  - Decide explicitly between two contracts and document the choice in `.wiki/architecture/librarian-library.md`:
    - **Option A (Compose both bounded contexts):** Concatenate non-empty outputs from `library.context()` and `reflectionJournal.retrieve(prompt)` (both already carry explicit untrusted-data XML wrappers and independent character budgets).
    - **Option B (Keep mutual exclusion):** If suppressing journal retrieval while library notes are active is intentional to protect context budget, add an inline comment explaining the precedence rule and a unit test locking that behavior.
- **Verification (TDD):**
  - Add a controller test in `tests/library/integration.test.ts` or `tests/harness/controller-composition.test.ts` asserting the chosen behavior when both `library.selected` and journal retrieval produce context.

### 2.2 Unchecked Non-Null Assertions & Unwired CLI in `src/library/cli.ts`
- **Location:** `src/library/cli.ts` (lines 7–41)
- **Root Cause:**
  - `InputSchema` marks every property `.optional()`, then `libraryCommand()` uses non-null assertions (`input.id!`, `input.commit!`, `input.path!`, `input.detailPath!`, `input.summaryPath!`, `input.categories!`, `input.expectedRevision!`) per operation. Omitted fields fail downstream with opaque errors instead of failing cleanly at schema validation.
  - The top-level `catch` block (lines 38–40) discards the underlying error message, making operator diagnosis unnecessarily difficult.
  - `library` is not wired into `src/cli.ts` (`athena library ...`), unlike `athena journal ...`.
- **Suggested Remediation:**
  1. Replace the single loose `InputSchema` with per-operation Zod schemas (or a discriminated union keyed by `operation`) so every required field is validated before `LibraryRuntime` is invoked, removing all `!` assertions.
  2. In the standalone entrypoint `catch` block, preserve safe diagnostic context (e.g., validation/operation failure reason) without leaking sensitive text.
  3. Decide whether to wire `athena library <op>` into `src/cli.ts` (delegating to `src/library/cli.ts`, matching `src/journal/cli.ts`) or keep it intentionally unexposed until promotion/activation is approved (if intentionally unexposed, document that explicitly in `src/library/README.md`).
- **Verification (TDD):**
  - Add tests in `tests/library/library.test.ts` passing empty `{}` payloads to `submit`, `review`, `promote`, `reverify`, `release`, `reject`, and `rollback` and asserting clean `ZodError` / validation failures.

### 2.3 Decompose Monolithic Entrypoints & Remove `gitBranch` Duplication
- **Locations:**
  - `src/cli.ts` (2,309 lines; `main()` is ~1,165 lines handling 16 commands)
  - `gitBranch(cwd)` duplicated in `src/cli.ts` (lines 633–645) and `src/harness/controller.ts` (lines 59–69)
  - Secondary growth hotspots: `src/voice/daemon.ts` (1,229 lines), `src/tui/App.tsx` (1,060 lines), `src/engine/loop.ts` (929 lines)
- **Suggested Remediation:**
  1. Extract `gitBranch(cwd)` into a shared utility (e.g., `src/harness/git.ts` or export from `src/harness/staleness.ts`) and import it in both `src/cli.ts` and `src/harness/controller.ts`.
  2. Extract stateless CLI subcommand dispatch blocks out of `src/cli.ts` into `src/cli/` modules following the existing `src/journal/cli.ts` pattern:
     - `src/cli/args.ts` (`parseArgs`, `parseExecArgs`, `parseVoiceArgs`, `CliCommand`, `HELP_TEXT`)
     - `src/cli/slash.ts` (`makeSlashHandler`, `screenReaderCommandRoute`, `handleScreenReaderInterrupt`)
     - `src/cli/commands/` (`learn.ts`, `plugin.ts`, `session.ts`, `vmp.ts`, `trust.ts`, `voice.ts`, `exec.ts`)
     - Keep `src/cli.ts` as a thin composition root + re-export barrel so existing test imports do not break.
  3. Avoid touching `src/tui/App.tsx` layout math without re-running `tests/tui/fullscreen-popup-overflow.test.tsx` (per `AGENTS.md` §1).
- **Verification:**
  - Keep existing `tests/cli/` exports and behavior identical; run full `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### 2.4 Integration Test Suite Bottleneck (`tests/library/integration.test.ts`)
- **Location:** `tests/library/integration.test.ts`
- **Root Cause:**
  - In a full `pnpm test` run (141.2s total across 145 files), `tests/library/integration.test.ts` alone consumed **133.9s** (~95% of total wall-clock time) across 21 sequential tests that initialize fresh git repos and spawn Node/git subprocesses.
  - Because CI runs all 4 gates across a 6-job matrix (Ubuntu/Windows/macOS × Node 20/22), this single file dominates feedback latency.
- **Suggested Remediation:**
  1. Split `tests/library/integration.test.ts` into 2–3 cohesive test files (e.g., `library-git-verifier.test.ts`, `library-cli.test.ts`, `library-controller.test.ts`) so Vitest executes them in parallel across worker threads.
  2. Where multiple tests share an identical base git repo fixture, build one template repo in `beforeAll` and copy/clone locally per test instead of running full `git init` + multi-commit setup + `npm`/`node` child-process startup 21 times from scratch (while keeping all real git/subprocess assertions intact per `AGENTS.md` §4).
- **Verification:**
  - Confirm identical test count and coverage while measuring wall-clock reduction with `pnpm test`.

---

## 3. Low Priority — Hygiene & Documentation Drift

### 3.1 Duplicate Entry in `MUTATING_COMMANDS`
- **Location:** `src/harness/protected-paths.ts` (lines 58–59)
- **Root Cause:** `'new-itemproperty'` appears twice in the `MUTATING_COMMANDS` `Set`.
- **Suggested Remediation:** Remove the duplicate literal on line 59.

### 3.2 Wiki & Architecture Documentation Drift
- **Locations:**
  - `.wiki/INDEX.md` (line 16)
  - `ARCHITECTURE.md` (lines 46–93)
- **Root Cause:**
  - `.wiki/INDEX.md` still states that `HarnessSessionController` has *"exactly one caller (the voice branch) while the interactive TUI composes its own engine, bus, gate, and trace inline in `main()`"*. In reality, `src/cli.ts` now uses `HarnessSessionController.create()` for both voice (line 1602) and the unified TUI/screen-reader/exec path (line 1984).
  - `ARCHITECTURE.md` "Major source areas" lists 13 `src/` subsystems but omits `src/library/` (introduced in `5257b31`).
- **Suggested Remediation:**
  - Update `.wiki/INDEX.md` (line 16) and `.wiki/features/voice-project-switching/00-overview.md` (if it repeats the outdated claim) to reflect that `HarnessSessionController` is now unified across all surfaces.
  - Add a `src/library/` bullet to `ARCHITECTURE.md` linking to `.wiki/architecture/librarian-library.md`.

### 3.3 Dirty Working Tree on `main`
- **Locations:** `AGENTS.md` (modified), `.wiki/INDEX.md` (modified), `.wiki/features/jev-integration/` (untracked)
- **Root Cause:** Uncommitted local changes remain on `main` (per `AGENTS.md` §7 two-machine workflow, uncommitted work is invisible to the other machine and risks conflict).
- **Suggested Remediation:** Review, stage intended paths explicitly (never `git add -A` / `git add .`), run the full 4-gate Coding SOP, and commit on a clean topic branch or `main` per workflow rules before switching machines.

---

## 4. Recommended Execution Order

1. **Immediate (Security + Quick Fixes — 1 small PR):**
   - Fix IPv6-mapped IPv4 SSRF bypass in `src/tools/webfetch.ts` with regression tests (1.1).
   - Remove duplicate `'new-itemproperty'` in `src/harness/protected-paths.ts` (3.1).
   - Fix `.wiki/INDEX.md` and `ARCHITECTURE.md` drift (3.2).
2. **Next (Library Hardening + Test Speed — 1 PR):**
   - Clarify/test `library.context()` vs `reflectionJournal.retrieve()` precedence (2.1).
   - Replace `!` assertions with per-operation Zod validation in `src/library/cli.ts` (2.2).
   - Shard `tests/library/integration.test.ts` for parallel Vitest execution (2.4).
3. **Planned Refactor (Maintainability — 1 PR):**
   - Deduplicate `gitBranch()` and extract `src/cli.ts` subcommand modules into `src/cli/` (2.3).
