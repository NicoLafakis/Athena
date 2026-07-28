# RCA 2026-07-27: Athena boot aborts on Windows PowerShell 5.1 DPAPI, and credentials never survive into a session

- Date: 2026-07-27
- Reporter/source: Nico (laptop, Windows 11, PowerShell 5.1), reported via orchestrator
- Severity: Critical. Athena cannot start at all on this machine. Every launch exits 1 before any session begins.
- Investigator: root-cause-analyst
- Status: root cause confirmed by reproduction

## 1. Symptom

Verbatim as reported, running `athena` in Windows PowerShell 5.1:

```
DPAPI encryption failed: Unable to find type [Security.Cryptography.ProtectedData].
At line:1 char:88
+ ... etBytes($plain);$cipher=[Security.Cryptography.ProtectedData]::Protec ...
    + CategoryInfo          : InvalidOperation: (Security.Cryptography.ProtectedData:TypeName) [], RuntimeException
    + FullyQualifiedErrorId : TypeNotFound

Exception calling "ToBase64String" with "1" argument(s): "Value cannot be null. Parameter name: inArray"
At line:1 char:206
+ ... urrentUser);[Console]::Out.Write([Convert]::ToBase64String($cipher)); ...
    + FullyQualifiedErrorId : ArgumentNullException
```

Second reported symptom: "must re-enter / re-auth API keys on every startup."

Precise characterization after investigation:

- The process does not merely warn. It prints that message and terminates with exit code 1 at `src/cli.ts:1136-1140`, before the TUI mounts, before any provider call, and before the auth wizard can run. Athena is unusable on this machine, not degraded.
- The message is emitted by the legacy-credential migration path, not by the wizard. That distinction is load bearing: the wizard's vault failure is wrapped in a warning prefix (`OS credential vault write failed; retaining protected local-file fallback: ...`, `src/brain/credentials.ts:118-120`) and the reported output has no such prefix, so the failure came through `migrateCredentialsToVault` (`src/brain/credentials.ts:169`) whose `vault.set` call has no error handling at all.
- "Re-enter keys on every startup" is a consequence, not an independent bug. A valid Anthropic key IS on disk and has been since 2026-07-23. It is simply never reached, because the migration step that runs before key resolution kills the process first.

## 2. Root cause (confidence: confirmed)

Commit `621dda3` ("feat: implement harness parity and governed learning", 2026-07-24 20:32) introduced an OS credential vault and wired an unconditional, non-optional plaintext-to-vault migration into the boot sequence. The Windows backend implements DPAPI by shelling out to an inline PowerShell one-liner that references `[Security.Cryptography.ProtectedData]` without loading the assembly that defines it. In Windows PowerShell 5.1 (desktop CLR) that type is in `System.Security.dll`, which is not auto-loaded, so the type does not resolve; PowerShell exits 1 and stdout is empty. The vault treats that as a hard error, the migration function does not catch it, and the CLI turns any migration error into a fatal exit. The design decision at the root is that a best-effort security enhancement (moving an already-working plaintext key into an OS vault) was made a mandatory, unguarded precondition of starting the program, on a code path whose only implementation was never tested against the PowerShell version that ships with Windows.

Two design choices compound it: the vault reports `available: true` unconditionally without ever probing whether the backend works (`src/brain/credential-vault.ts:78-84`), and the executable chooser prefers `powershell.exe` over `pwsh.exe` whenever both exist (`src/brain/credential-vault.ts:194-198`), which on any stock Windows means PowerShell 5.1 is always selected even on a machine with PowerShell 7 installed.

## 3. Causal chain

Trigger
: Building and running the `621dda3` build on this laptop. `dist/cli.js` was rebuilt 2026-07-27 20:32 and contains the vault code (`grep -c ProtectedData dist/cli.js` returns 2). The last successful Athena session on this machine is `~/.athena/sessions/C--programming-nicos-apps-Athena/2026-07-24T02-37-41-99a4d4ed.jsonl`, last written 2026-07-23 22:37, which is before commit `621dda3` (2026-07-24 20:32). Nothing has started successfully since the vault landed.

