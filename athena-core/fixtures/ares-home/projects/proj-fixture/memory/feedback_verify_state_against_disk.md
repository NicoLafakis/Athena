---
name: verify-state-against-disk-not-summaries
description: "Before asserting the current state of any system, verify against the live artifact on disk — recalled memories and handed-forward summaries are fallible leads, not ground truth."
metadata:
  node_type: memory
  type: feedback
---

**Trigger:** About to assert a factual claim about the *current state* of a system, sourced from a handed-forward summary or a recalled memory rather than the live artifact.

**Rule:** Treat every handed-forward summary as a point-in-time lead, never ground truth. Open the actual artifact before stating state as fact. If the user pushes back, go to disk immediately.

(Trimmed fixture copy of the real `feedback_verify_state_against_disk` memory for keyless Phase 2 tests.)
