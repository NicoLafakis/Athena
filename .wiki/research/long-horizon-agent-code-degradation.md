# Long-Horizon Coding Agent Degradation: A Literature Review with an Athena Mapping

> **Provenance**
> - **Research date:** 2026-10-13.
> - **Method:** Checks were made at arXiv abstract level and by web search. Full texts were not read.
> - **Grades:** Each source carries a grade. An entry can carry two grades when its parts differ, and the entry says which part each grade covers.
>   - **Verified (abstract):** the arXiv identifier and the stated figures or claims were checked against the abstract page.
>   - **Secondary:** taken from a secondary source and not confirmed against the paper.
>   - **Unverified:** no source was found. Kept only as stated practitioner opinion.
> - Titles and author lists come from the arXiv abstract pages, checked 2026-10-13. Where an author list is not confirmed, the entry says so.

---

## 1. Executive Summary

Coding agents that work for long sessions can produce changes that pass immediate checks while the repository's structure gets worse over time. Informal names for this include "AI code spaghetti" and "slop accumulation". The research literature uses terms such as "agentic entropy" and "agentic technical debt". This page reviews that literature, records how each source was checked, and maps the themes to Athena.

The quantitative findings in the verified sources are:

- **SlopCodeBench** (Orlanski et al., arXiv:2603.24755, v2): 15 agents, 36 problems, 196 checkpoints. The best agent passed 14.8% of checkpoints. Erosion rose in 77% of agent trajectories, against 53% of human repositories (the 53% is from the full-text version, not the abstract). Agent code was 2.3x more verbose and 2.0x more eroded than 473 open-source Python repositories.
- **Quality guidance** (same paper): explicit quality guidance cut initial verbosity and erosion by up to a third, without changing degradation rates.
- **AI-authored commits** (Liu et al., arXiv:2603.28592): 22.7% of tracked AI-introduced issues still survived at the latest repository version.
- **Building on agent code** (CodeThread, arXiv:2606.21804): the resolve rate dropped by up to 13.1% when building on agent-written code.

The theory in the verified sources comes from Storey's three layers of debt, Hydari et al.'s stock-and-flow split, and Li et al.'s constraint drift. Goda Go's framework is practitioner opinion. No transcript or video was located, so it is marked unverified throughout.

Section 5 maps these themes to Athena. Athena has written verification gates, append-only session logs, and a permission engine. Its known gaps include no tick-style bounded autonomous units, whole-summary compaction, and free-text memory hygiene that is still design only.

---

## 2. Goda Go's Discourse, Analysis, and Framework (Practitioner Opinion, Unverified)

Goda Go (`@godago`) is cited here as a practitioner. This section records her stated positions. It makes no biographical or credential claims. None of the four video titles below was located, so each position is recorded as stated, not as a checked fact.

### 2.1 The "65% Trap" and the Demo Mirage
Video: *"Agentic AI Engineer vs Vibe Coder (65% Trap)"* (not located). Her stated position:
- **Initial mirage (0% to about 65%):** LLMs help build a convincing prototype quickly. The project looks nearly finished because the interface renders and the happy path works.
- **The wall (65% to 100%):** the remaining work covers relational integrity, race conditions, edge-case failure handling, security boundaries, rate limits, and maintainability.
- **Collapse:** when the foundation was built by conversational prompting without an architectural model, late bug fixes can add localized patches that break unstated global assumptions.

### 2.2 "Spaghetti Code in a Suit" and the Amnesiac Intern
Source for the phrase: not located. Her stated position:
- **Human debt** is rushed shortcuts, messy syntax, missing comments, or hacky workarounds. It is visible, so it is easier to spot.
- **AI code spaghetti** is clean on the surface and comes with persuasive explanations. Underneath, it can hide circular dependencies, redundant abstractions, phantom state mutations, and duplicate utilities. She calls this "spaghetti code in a business suit."
- **The intern with amnesia:** in one long chat session, tool output such as compiler errors and diffs fills the context, and the agent loses earlier architectural agreements.

### 2.3 The 6-Pillar Framework
Video: *"Vibe Coding vs Real Development: The Framework"* (not located).

This table is a framing aid only. It summarizes a practitioner's framework and is not evidence that the framework works.

| Pillar | Vibe Coding Anti-Pattern | Agentic Engineering Standard |
| :--- | :--- | :--- |
| **1. PRD & Specifications** | Casual, conversational prompts ("add a user dashboard") | Strict requirements documents defining data models, user flows, and explicit out-of-scope boundaries before invoking the agent. |
| **2. Database & Data Architecture** | Ad-hoc in-memory stores or unindexed schema sprawl | Explicit relational schemas, migrations, typing, and constraint enforcement before business logic. |
| **3. Security & Boundary Guardrails** | Hardcoded secrets, unvalidated endpoints, blind script execution | Environment variable isolation, least privilege, and strict tool execution boundaries. |
| **4. Modular Architecture & Design** | Single massive files, copy-pasted handlers, god functions | Strict directory boundaries, bounded interface contracts, small file budgets, and UI component hierarchies. |
| **5. Infrastructure & Runtime Budgets** | Ignoring compute, memory, socket, and connection budgets | Documented non-functional requirements: memory limits, connection pools, and graceful degradation paths. |
| **6. Version Control & Reversible State** | Massive commits or unstaged dirty working trees | Small commits, branch isolation, and revert checkpoints after each verified task chunk. |