Proximate cause 1 (type not found)
: `src/brain/credential-vault.ts:59-64` builds `DPAPI_ENCRYPT` as a single `-Command` string that calls `[Security.Cryptography.ProtectedData]::Protect(...)` with no `Add-Type -AssemblyName System.Security` first. Verified directly on this machine: running that exact one-liner under `powershell.exe` (version 5.1.26100.8875) returns exit code 1 with empty stdout and the reported `TypeNotFound` plus `ArgumentNullException` stderr. Adding `Add-Type -AssemblyName System.Security;` to the front of the identical one-liner returns exit code 0 and 308 bytes of Base64. That is a controlled A/B on the real machine.

Proximate cause 2 (wrong interpreter chosen, and no version check at all)
: `src/brain/credential-vault.ts:194-198` picks `powershell.exe` if `where.exe powershell.exe` succeeds, and only falls back to `pwsh.exe` otherwise. There is no PowerShell version detection anywhere in the codebase. On this laptop `where.exe pwsh.exe` finds nothing, so PowerShell 7 is not even an available fallback. On a machine that has PowerShell 7, the ordering still selects 5.1, because `powershell.exe` is present on every Windows install. The hypothesis that the desktop works because it has PowerShell 7 is therefore refuted by the code: the desktop would select 5.1 too.

Proximate cause 3 (the error is fatal instead of best effort)
: `src/brain/credential-vault.ts:92` throws on non-zero exit. `src/brain/credentials.ts:169` calls `vault.set(...)` inside `migrateCredentialsToVault` with no try/catch, so the throw escapes. `src/cli.ts:1130-1140` wraps the migration call in a try/catch whose handler prints the message and sets `process.exitCode = 1` and returns. Key resolution at `src/cli.ts:1142` is never reached.

Precondition that makes it fire every time
: `~/.athena/credentials.json` (last modified 2026-07-23 13:28) contains `providers.anthropic.apiKey` as a plaintext string, 108 characters. `migrateCredentialsToVault` iterates every provider with a plaintext `apiKey` (`src/brain/credentials.ts:165-172`), so the presence of the working legacy key is exactly what guarantees the fatal path on every launch. The better the user's prior state, the more certain the failure.

Root cause
: The decision in `621dda3` to run vault migration unconditionally at boot and treat its failure as fatal, combined with a Windows DPAPI implementation written against PowerShell 7 type resolution semantics and never exercised against PowerShell 5.1. There is no test file for `src/brain/credential-vault.ts` anywhere in `tests/`; the only vault coverage is `tests/brain/credentials.test.ts:197-220`, which uses an in-memory stub vault that always succeeds. The real backend has zero coverage, which is why a green test suite shipped a boot-killing regression.

Contributing factors
: (a) `WindowsDpapiVault.status()` returns `available: true` with the reassuring text "Secrets are encrypted for the current Windows user with DPAPI" without ever probing the backend, so `athena auth status` and `athena doctor` both report the vault as healthy while it is completely non-functional. Verified: `athena auth status` against a sandboxed home prints `Credential vault: windows-dpapi - Secrets are encrypted for the current Windows user with DPAPI` on the same machine where encryption fails. (b) `formatAuthStatus` swallows vault read exceptions (`src/brain/credentials.ts:207-211`), so status can never surface a broken vault either. (c) No `ATHENA_HOME` or equivalent override exists (`src/brain/paths.ts:33-34` uses `homedir()` only), so there is no easy escape hatch or sandbox for the user.

## 4. Reproduction

Run from the repo with a sandboxed profile and a fake key (no network call is reached):

```
USERPROFILE=<scratch>\fakehome node dist/cli.js exec "say hi"
```

Result: byte-for-byte the reported stderr, exit code 1, `credentials.json` left untouched with the plaintext key, and no `credentials.vault.json` created. `athena auth status` on the same sandbox prints `sk-ant...1234 (file) [active]` and claims the vault is available.

## 5. Evidence log

Examined and confirmed:

