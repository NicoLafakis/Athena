# Credential storage and the OS vault

Athena resolves each provider's API key in a fixed order and stores it in one of three
states. This page is the architecture reference; the incident that shaped most of the
rules below is written up in full at
[`findings/RCA-2026-07-27-athena-dpapi-boot-abort-and-credential-reauth-loop.md`](../findings/RCA-2026-07-27-athena-dpapi-boot-abort-and-credential-reauth-loop.md)
— read that for the causal chain and evidence; this page documents the resulting design,
not the bug.

## Storage model

Per-machine, local-only. `~/.athena/credentials.json` holds per-provider entries, each
either a plaintext `apiKey` or a `vaultRef` pointing into
`~/.athena/credentials.vault.json` (or the OS-native store on macOS/Linux — see below).
Nothing under `~/.athena/` is ever committed to a project's git repo: the repo root
`.gitignore` ignores `.athena/`, `**/.athena/`, `credentials*.json`, `*.vault.json`,
`*.pem`, `*.key`, `*.p12`, and `*.pfx`. There is no passphrase or unlock prompt at
startup — the OS vault backends (DPAPI, Keychain, Secret Service) authenticate against
the logged-in OS user, not a separate secret Athena manages.

## Resolution order

`resolveApiKey` (`src/brain/credentials.ts`) checks, per provider, in this order:

1. **Env var** (e.g. `ANTHROPIC_API_KEY`) — always wins, matches prior behavior, and is
   the documented zero-file path.
2. **File, plaintext** — `credentials.json`'s `apiKey` field.
3. **Vault** — `credentials.json`'s `vaultRef` field, resolved through the platform's
   `CredentialVault` (`src/brain/credential-vault.ts`).

`resolveApiKey` never throws. A vault read failure (undecryptable blob, backend down)
resolves as "no key from the vault" plus a warning string the caller can surface, rather
than propagating an exception or silently falling through to the auth wizard with no
explanation.

The optional OpenAI Realtime voice credential is deliberately outside the coding-model
provider schema. `resolveVoiceKey` checks `OPENAI_API_KEY` first and then the fixed
`voice/openai` OS-vault reference. `athena voice auth` validates a Realtime session before
writing, verifies the new vault value by readback, and attempts to restore the prior
working value if replacement verification fails. It never falls back to a plaintext
voice key: when the vault is unavailable, `OPENAI_API_KEY` is the recovery path.

## Plaintext vs. vault, and how the user is told which

A key can be in one of two states, and the user-facing status output
(`athena auth status`, `formatAuthStatus` in `credentials.ts`) always says which:

- **Plaintext** — `(file)` in the status line. This is the working baseline state: it
  always works, on every platform, with zero dependencies.
- **Vault-backed** — `(OS vault)` in the status line, or `UNREADABLE on this machine
  (encrypted elsewhere?) - run \`athena auth\`` if the stored blob can't be decrypted on
  this machine/user account.

Moving a key from plaintext into the vault is `migrateCredentialsToVault`, invoked once
at boot when a plaintext `apiKey` is present. It is **best-effort by construction and
cannot throw**: every vault call inside it is wrapped in try/catch, and a provider's
plaintext entry is only ever replaced with a `vaultRef` after the freshly written vault
entry has been read back and confirmed to match. An unreadable or partially-working
backend can therefore never destroy a working plaintext key. Each vault backend's own
`set()` performs the same read-back-before-persist check independently (see
`WindowsDpapiVault.set` in `credential-vault.ts`), so the guarantee holds even if
`migrateCredentialsToVault`'s own read-back were ever removed.

Every place a vault write is skipped or fails — migration, or the auth wizard's own save
path (`setProviderKey`) — prints a `WARNING: ... stored UNENCRYPTED ... (<reason>)` line
before the TUI mounts, rather than degrading silently. "It forgot my key again" is
exactly the failure mode a silent fallback produces, so the warning is part of the
contract, not polish.

## The standing rule: optional hardening must never be a fatal boot precondition

This is the core lesson of the 2026-07-27 incident and applies beyond credentials: **any
migration, hardening, or storage-backend upgrade that improves on an already-working
state must be best-effort by construction.** It either succeeds and improves things, or
it warns and leaves the working state alone. It must never be able to abort startup.