### 2.4 Multi-Agent Swarms vs. Bounded Single Loops
Video: *"I Replaced Multi-Agent Systems With This (You Should Too)"* (not located). Her stated position:
- Unbounded multi-agent swarms multiply tokens and compound errors. One agent's hallucination can be accepted as ground truth by the next.
- She advocates single capable execution loops against local tools, with the human acting as system architect and the agent bounded by verification gates.

A transcript or links to these videos would upgrade this section. Until then, treat it as one practitioner's stated positions.

---

## 3. Supporting ML Science & Software Engineering Literature

Each entry gives its arXiv identifier, its grade, and what the abstract states.

### 3.1 Empirical Degradation Benchmarks

- **SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks** (Gabriel Orlanski et al., arXiv:2603.24755, v2 dated 7 May 2026). Grade: Verified (abstract).
  - Setup: 15 agents, 36 problems, 196 checkpoints.
  - The best agent passes 14.8% of checkpoints.
  - Erosion rises in 77% of agent trajectories, against 53% of human repositories (the 53% is from the full-text version, not the abstract).
  - Verbosity rises in 75.5%.
  - Agent code is 2.3x more verbose and 2.0x more eroded than 473 open-source Python repositories.
  - Explicit quality guidance cuts initial verbosity and erosion by up to a third, without changing degradation rates.
  - The full text reportedly gives larger erosion reductions from quality guidance (up to 62.3%). This was not checked against the body.
  - Humans degrade less often and by smaller margins.
  - A secondary source reports earlier v1 figures of 80% and 89.8%. This page uses v2.

- **Debt Behind the AI Boom: A Large-Scale Empirical Study of AI-Generated Code in the Wild** (Yue Liu et al., arXiv:2603.28592). Grade: Verified (abstract).
  - Five AI assistants; 302.6k AI-authored commits across 6,299 GitHub repositories.
  - 484,366 distinct issues, of which 89.3% are code smells.
  - 22.7% of tracked AI-introduced issues still survive at the latest repository version.

- **Is Agent Code Less Maintainable Than Human Code?** (CodeThread; Shaswat Patel et al., arXiv:2606.21804). Grade: Verified (abstract).
  - Four frontier coding agents on four benchmarks.
  - The resolve rate drops by up to 13.1% when building on agent-written code.
  - Traditional maintainability metrics do not explain the difference.
  - The clearest signals are subtler behavioral differences, such as changes to input validation and error handling.

### 3.2 Theoretical Frameworks & Degradation Models

- **From Technical Debt to Cognitive and Intent Debt: Rethinking Software Health in the Age of AI** (Margaret-Anne Storey, sole author; arXiv:2603.22106). Grade: Verified (abstract). Three layers of debt:
  1. **Technical debt**, in the code.
  2. **Cognitive debt**, in people: eroded shared understanding across a team.
  3. **Intent debt**, in externalized knowledge: absent or eroded rationale, goals, and constraints.

- **Beyond the 'Diff': Addressing Agentic Entropy in Agentic Software Development** (Matteo Casserini, Alessandro Facchini, Andrea Ferrario; arXiv:2604.16323). Grade: Verified (abstract).
  - **Agentic entropy:** on the abstract page, "the accumulating divergence between agentic actions and architectural intent."
  - **Agentic technical debt:** not defined in the abstract.

- **Governing Technical Debt in Agentic AI Systems** (Muhammad Zia Hydari, Raja Iqbal, Narayan Ramasubbu; arXiv:2605.29129). Grade: Verified (abstract).
  - **Agentic technical debt (a stock):** liability from prompts, memory, tool schemas, orchestration graphs, control policies, and observability routines, patched together faster than they can be validated, standardized, and governed.
  - **Stochastic tax (a flow):** the recurring operating burden of keeping probabilistic agent behavior within acceptable bounds.

- **Safe Multi-Agent Behavior Must Be Maintained, Not Merely Asserted: Constraint Drift in LLM-Based Multi-Agent Systems** (Tianxiao Li et al.; arXiv:2605.10481). Grade: Verified (abstract).
  - **Constraint drift:** loss of the operational force of safety-critical constraints across a multi-agent trajectory.
  - The four-part binding test is described in Section 4.5.

---

