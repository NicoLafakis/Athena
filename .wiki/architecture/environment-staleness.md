# Environment staleness detection

Athena is worked from more than one machine, by more than one agent harness. The
recurring failure this guards against is silent: source is pulled but `dist/` is never
rebuilt, or `package.json` changes land without a reinstall, and the next run exercises
yesterday's binary against today's source. A correct fix then reads as "didn't work".
`src/harness/staleness.ts` exists purely to make that drift observed instead of
remembered.

## Four signals

`collectStaleness(options)` returns a `StalenessSignal[]`, one per requested check. Each
signal has a name, a `StalenessState` (`fresh | stale | not-applicable | unknown`), a
human-readable `detail`, and an optional `bootWarning` one-liner.

- **`stale-build`** - compares `dist/cli.js`'s mtime against the newest file under `src/`
  (walked directly, skipping dot-entries, `node_modules`, and a basename-level subset of
  `.gitignore`, capped at 20,000 entries). Stale means the binary predates the source
  that would produce it.
- **`stale-deps`** - compares `node_modules` against `pnpm-lock.yaml`, preferring
  `node_modules/.modules.yaml` (rewritten on every `pnpm install`) over the directory's
  own mtime. A 60 second tolerance (`DEPS_TOLERANCE_MS`) absorbs the fact that pnpm
  writes the lockfile a fraction of a millisecond after `.modules.yaml` within the same
  install, which a strict comparison flagged as stale immediately after a clean install.
  Real drift, a pull or an edited dependency, is minutes to days wide, so the tolerance
  removes exactly that false positive and nothing else. Tightening it back toward zero
  would reintroduce a warning that fires after every install and trains the user to
  ignore staleness warnings generally.
- **`branch-behind`** - local `HEAD` versus its upstream, using `git rev-list --count`
  against already-fetched refs. No `git fetch` is ever performed (network I/O on every
  boot is not acceptable), and the message says so explicitly: "as of the last fetch".
  Doctor-only.
- **`uncommitted-work`** - `git status --porcelain`, reported as a file count rather than
  a file list. On a two-machine workflow the useful signal is "there is work here"; a
  file list in a diagnostic report is noise. Doctor-only.

`stale` is the only actionable state. `not-applicable` means the environment genuinely
lacks the thing being compared, a fresh clone, no upstream, a published-package layout,
and is a normal state, never a problem. `unknown` means a probe failed or timed out.

## Boot versus doctor split

`BOOT_STALENESS_CHECKS = ['stale-build', 'stale-deps']` is the only set that runs at
startup. Both are filesystem-only comparisons, so boot spawns zero subprocesses; measured
boot cost is 0.88 ms. `branch-behind` and `uncommitted-work` need `git`, and the three git
spawns account for essentially all of the roughly 200 ms full doctor set costs, which is
why they are gated to `athena doctor` rather than every boot: boot noise erodes attention
for the warnings that matter.

Wiring:

- `src/cli.ts` calls `stalenessBootWarnings()` on stderr, once, after the TTY guard and
  before Ink mounts (alt-screen entry happens later inside a `useEffect`, so pre-render
  stderr is genuinely visible to the user).
- `src/harness/diagnostics.ts` calls `collectStaleness(options.staleness)` and maps each
  signal into a `DiagnosticCheck`: `stale` becomes `warning`, every other state becomes
  `ok`. The `staleness?: StalenessOptions` field on `collectDiagnostics`'s options is a
  test injection seam, mirroring the existing `vault?: CredentialVault` seam on the same
  function.

## Cannot block boot

This module applies the same standing rule documented on
[credential storage and the OS vault](credential-storage.md#the-standing-rule-optional-hardening-must-never-be-a-fatal-boot-precondition):
optional hardening must never be a fatal boot precondition. Concretely:

- Every individual check is wrapped in its own try/catch inside `collectStaleness`; a
  check that throws for any reason degrades to `unknown` rather than propagating.
- `stalenessBootWarnings` has an additional outer try/catch and returns `[]` on any
  failure, so a bug in this module can only ever produce silence, never a crashed boot.
- Every `GitResult` field defaults `stdout`/`stderr` to `''`. `spawnSync` leaves these
  `null` (not `''`) on timeout and on `ENOENT`, and an un-defaulted read of that shape has
  already produced a `TypeError` elsewhere in this repo (see the credential vault's
  timeout handling, same defect class). A test injects the literal null shape to guard
  the regression.
- Git spawns carry `timeout: VAULT_SPAWN_TIMEOUT_MS`, imported from
  `src/brain/credential-vault.ts` rather than re-declared, so the two subsystems share one
  spawn-timeout policy. A hung `git` (a stale `index.lock`, a filesystem stall, a
  credential helper prompting into the void) degrades to `unknown` instead of blocking
  the process with no way out.
- No `dist/`, no `src/`, no lockfile, not a git repository, no upstream, and a detached
  `HEAD` all map to `not-applicable`. A fresh clone is never reported as a problem.

## Known limitation

Git stderr matching (`notARepository`) looks for the standard English "not a git
repository" string. `LC_ALL` is not forced, so a non-English git locale falls through
that check into the no-upstream `not-applicable` branch for `branch-behind` instead of
the more precise "not a git repository" detail. Non-fatal: the state reported
(`not-applicable`) is still correct, only the message is less specific.

## Source map

- `src/harness/staleness.ts` - `collectStaleness`, `stalenessBootWarnings`,
  `BOOT_STALENESS_CHECKS`, `StalenessSignal`/`GitRunner`/`StalenessOptions` types.
- `src/harness/diagnostics.ts` - `athena doctor`'s per-signal `DiagnosticCheck` mapping
  and the `staleness` test-injection seam.
- `src/cli.ts` - boot-time call to `stalenessBootWarnings()`, after the TTY guard, before
  Ink mounts.
- `src/brain/credential-vault.ts` - source of `VAULT_SPAWN_TIMEOUT_MS`, shared rather than
  re-declared.
