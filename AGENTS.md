# AGENTS.md

Repo-specific rules for any AI agent working in this repository, regardless of harness.
This file is the single source of truth; `CLAUDE.md` only points here. Depth lives in
`.wiki/` (start at [`.wiki/INDEX.md`](.wiki/INDEX.md)); this page is the short imperative
distillation, not a second copy.

Athena is a terminal coding-agent harness: Ink TUI (`src/tui/`), model loop
(`src/engine/`), harness services (`src/harness/`), tools (`src/tools/`), local brain and
credentials (`src/brain/`), governed learning (`src/learning/`).

## 1. Fullscreen chrome must be budgeted, and row-count tests cannot verify it

Fullscreen renders one `Box flexDirection="column" height={rows}`. Only the `Transcript`
wrapper has `overflow="hidden"`. Every other sibling (Banner, TodoPanel,
PermissionDialog, BusyIndicator, ArgPickerPopup, InputBox and its popups, StatusLine) is
unclipped: when the column overflows, Yoga flex-shrinks them and Ink draws their content
over one another. The result is a corrupted frame, with no error and nothing to catch.

- Add no fullscreen chrome without placing it in the precedence chain in
  `src/tui/App.tsx` and subtracting its real height from the budget.
- Measure variable-length text with `wrappedRowCount` against the actual terminal width.
  Never assume one row.
- Reuse `popupLayout`/`popupLine` from `src/tui/popupWindow.ts` for any windowed list.
  The number reserved and the number rendered must come from the same call.
- **A corrupted frame still measures exactly `rows`.** Asserting a captured frame's row
  count gives a false pass on precisely this bug. Detection requires content-signature
  assertions (see `expectEveryFrameSound` in
  `tests/tui/fullscreen-popup-overflow.test.tsx`), asserted over **every** captured
  frame, not just the settled one: a transient one-frame corruption is invisible in the
  last frame.
- Reproducing needs a large enough fixture (around 20 todos) for truncation to engage. At
  4 to 6 todos the buggy and correct budgets agree and the defect hides.

This has already caused one ship-blocking incident and is the easiest thing here to
silently re-break. Read
[`.wiki/architecture/tui-fullscreen-row-budget.md`](.wiki/architecture/tui-fullscreen-row-budget.md)
before touching layout, budgeting, or the tests that cover them.

## 2. Optional hardening is never a fatal boot precondition

Making vault migration a mandatory boot step killed the app on Windows for days over a
key that was already on disk and working. Any migration, hardening, or storage-backend
upgrade that improves an already-working state must be best-effort by construction: it
either succeeds, or it warns and leaves the working state alone. It must never abort
startup.

- Never destroy or replace a working artifact before reading its replacement back and
  confirming it matches.
- Never let a code path that runs before the first user interaction throw fatally for an
  optional improvement.
- A `status()`/`available` claim must be backed by a real probe, never a hard-coded
  literal. Unconditional `available: true` made `athena doctor` certify a completely
  broken vault as healthy.
- Degrade loudly: every skipped or failed hardening step prints one sentence naming the
  artifact, the backend, and the recovery command. Silent fallback reads to the user as
  "it forgot my key again".

Design detail in
[`.wiki/architecture/credential-storage.md`](.wiki/architecture/credential-storage.md);
causal chain in
[`.wiki/findings/RCA-2026-07-27-athena-dpapi-boot-abort-and-credential-reauth-loop.md`](.wiki/findings/RCA-2026-07-27-athena-dpapi-boot-abort-and-credential-reauth-loop.md).

## 3. Credentials are per-machine and never enter git

`~/.athena/credentials.json` and `~/.athena/credentials.vault.json` are local to one
machine and one OS user. Vault blobs are machine-bound by design (DPAPI `CurrentUser`,
Keychain, Secret Service) and carrying one to another machine fails to decrypt.

- Never commit a secret. `.gitignore` covers `.athena/`, `**/.athena/`,
  `credentials*.json`, `*.vault.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`. Keep it that
  way, and never weaken it.
- Do not design cross-machine credential sync, a synced encrypted blob, or a startup
  passphrase or unlock prompt. Each machine runs `athena auth` once. Env vars
  (`ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_CODE_API_KEY`) are the zero-file path.
- An undecryptable entry is an actionable error naming `athena auth`, never a raw stack
  and never a silent "not configured".

## 4. Prove environment capabilities, do not infer them

Windows PowerShell 5.1 and PowerShell 7 resolve `[Security.Cryptography.ProtectedData]`
from different assemblies. The obvious single `Add-Type` fix works on one host and breaks
the other, so both assemblies are loaded best-effort and `$ErrorActionPreference='Stop'`
is set so a failure is non-zero exit rather than exit 0 with empty stdout.

Generalize it: when the code shells out to an interpreter or depends on a platform
backend, prove the capability by round-tripping a sentinel through it and caching the
verdict. Do not infer support from a version number, a platform string, or the presence
of an executable. Stub-only coverage of a subprocess-backed module is not coverage: at
least one platform-gated test must actually shell out.

## 5. Known platform limits: do not re-litigate

Each was investigated and deliberately not implemented, because Ink's input layer leaves
no information to act on:

- Mouse-wheel scrolling (enabling mouse tracking injects raw escape sequences into the
  input box).
- Home/End and Ctrl+Home/Ctrl+End (indistinguishable from F1-F12 at the `useInput` seam).
  Ctrl+PageUp/Ctrl+PageDown are used instead.
- Delete key as forward-delete (Ink names Backspace and Delete identically). Ctrl+D is
  the binding.
- Ctrl+Backspace is gated on `WT_SESSION` and degrades elsewhere; Ctrl+W is the portable
  word-delete.

Read [`.wiki/reference/tui-platform-limits.md`](.wiki/reference/tui-platform-limits.md)
before proposing any of these. Current bindings:
[`.wiki/reference/tui-keybindings.md`](.wiki/reference/tui-keybindings.md).

## 6. Gates before push

Run all four, green, on the exact state being committed:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Any edit after a gate invalidates that gate: re-run it. Stage specific files; never
`git add -A` or `git add .` (a project-local `.athena/` brain directory or a stray
credential file is exactly what a blanket add sweeps in). Never push on red. CI runs the
same gates on Node 20 and 22 across Linux, Windows, and macOS, so a local red is a
guaranteed CI red.

## 7. Two-machine workflow

This repo is worked from more than one machine. `dist/` is gitignored and `bin/athena.js`
loads `dist/cli.js`, so a fresh clone or pull has a stale or missing binary. After
pulling:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Never end a session with uncommitted work. The handoff unit between machines is a pushed
commit; anything left dirty is invisible to the other machine and will be lost or
conflicted.

## 8. Keep the wiki current

Any change that alters a mechanism documented in `.wiki/` must update that page in the
same commit, including `.wiki/INDEX.md` when a page is added or its summary changes. A
wiki that contradicts the code is worse than no wiki: it is the thing the next agent
trusts instead of reading the source.