## 4. Solutions & Architectural Patterns

The verified sources mostly describe the problem. The one intervention result among them is the quality-guidance finding in Section 3.1: explicit quality guidance reduces initial verbosity and erosion by up to a third, without changing degradation rates. The patterns below are therefore proposals. Each is tied to its source where one exists, and to Athena's practice in Section 5.

### 4.1 Hierarchical Ticks & Bounded Time-Scale Levels
Source: *An Architecture for Long-Horizon Agents: Levels, Ticks and Cascaded Intelligence* (Erik Nijkamp, Anurag Koul, Egor Pakhomov, Bo Pang; arXiv:2609.19519). Grade: Verified (abstract).
- Levels are indexed by time scale. Each level keeps a bounded file that summarizes the level below it.
- A clocked tick is the unit of autonomous action.
- Cascaded intelligence escalates to a more capable model only after the current model fails review.
- The paper reports a ten-day campaign that reproduced a published reinforcement-learning result, with one human check-in per day.
- This page's reading is that the bounded per-level summaries limit how much low-level detail reaches the top level. The abstract does not state this purpose.
- Athena has no tick-style bounded autonomous units (Section 5, known gaps).

### 4.2 Externalized State over Conversational Memory
Source: Storey (arXiv:2603.22106), intent debt layer. Grade: Verified (abstract).
- Storey places intent debt in externalized knowledge. When rationale, goals, and constraints are not written down, or erode, the project loses them.
- Proposed practice: keep specifications, task lists, and decision records in repository files, and have the agent read them from disk rather than rely on chat history.
- Athena's state files are listed in Section 5.

### 4.3 Ephemeral Subagent Contexts (Clean-Slate Execution)
Source for the Athena-relevant points: Dai Jiahong, as listed on arXiv (arXiv:2608.23953). Grade: Verified (abstract). No verified source tests the subagent pattern itself.
- Proposed practice: spawn short-lived subagents for individual tasks, give each one a scoped task contract and the relevant file paths, and return only a summary, so that earlier iterations do not accumulate in the parent's context.
- The Dai paper reviews three open harnesses (LangChain deepagents, Earendil pi, DeepSeek dsh). For this page, it supports three points only: an append-only, replayable session record; progressive disclosure of context; and explicit extension seams. It has no content on subagents.
- Athena's child agents are durable and resumable. [src/harness/agents.ts](../../src/harness/agents.ts) has a `resumedRunId` field. The terminate-after-pass pattern is not described as Athena's model. This page did not read Athena's default (non-resume) path, so it does not say what happens to a child agent that is not resumed.

### 4.4 Automated Multi-Gate Verification (CI Gates)
Source: *The End of Code Review: Coding Agents Supersede Human Inspection* (Martin Monperrus, sole author; arXiv:2606.13175; June 2026). Grade: Verified (abstract).
- The paper argues that agents can serve every stated goal of code review, at lower cost and higher throughput.
- It also argues that the setup in which agents write code and human review is mandatory gives neither meaningful assurance nor scale.
- The abstract proposes no gate pipeline. The gates below are Athena's own practice, not the paper's proposal.
- Athena's practice: typecheck, lint, test, and build are a written rule in [AGENTS.md](../../AGENTS.md) (section 6). A six-job CI matrix runs them on every push and every pull request ([.github/workflows/ci.yml](../../.github/workflows/ci.yml)). Athena has no git hooks and no pre-commit tooling, so a commit is not rejected at commit time.
- The lint step is narrower than a full static-analysis pipeline (Section 5).
- The Dai paper reports no convergence among its three harnesses on external verifiability.

### 4.5 Binding Tests & Deterministic Runtime Fences
Source: Li et al. (arXiv:2605.10481). Grade: Verified (abstract).

Li et al. test whether a rule still binds at decision time. That requires the rule to be:
- (a) reachable at decision time;
- (b) tied to the proposer of the action;
- (c) verifiable against what the action does;
- (d) traceable afterward.

This page's reading is that rules whose breach is costly should be enforced in code at the point of action, not left to model discretion or to natural-language instruction. The four parts above give a checklist for whether an enforcement mechanism actually binds the agent that proposes an action.

Athena example: a write fence and a permission engine enforce rules in code ([permissions and project trust](../architecture/permissions-trust.md)). The shell-command scan is best effort. Operating-system file permissions are the main defense (on Windows, ACLs). This review has not tested Athena's fences against the four parts.

---

## 5. Athena Mapping and Known Gaps

This section records what Athena does for each theme above, using the repository files linked. It is not an audit. The linked files are the place to check the current state.

