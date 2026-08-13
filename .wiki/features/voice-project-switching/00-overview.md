# Voice-addressable project switching

**Status: design. Piece 1 (composition unification) in progress; pieces 2 and 3 not
started.** Nothing here is shipped. The protected-paths fence and the
trusted/unrestricted posture that this design assumes ARE shipped — see
[permissions and project trust](../../architecture/permissions-trust.md).

## The goal, in Nico's words

> "I can just have a verbal conversation with Athena asking her to go to other
> directories and work on projects and start agents in those projects and do that kind of
> stuff without, like, actually having to have my hands on the keyboard. I can just use
> that wake word and make the request and see within the CLI display that that's taking
> place."

Four capabilities are named there. Two already work, two do not:

| Capability | State |
| --- | --- |
| Speak a work turn hands-free, answer permissions by voice | Works |
| Read and write outside the session root | Works — the fence is the only limit |
| Re-root the session at another project by voice | **Missing** |
| See it happen in the Ink display | **Missing** — voice mode prints plain lines |

## Why it is not a small change

`athena voice` is the only caller of `HarnessSessionController`
(`src/cli.ts`, the voice branch). The interactive Ink TUI builds its own engine, bus,
gate, trace, and session store inline inside `main()`. Two compositions of the same
session exist, and both missing capabilities have to cross that seam. So the seam is the
work, and it is piece 1.

`cwd` being `readonly` on the controller is correct, not an oversight. Construction-time
consumers of it include the resource policy, the permission engine, project trust, the
project's own `settings.json` (its `allow`/`deny`/`hooks`/`mcpServers`/`protectedPaths`),
project context files, the session-store scope, the experience-guidance project scope, and
the trace header. Mutating the field would leave every one of those pointing at the
previous project — a session that believes it is in one repo while enforcing another
repo's rules. The correct move is to rebuild the controller against the new root and carry
the conversation history across, not to make the field writable.

## The three pieces, in dependency order

1. **Unify the composition.** The interactive TUI path builds from
   `HarnessSessionController`. Pure refactor, zero behavior change. Nothing else is clean
   until this lands, and afterwards every future session capability is written once
   instead of three times.
2. **Session re-rooting.** A `switchProject(path)` that closes the current controller
   (SessionEnd hook, trace close, session persisted), re-resolves trust and settings for
   the new root, and creates a replacement carrying the message history. The Realtime
   socket lives above the controller in `src/voice/daemon.ts`, so the spoken session
   survives the swap uninterrupted. Exposed to voice as a `switch_project` action on
   `local_control`, where the model proposes a path and local code resolves and validates
   it — the same shape as permission answers, and for the same reason: the model never
   decides, it only asks.
3. **Ink TUI in voice mode.** `App` already takes a bus, status, permission bridge,
   submit handler, and slash handler, all satisfiable from a controller once piece 1
   lands. Permission requests render on screen while staying voice-answerable, and the
   keyboard remains live in the same window rather than being an either/or.

Starting agents in the switched-to project needs no separate work: subagents build their
resource policy from the controller's `cwd` (`src/harness/agents.ts`), so it falls out of
piece 2.

## Trust roots

Decided by Nico on 2026-08-13, after the distinction was put to him explicitly.

Trust is not "may Athena work here" — the fence settles that, and everything outside it is
writable. Trust answers "may this repository influence Athena": its project settings, its
hooks (arbitrary commands, executed), its MCP servers, and its instructions in the system
prompt. Today it is granted deliberately, one project at a time, via `athena trust`.

Nico's position: *"Anything that's on my drive and especially in 'nico-apps' it's a
directory that's explicitly approved to work in."* A switch that then refused to load the
project's own configuration would defeat the purpose.

**Design: a `trustRoots` setting listing directories under which projects trust
automatically.** Not a blanket on-switch grant, for three reasons: it is inspectable in
`athena doctor` alongside the fence, it can be carved out if a third-party repo is ever
cloned onto the drive, and it keeps the deliberate `athena trust` path intact for anything
outside the roots.

Two consequences to state plainly rather than discover later:

- Trust is **two-level**. `isTrusted` is the gate above; `capabilities.hooks` and
  `capabilities.mcp` are approved separately and keyed to a **content digest**
  (`src/harness/trust.ts`), so today a trusted project whose hook configuration changes
  re-prompts. Auto-granting capabilities under a trust root removes that re-prompt. For
  repos Nico writes, that is the friction being removed on purpose. It is still a real
  reduction in signal and belongs in the doctor output.
- A trust root is a **standing** grant, not a per-switch one. Any repository that later
  appears under a root is trusted the moment it is entered, with no further action. That
  is the intended behavior and the reason the roots are a short, explicit list rather than
  "the whole drive" implicitly.

Trust roots compose with the fence rather than competing with it: the fence is about what
the operating system must survive and is unconditional; trust roots are about whose
configuration Athena will read, and are Nico's to set.

## Open questions

- Whether a switch into a directory that is not a project root at all (no git repo, no
  settings) should be allowed, refused, or allowed with a spoken warning.
- What the spoken confirmation should be. A silent re-root is fast but leaves no audible
  evidence of which project is live, and the wrong-project failure mode is expensive.
- Whether history carries across a switch in full, is summarized, or starts clean. Full
  carry is the least surprising and the most token-expensive.