Concretely for the credential path:

- Vault **migration** (`migrateCredentialsToVault`) cannot throw and cannot block boot.
- Vault **reads** (`resolveApiKey`, `formatAuthStatus`) cannot throw; a decrypt failure
  degrades to "unresolved" plus a warning, not an unhandled exception with a raw stack.
- A `CredentialVaultStatus.available` claim must be backed by an actual probe (encrypt →
  decrypt round-trip against a sentinel value, cached for the process lifetime — see
  `WindowsDpapiVault.probe` in `credential-vault.ts`), never a hard-coded `true`. Before
  the fix, `available: true` was unconditional, so `athena auth status` and `athena
  doctor` both certified a completely broken Windows vault as healthy.
- All vault subprocess spawns (PowerShell, `security`, `secret-tool`) carry a 5-second
  timeout (`VAULT_SPAWN_TIMEOUT_MS`) and treat a timeout as "not answering right now" —
  transient, not cached as a permanent verdict — rather than blocking the process forever
  on a stalled AMSI scan, a dead D-Bus session, or an unanswered keychain prompt.

## Cross-machine story

Vault-backed entries are machine-bound by design and are never meant to sync:

- Windows DPAPI blobs are scoped `CurrentUser` — bound to the Windows user account and
  machine that created them.
- macOS Keychain and Linux Secret Service entries live outside the filesystem entirely.

If a `credentials.vault.json` (or a `credentials.json` full of `vaultRef` entries) is
ever carried to a different machine or user account, decryption fails. That failure now
produces an actionable message (`vaultUndecryptableError` in `credential-vault.ts`):
"The OS credential vault could not decrypt the stored secret for `<reference>`. It was
most likely encrypted on a different machine or user account. Run `athena auth` to
re-enter the key on this machine (once, permanently)." — never a raw stack, never a
silent "not configured".

There is no cross-machine credential sync, and none is planned: each machine runs
`athena auth` once. If a shared-config story is ever wanted, the seam is already there —
`credentials.json`'s shape (`apiKey` or `vaultRef` per provider) is what's shareable, the
vault *file itself* is what stays strictly per-machine.

## Windows interpreter selection

`createCredentialVault` prefers `pwsh.exe` (PowerShell 7) over `powershell.exe`
(Windows PowerShell 5.1, desktop CLR) when both are present, and falls back to 5.1
otherwise — every stock Windows install ships 5.1, so it must always work standalone.
The DPAPI PowerShell snippets (`DPAPI_ENCRYPT`/`DPAPI_DECRYPT`) load
`System.Security` (5.1's location for `[Security.Cryptography.ProtectedData]`) *and*
`System.Security.Cryptography.ProtectedData` (7's location) best-effort before use, since
the two runtimes disagree on which assembly defines that type and getting this wrong is
exactly what caused the original boot abort. `$ErrorActionPreference='Stop'` is set so
any residual failure is a terminating error (non-zero exit) rather than exit 0 with empty
stdout — the shape that would otherwise let an empty/garbage ciphertext get persisted
silently.

## Source map

- `src/voice/credentials.ts` - env/vault resolution and verified replacement for the
  optional `voice/openai` reference; no plaintext fallback.

- `src/brain/credentials.ts` — load/save, `resolveApiKey`, `setProviderKey`,
  `migrateCredentialsToVault`, `formatAuthStatus`.
- `src/brain/credential-vault.ts` — per-platform `CredentialVault` implementations
  (`WindowsDpapiVault`, `MacOsKeychainVault`, `LinuxSecretServiceVault`,
  `UnavailableVault`), the capability probe, and `vaultUndecryptableError`.
- `src/cli.ts` — boot sequence wiring: vault construction, the (now non-fatal) migration
  call, key resolution, wizard fallback.
- `src/harness/diagnostics.ts` — `athena doctor`'s `credential-vault` check, now reading
  the probed `vaultStatus.available` rather than trusting an unconditional claim.
- `.gitignore` — hardened credential-path ignores.
- Tests: `tests/brain/credential-vault.test.ts`, `tests/brain/credential-vault-timeout.test.ts`,
  `tests/cli/provider-vault-warn.test.ts`, `tests/voice/credentials.test.ts`.