- **State on disk.** Athena keeps project state in `AGENTS.md`, `ARCHITECTURE.md`, `STATUS.md`, and `.wiki/`. [AGENTS.md section 9](../../AGENTS.md) requires the wiki to match the code. This is the practice behind Section 4.2.
- **Verification gates.** The four gates (typecheck, lint, test, build) are a written rule in [AGENTS.md section 6](../../AGENTS.md). Enforcement is a six-job CI matrix that runs on every push and every pull request ([ci.yml](../../.github/workflows/ci.yml)). There are no git hooks and no pre-commit tooling, so a commit is not rejected at commit time.
- **Lint scope.** ESLint runs the typescript-eslint recommended rules plus two custom rules ([eslint.config.js](../../eslint.config.js)). See Known gaps for what it does not check.
- **Runtime fences.** A write fence and a permission engine enforce rules in code ([permissions and project trust](../architecture/permissions-trust.md)). The shell-command scan is best effort, and operating-system file permissions are the main defense. The fences enforce the rules they encode. Whether every constraint in a long session is covered has not been checked against the Section 4.5 test.
- **Sessions and extension seams.** Sessions are append-only logs. Extension seams exist for skills, hooks, MCP servers, and plugins ([README.md, Sessions and agents; Extensions](../../README.md)). These match the append-only and explicit-extension-seam points from the Dai paper (Dai Jiahong, arXiv:2608.23953). This page does not claim replayability.
- **Child agents.** Child agents are durable and resumable. [src/harness/agents.ts](../../src/harness/agents.ts) has a `resumedRunId` field ([README.md, Sessions and agents](../../README.md)). The terminate-after-pass pattern in Section 4.3 is not described as Athena's model. The default (non-resume) path was not read for this page.

### Known gaps

1. **Free-text memory hygiene** is still design only. See [memory hygiene](../architecture/memory-hygiene.md).
2. **Compaction** is whole-summary, per the 2026-07-26 completeness audit. This page did not re-verify it.
3. **No tick-style bounded autonomous units.** The clocked tick from Nijkamp et al. has no Athena equivalent.
4. **Intent debt** is only partly addressed. Provisional journal memory covers part of it. See [self-reflection journal](../architecture/self-reflection-journal.md).
5. **Lint scope:** there is no circular-import check, no dead-code check, and no file-size check.
6. **Gate timing:** CI runs the gates on every push and pull request. There are no git hooks or pre-commit checks, so a commit is not checked before it is made.
7. **Shell-command scan** is best effort. Operating-system file permissions are the main defense.
8. **Child agents:** the non-resume path was not read for this page.
9. **Constraint drift:** Athena's fences have not been assessed against the four-part binding test.

---

## 6. References & Key Citations

- **Orlanski et al.** *SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks*. arXiv:2603.24755 (v2, 7 May 2026). Grade: Verified (abstract).
- **Storey, M.-A.** *From Technical Debt to Cognitive and Intent Debt: Rethinking Software Health in the Age of AI*. arXiv:2603.22106. Grade: Verified (abstract).
- **Casserini et al.** *Beyond the 'Diff': Addressing Agentic Entropy in Agentic Software Development*. arXiv:2604.16323. Grade: Verified (abstract).
- **Hydari, Iqbal, Ramasubbu.** *Governing Technical Debt in Agentic AI Systems*. arXiv:2605.29129. Grade: Verified (abstract).
- **Li et al.** *Safe Multi-Agent Behavior Must Be Maintained, Not Merely Asserted: Constraint Drift in LLM-Based Multi-Agent Systems*. arXiv:2605.10481. Grade: Verified (abstract).
- **Nijkamp, Koul, Pakhomov, and Pang.** *An Architecture for Long-Horizon Agents: Levels, Ticks and Cascaded Intelligence*. arXiv:2609.19519. Grade: Verified (abstract).
- **Liu et al.** *Debt Behind the AI Boom: A Large-Scale Empirical Study of AI-Generated Code in the Wild*. arXiv:2603.28592. Grade: Verified (abstract).
- **CodeThread (Shaswat Patel et al.).** *Is Agent Code Less Maintainable Than Human Code?* arXiv:2606.21804. Grade: Verified (abstract).
- **Monperrus** (sole author, June 2026). *The End of Code Review: Coding Agents Supersede Human Inspection*. arXiv:2606.13175. Grade: Verified (abstract).
- **Dai Jiahong** (sole author, as listed on arXiv). *The Empire, Long Divided, Must Unite: Architectural Convergence in Three LLM Agent Harnesses*. arXiv:2608.23953 (dated 25 Aug 2026). Grade: Verified (abstract).
- **Goda Go (`@godago`).** Practitioner opinion. Grade: Unverified. None of these video titles was located:
  - *"Agentic AI Engineer vs Vibe Coder (65% Trap)"*
  - *"Vibe Coding vs Real Development: The Framework"*
  - *"I Replaced Multi-Agent Systems With This (You Should Too)"*
  - *"He Runs Claude Code and Codex as ONE System (You Can Too)"*
