# CLI contract repair design

See [the specification and tasks](SPEC.md).

## Shared flow

```text
parsed child definition -> validated effective limits -> existing Engine/RunBudget
user input -> prompt hook -> explicit terminal result -> events + CLI exit
tool input -> hook validation -> canonical action -> policy -> pending consent
                                                        -> execution
pending consent -> local safe details -> fresh decision for same request
tool events -> retained transcript -> local reader -> return to prior anchor
composer/menu state -> physical-row layout -> visible controls own keyboard
```

## Ownership and interfaces

Engine owns effective actions and PermissionRequest identity. Presentation owns
safe local detail navigation, never execution or policy. Memory owns one canonical
resolver reused by the gate and execution; implicit index writes are included in
that scope. Preserve resource-policy and protected-path denial precedence.

Extend existing contracts additively where feasible. Use existing error status with
an explicit blocked reason if this avoids unnecessary envelope migration. A detail
view cannot resolve permission; closing it returns to the same pending request.
Session grants are calculated once by a shared function and shown exactly.

Transcript inspection owns transient selection/search/page state. It reads retained
entries and never sends a model prompt. Export is explicit and reports errors.
It does not pretend to recover upstream-discarded bytes. Keep raw output out of
new telemetry. Render terminal controls safely; redact obvious credential fields
and values with a visible marker where details could reveal secrets.

## Decisions and alternatives

Extend existing controller/presentation seams rather than create a second workflow
engine. Prefer shared row/text functions to parallel estimates. Prefer bounded local
paging to unbounded expanded cards, which can invalidate fullscreen budgets.
Keep ordinary draft buffering but give consent a fresh-input operation; draining all
input globally would lose ordinary prompts. Preserve existing permission IDs and
validate responses against the active request.

## Verification and rollout

Each task follows red test -> minimal fix -> green focused suite -> independent
review. Regression tests must exercise composition rather than only hand-made
objects. Use real filesystem links and subprocesses where supported. Terminal tests
inspect every frame's content, not row count alone. No new paid API or schema work.

One topic PR contains the integrated phases. Stage explicit paths, record tree ID,
run typecheck/lint/test/build sequentially, then commit without edits and compare
tree IDs. Wait for all six OS/Node CI jobs. Roll back through an ordinary revert;
no stored-session schema migration is planned. Real terminal and assistive-technology
acceptance is separately reported, not inferred from CI.


## Implemented boundaries

Child definition overrides are validated before run creation and omit undefined
values. Whole-task accounting remains out of scope. A denied UserPromptSubmit hook
uses the existing error result with an explicit blocked reason and still emits
turn-done. Zero-model-call headless results do not replay an older assistant answer.

Permission details use one shared safe text model and the same session-rule function
as execution. File revision fingerprints are checked after interactive approval,
before any session grant or execution. This detects changes during review; it is not
a filesystem transaction and does not eliminate a hostile filesystem race after the
check. Terminal sanitization marks recognized credentials but is not a universal
secret classifier. Existing source/model/tool output limits still apply.

The effective-input event updates tool inspection after hook normalization; older
saved transcript entries are explicitly labeled as recorded proposed arguments.
The reader uses existing transcript content, no new persistent output store. Explicit
exports use a new temporary directory/file with restrictive mode on platforms that
support it; OS/user temp cleanup owns retention. Export failure is visible.