- `src/brain/credential-vault.ts:59-70` (one-liner construction), `:86-104` (spawn and throw), `:189-201` (backend and executable selection).
- `src/brain/credentials.ts:37-64` (load), `:71-94` (save), `:98-129` (wizard save with tolerated vault failure), `:136-152` (resolution order env, file, vault), `:157-175` (unguarded migration).
- `src/cli.ts:1093` (vault construction), `:1094-1113` (auth subcommand, runs before migration), `:1129-1140` (fatal migration), `:1142-1181` (resolution and wizard fallback).
- `src/auth/wizard.ts:41-79` (wizard save path).
- On-machine facts: `where.exe powershell.exe` found, `where.exe pwsh.exe` not found, `$PSVersionTable.PSVersion` = 5.1.26100.8875, `~/.athena/` contains `credentials.json` (210 bytes, plaintext key, mtime 2026-07-23 13:28) and no `credentials.vault.json`.
- Git: `git log -- src/brain/credential-vault.ts` shows a single commit, `621dda3`. `git log -S migrateCredentialsToVault -- src/cli.ts` shows the same single commit. The regression window is exactly that commit.

Hypotheses raised and falsified:

1. "The desktop works because it has PowerShell 7, and the laptop launch path hits 5.1." Falsified for the code, partly correct for the machine. There is no version detection at all, and `powershell.exe` is preferred over `pwsh.exe` at `src/brain/credential-vault.ts:194-198`, so PowerShell 7 would never be chosen on a normal Windows box even if installed. The likely real reason the desktop works is that it has no plaintext `apiKey` in `credentials.json` (for example it uses `ANTHROPIC_API_KEY` from the environment, which `resolveApiKey` checks first at `src/brain/credentials.ts:142-143`), which makes `migrateCredentialsToVault` a no-op. This should be confirmed on the desktop by checking whether `~/.athena/credentials.json` exists and whether `ANTHROPIC_API_KEY` is set; that single check settles it.
2. "The DPAPI failure silently writes an empty or corrupt blob, so the key is destroyed." Falsified on this machine. PowerShell exits 1, `protect()` throws at `src/brain/credential-vault.ts:92`, and `atomicWriteFileSync` at `:114` is never reached. No `credentials.vault.json` exists on disk and `credentials.json` still holds the original key. This hypothesis is however a live latent risk on any host where the same script produces an error but a zero exit code (PowerShell 7 non-terminating error configurations, or a future `-Command` edit): `protect()` would return an empty string, `set()` would persist `""`, `get()` treats `""` as absent because of the falsy check at `:108`, and the migration would then rewrite `credentials.json` replacing the real key with a `vaultRef` pointing at nothing. That is a silent key-destruction path and must be closed even though it is not what happened here.
3. "The boot sequence invokes the wizard unconditionally instead of checking for existing credentials." Falsified. `src/cli.ts:1142-1181` checks resolution first and only falls into the wizard when no key resolves anywhere. The wizard is not the problem; the process dies before it.
4. "Write path and read path disagree on directory, filename, or key name." Falsified. Both sides go through `BrainPaths.credentialsFile` = `~/.athena/credentials.json` (`src/brain/paths.ts:40`) and the vault reference string `provider/<id>` is generated identically at `src/brain/credentials.ts:113` and `:168`.
5. "Env-var-only reads with no file fallback." Falsified. `resolveApiKey` reads env, then file, then vault, in that order (`src/brain/credentials.ts:142-151`).
6. "Permissions or file locking." Falsified. `credentials.json` is readable, parses cleanly, and `athena auth status` reads and redacts it correctly on this machine.
7. "There is a second, older persistence bug that predates the vault." No evidence found, medium confidence that none exists. `credentials.json` has survived untouched since 2026-07-23 13:28 and sessions ran successfully as late as 2026-07-23 22:37, which is what a working file-backed persistence looks like. If Nico recalls re-authing before 2026-07-24 as well, the settling experiment is to check whether `credentials.json` mtime advances after a wizard run; if the wizard reports "Saved to ..." but mtime does not move, there is a second bug and this finding is incomplete.

## 6. Blast radius

