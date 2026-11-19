# Privacy, security and local authority

[Overview](00-overview.md) | [Evaluation](evaluation.md)

## Data classes and approval boundary

The continuity ADR records the owner's earlier selection of current-request Jev routing and speech-act classification. That history is not permission in this session to activate calls or broaden payloads. A secret redactor is not a personal-data anonymizer. Current text can contain private health, finance, identity, employment, client or relationship information even with all API keys removed.

| Payload class | Planning disposition |
|---|---|
| Current user request | Preserve old boundary after merge; require existing permission to apply to that exact processing scope, with local exclusion for prohibited/sensitive material. No whole conversation, prior turns or system instructions. |
| Skill metadata | New scope. Only approved, trusted catalog fields; private personal/team skill names and descriptions can disclose work. Obtain approval before enabling transmission. |
| Public project docs/source | New scope even if publicly available. Use only verified public allowlisted files or approved excerpts; no ambient filesystem traversal. Confirm licensing, repository policy and destination. |
| Historical episodes, personal memory, journal, traces, learned candidates | Off by default; separate explicit approval for specific data class and TypeSafe destination. Legacy current-request opt-in does not cover these. Prefer local deterministic processing when denied. |
| Tool results, arbitrary file contents, env values, MCP responses, screenshots/audio | Excluded. No opportunistic upload, debugging export or fallback to another gateway. |
| Credentials, tokens, private keys, full payment data or government/social-insurance identifiers | Never part of model decision payload. Local redaction/exclusion precedes inference. Do not inspect actual keys while implementing tests. |

Enforce payload scopes in code before the network client, not by asking Jev whether uploading is safe. Reject sensitive/unsupported cases locally; deterministic detectors are conservative aids, not completeness guarantees. If data cannot be confidently scoped, skip the feature or ask the owner about the needed class rather than silently sanitize and send.

Use the existing environment-only TypeSafe credential path; do not copy it to settings, a repo, trace, tests, another machine or a new provider. No secret handling was performed for this documentation. Do not let projects set a vendor endpoint, enable features, select broader data scopes, or override global exclusions. Endpoint changes require a fresh recipient/security review, not arbitrary URL settings accepted from repo content.

## Vendor facts and limits

TypeSafe's privacy policy says inputs are not used to train/fine-tune models, may be handled by service providers, can be retained as reasonably necessary, and are hosted in the US. This is not a zero-retention guarantee. The legal docs offer enterprise ZDR, not an assumed property of this account. Review the applicable agreement and verified account settings before activation or a material scope change. [Privacy policy](https://typesafe.ai/legal/privacy-policy), [legal hub](https://docs.typesafe.ai/legal), [data processing addendum](https://typesafe.ai/legal/data-processing).

Public documentation is not proof of the user's contractual retention tier. No account console or agreement acceptance occurred here. Record contract/version, retention basis, region, approved fields and purpose in the release receipt, without storing credentials or source payloads.

## Threat model

| Threat | Required control / test |
|---|---|
| Prompt injection in current text, skill, note, page or source | Treat all state as untrusted evidence, stable trusted questions outside it. Test direct, quoted, encoded and role-spoofed attacks. No classifier result can authorize tools or promote instructions. |
| Confident wrong answer or option-order bias | Closed options, explicit applicability/abstention, frozen thresholds, reordered-option tests, holdout calibration. Human/generative review for ambiguous reasoning. |
| Cross-project leakage | Filter scope before state construction. Cache includes scope and source revisions. No catalog/paths from unrelated projects. |
| Stale source or delayed result | Validate digest/revision and turn ID immediately before consuming; stale/cancelled work is discarded. |
| Cost/rate-limit denial of service | Pre-reserved root budgets, caps and circuit breaker; no repo-controlled question fan-out or retry storms. |
| Diagnostics leaking source text | SDK logs off; normalized exception categories only; content-free telemetry and synthetic canary tests inspect all logging sinks. |
| Privacy toggle race | Disable aborts active request when possible and rejects late result, clears cache, prevents new calls. Already-transmitted vendor data cannot be recalled by a local toggle. |
| Probability treated as proof | Local provenance, protected-path fence, resource policy, permission engine and executed receipts are independent and unconditional. |
| Poisoned memory/promotion | Existing source links, uncertainty, correction chain, human reviews and signed promotion gates survive; Jev supplies a hint only. |

TypeSafe explicitly documents adversarial state, distracting context, counting/date arithmetic and option-order weaknesses. These motivate independent controls, not a claim of immunity. [Model jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Authority invariants

Jev cannot grant permission, change project trust, select unrestricted sandbox mode, authorize sending information, run a tool, accept an agreement, mark code tests passed, complete an investigation, establish a person's identity, suppress a safety warning, mutate a durable memory or learn a new policy. Main's `PermissionEngine`, `ResourcePolicy`, `ProtectedPaths`, hook checks, session/source validators, investigation verifier and learning/librarian gates remain the source of operational truth. An explicit user instruction overrides an advisory workflow label but does not bypass safety.

The configured generative provider receiving verified recall excerpts is a separate data flow from TypeSafe receiving current-request state. One provider's authorization cannot be inferred from the other's. Model hints never create new background schedules, outgoing communications or webhook subscriptions.

## Retention and deletion

No new raw archive or persistent decision-payload cache. Keep existing canonical source retention unchanged. Classification events reference sources without copying text. Forget/delete/source invalidation removes derived eligibility and cache entries according to existing subsystem semantics, not a model judgment. Aggregate operational meters may remain under documented retention but must not identify memory content. User-visible disable and per-feature scope revocation must work without network access. Disclose the limit: removing local data does not establish deletion at the vendor.
