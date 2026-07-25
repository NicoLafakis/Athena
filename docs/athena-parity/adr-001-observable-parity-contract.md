# ADR-001: Observable Parity Contract

**Status:** Accepted

## Decision

Athena will define parity as versioned observable scenarios, not shared feature
names or an assertion of identical proprietary internals. A scenario specifies
inputs, policy, durable events, outputs, limits, failure semantics, and platform.

Deliberate exclusions must be listed. New upstream features do not silently become
Athena release blockers; maintainers explicitly select them into the contract.

## Consequences

- Compatibility can be tested and regressed.
- Scores remain date- and scope-specific.
- Athena can preserve intentional extensions without misrepresenting product identity.
- Literal "same capabilities" remains false whenever a selected upstream workflow
  has no passing Athena scenario.