- Every Windows machine running `621dda3` or later that has a plaintext `apiKey` in `~/.athena/credentials.json` cannot start Athena. This is currently a total outage on the laptop.
- Every Windows machine running `621dda3` or later that reaches `athena auth` will silently fall back to storing the key in plaintext (`src/brain/credentials.ts:117-121`), which is exactly the state that guarantees the fatal migration on the next launch. The wizard and the boot path are in a stable loop: auth writes plaintext, boot dies on plaintext, repeat.
- macOS and Linux are unaffected by the type-load bug but share the fatal-migration design. If `security` or `secret-tool` is present but failing (locked keychain, no D-Bus session, headless SSH), `migrateCredentialsToVault` throws the same way and boot dies identically. Same root cause, different trigger.
- Sibling: unguarded vault reads. `src/cli.ts:1142` calls `resolveApiKey` outside any try/catch, and `resolveApiKey` calls `vault.get` at `src/brain/credentials.ts:148`, which calls `unprotect` which throws on non-zero exit (`src/brain/credential-vault.ts:102`). Once encryption is fixed and a vault file exists, any decrypt failure (a blob carried to the other machine, a Windows credential reset, a restored profile) produces an unhandled exception with a raw stack instead of a clean "vault unreadable, re-run athena auth" message. This is the next outage waiting to happen and must be fixed in the same change.
- Sibling: the falsy-empty-string bug at `src/brain/credential-vault.ts:108` (`return encrypted ? ... : null`) makes an empty stored blob indistinguishable from "not configured", which converts a write failure into silent data loss rather than an error.
- Sibling: status reporting lies in two places, `src/brain/credential-vault.ts:78-84` (unconditional `available: true`) and `src/harness/diagnostics.ts:92-98` (doctor reports `ok` based on that claim). Both must become probe-based or the user's diagnostic tools will keep confirming a broken component as healthy.
- Adjacent (not causal, house-rule): `src/brain/credential-vault.ts:218` renders an em-dash in user-facing status output. Same for any other user-visible copy in that file.

## 7. On-disk repair requirement

No repair or migration step is needed for the current disk state, and this is important: `~/.athena/credentials.json` still contains the original valid plaintext key and no `credentials.vault.json` exists. Fixing the type-load bug alone will unblock boot on the existing file. However, the fix MUST NOT silently migrate that key into a machine-bound DPAPI blob as its first act (see section 8, item 5), because doing so is what creates the two-machine problem. The implementer should verify before and after: `~/.athena/credentials.json` should still resolve a key, and if a `credentials.vault.json` is ever created it should be provably readable by `vault.get` in the same run before `credentials.json` is rewritten to drop the plaintext value.

If any machine already has a `credentials.vault.json` containing an empty-string entry (the latent path in hypothesis 2), the repair is to treat empty or undecryptable entries as an explicit error and re-run `athena auth`, not to treat them as "not configured".

## 8. Machine-bound versus shareable inventory, and git risk

Machine-bound (cannot be shared between the laptop and the desktop, and must never be):

- `~/.athena/credentials.vault.json`: DPAPI blobs at `DataProtectionScope::CurrentUser` (`src/brain/credential-vault.ts:62`, `:68`). Bound to Windows user plus machine. Copying this file to the other machine produces decrypt failures, which currently surface as an unhandled crash.
- macOS keychain and Linux Secret Service entries under service `Athena CLI` / `athena-cli`: outside the filesystem entirely, inherently per-machine.
- `~/.athena/credentials.json` when it holds a plaintext `apiKey`: technically portable, but it is a cleartext secret and must be treated as machine-local and never synced.
- `~/.athena/learning/signing-key.pem` (`src/brain/paths.ts:59`): a private key. Machine-local secret by definition.
- `~/.athena/trust.json`: keyed to absolute project paths and content digests, machine-specific in practice.
- `~/.athena/sessions/`, `journal/`, `runs/`, `agent-runs/`: local history, may contain prompt content and therefore incidental secrets.

Safely shareable via git, if the user ever wants cross-machine sync:

- `~/.athena/ATHENA.md` (constitution), `settings.json`, `skills/`, `agents/`, `commands/`, `plugins.json` and non-secret plugin definitions, `memory/MEMORY.md`. None of these hold secrets today.

Git tracking risk, current state:

