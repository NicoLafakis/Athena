# Provider mapping guides

The app agent must read the relevant provider guide before instrumenting a call site. Provider SDK response shapes change; confirm the current SDK/API documentation before adding a field and record the documentation URL and date in the VMP pricing registry.

- `anthropic.md`: disjoint input, cache-read, cache-write, output, and hosted-tool meters.
- `openai.md`: inclusive prompt/completion totals plus cached/reasoning subsets.
- `gemini.md`: prompt/cached/thought/output tokens and grounding/tool metadata where supplied.
- `kimi.md`: usage fields when returned; plan/included usage must be recorded as usage but marked non-billable when no monetary rate exists.