- Nothing under `~/.athena` is in the repo. `git ls-files` returns 196 files, none of which is a credential store. The only matches for credential-related names are source and test files.
- All `sk-ant-...` strings in tracked files are placeholders in tests and plan docs (`tests/brain/credentials.test.ts:225,241,250`, `tests/harness/sessions.test.ts:199`, `tests/harness/traces.test.ts:93`, `docs/superpowers/plans/2026-07-23-athena-auth-multiprovider.md`). No real secret is committed. Verified.
- Real exposure gap: the repo `.gitignore` is 6 lines (`node_modules/`, `dist/`, `*.log`, `.env`, `.env.*`, `!.env.example`). It does NOT ignore `.athena/`, and `src/brain/paths.ts:35` supports a project-local `<cwd>/.athena` brain directory. If a project-local brain is ever created inside this repo (or any repo Athena runs in), its contents are un-ignored and one careless `git add -A` commits them. No such directory exists in this repo today, so this is a latent risk, not an active leak. `credentials*.json` and `*.pem` are likewise not ignored by name.

## 9. Fix specification

Ranked. Items 1 through 3 are required to restore service; 4 through 7 close the class.

1. `src/brain/credential-vault.ts:59-70`, make the PowerShell snippets version-portable. Prepend `Add-Type -AssemblyName System.Security;` to both `DPAPI_ENCRYPT` and `DPAPI_DECRYPT`. Verified working on PowerShell 5.1.26100.8875 (exit 0, 308 bytes of Base64) and harmless on PowerShell 7, where the assembly load is a no-op. Also prepend `$ErrorActionPreference='Stop';` so any residual error is terminating and produces a non-zero exit rather than empty stdout with exit 0.

2. `src/brain/credentials.ts:157-175`, make migration best effort. Wrap the `vault.set(reference, apiKey)` call per provider in try/catch. On failure, leave that provider's plaintext entry exactly as it is, do not mark `changed`, and report through an `onWarn` callback added to the signature (mirroring `setProviderKey`'s existing `options.onWarn` at `:102`). Migration must never be able to prevent startup. Correspondingly at `src/cli.ts:1129-1140`, keep the try/catch for genuine credential-file errors (`ATHENA_CREDENTIALS_INVALID`, I/O errors) but ensure a vault failure can no longer reach it, and print any migration warnings to stderr before the TUI mounts.

3. `src/cli.ts:1142` and `src/brain/credentials.ts:146-150`, make vault reads non-fatal. Wrap the `vault.get(reference)` call in try/catch inside `resolveApiKey`; on exception, treat it as unresolved but surface a distinguishable reason to the caller so the CLI can print "the OS credential vault could not decrypt the stored key for <provider> (it may have been created on a different machine or user account); run `athena auth` to re-enter it" instead of silently dropping into the wizard or crashing with a raw stack. Silent fallback to the wizard is precisely the behaviour that reads as "it forgot my key again", so this message is part of the fix, not polish.

4. `src/brain/credential-vault.ts:78-84` and `:189-201`, make availability real and version-aware. Replace the unconditional `available: true` with a one-time probe performed when the vault is constructed or first used: encrypt then decrypt a short sentinel value and require the round trip to match. Cache the result for the process lifetime so boot pays at most one PowerShell spawn. If the probe fails, return an `UnavailableVault` carrying the actual stderr, so `athena auth status` and `athena doctor` (`src/harness/diagnostics.ts:92-98`) report `warning` with the real reason rather than `ok`. Also reverse the executable preference to try `pwsh.exe` first and fall back to `powershell.exe`, and record which one was selected in the status detail.

5. `src/brain/credential-vault.ts:106-115`, close the silent-empty-blob path. In `protect()`, reject a blank or non-Base64 stdout as an error even when the exit code is zero. In `get()`, replace the falsy check `encrypted ? ... : null` with an explicit "key present but empty or invalid" error rather than a null that reads as "not configured". In `set()`, verify the round trip (decrypt what was just encrypted and compare) before `atomicWriteFileSync`, so a partially working backend can never persist an unreadable entry. In `migrateCredentialsToVault`, only rewrite `credentials.json` to a `vaultRef` after a successful read-back of that reference, so the plaintext key is never dropped in favour of an unreadable blob.

6. Portable-credentials posture, per the constraint. Keep each machine's secret strictly local and unsynced: `~/.athena/credentials.vault.json` stays machine-bound by design and must never be copied or committed. What should be shareable is configuration, not secrets. Concretely: do not attempt cross-machine credential sync at all; instead make the "no key on this machine" path fast and obvious (the clear message from item 3 plus `athena auth`), and document in the README that each machine runs `athena auth` once. If a shared-config story is wanted later, the clean seam is to allow `credentials.json` to hold only `vaultRef` entries (already the shape today) while the vault file itself is per machine, so the same `credentials.json` is meaningful on both boxes and only the blob store differs. Also honour `ANTHROPIC_API_KEY` and the other provider env vars as the documented zero-file path, which already works (`src/brain/credentials.ts:142-143`) and is almost certainly why the desktop is unaffected.

7. `.gitignore` at the repo root, add `.athena/`, `credentials*.json`, `credentials.vault.json`, and `*.pem`. This is prophylactic (nothing is leaking today) and costs nothing. Do not remove the existing entries.

Regression tests to add with the fix (there is currently no `tests/brain/credential-vault.test.ts` at all, which is the coverage hole that let this ship):

- A unit test asserting both PowerShell snippet strings contain `Add-Type -AssemblyName System.Security` and `$ErrorActionPreference='Stop'`. Cheap, string-level, catches the exact regression on any platform including CI on Linux.
- A unit test asserting `createCredentialVault` prefers `pwsh.exe` when both executables are reported present, using the injectable `platform` argument and a stubbed command probe.
- A test that `migrateCredentialsToVault` with a vault stub whose `set` throws returns the original credentials unchanged, does not rewrite the file, and invokes `onWarn`. This is the test that would have caught the outage.
- A test that `resolveApiKey` with a vault stub whose `get` throws returns a non-throwing unresolved result rather than propagating.
- A test that `set` on a vault whose `protect` returns an empty string throws rather than persisting `""`, and that `get` on a stored `""` entry throws rather than returning null.
- A Windows-only integration test, skipped elsewhere, that round-trips a sentinel through the real `WindowsDpapiVault` and asserts the decrypted value matches. Run it in the pre-push suite on the Windows machines; it is the only thing that would have caught a PowerShell-version dependency, since no amount of stub-vault testing can.

## 10. Prevention

- Never let an optional security upgrade become a mandatory boot precondition. Any migration, hardening, or storage-backend change that improves on a currently working state must be best effort by construction: it either succeeds and improves things, or it warns and leaves the working state alone. Make this an explicit review question for any code that runs before the first user interaction.
- Any component whose `status()` claims availability must prove it. An `available: true` that is a hard-coded literal is a lie waiting to mislead the next investigation; here it caused `athena doctor` and `athena auth status` to certify a totally broken vault as `ok`. Availability should mean "I probed it and it worked".
- Shelling out to an interpreter means committing to that interpreter's version matrix. Any `powershell.exe` invocation in this codebase must be assumed to be Windows PowerShell 5.1 on the desktop CLR, must load its own assemblies, and must set `$ErrorActionPreference='Stop'`. `src/tools/shell.ts:49` hard-codes `powershell.exe` for the user-facing shell tool as well; that is intentional for shell semantics, but it should be a documented, deliberate choice rather than an accident, and version should be recorded in `athena doctor` output.
- Stub-only coverage for a subprocess-backed component is not coverage. The rule to encode: when a module's entire job is to shell out, at least one test must actually shell out on the platform it targets, gated by platform so other platforms skip it.
- Failure surfacing over failure swallowing. Three separate places in this chain converted a hard failure into either silence (`formatAuthStatus` catch at `src/brain/credentials.ts:207-211`, the falsy-empty check at `src/brain/credential-vault.ts:108`) or a raw crash (`src/cli.ts:1142`). Every credential-path failure should produce one sentence that names the file, the backend, and the recovery command. Observability here is Vercel-style external tooling's opposite: this is a local CLI, so the only observability is the message printed to the user's terminal and the exit code. Both must be correct.
