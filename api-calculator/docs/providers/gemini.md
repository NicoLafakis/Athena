# Gemini

Gemini response usage shapes vary by SDK generation. Read the current response metadata and map fields by meaning, not by guessed names:

- prompt/input tokens → `prompt_total`;
- cached content tokens → `cache_read` (subset when the API defines it as such);
- candidates/output tokens → `completion_total`;
- thinking/reasoning tokens → `reasoning` (subset when documented);
- grounding/search/tool invocations → request meters with provider-specific canonical names.

Record the exact SDK/API version and source documentation used for the mapping. If a field's overlap semantics are unclear, store it as a separate meter and mark its price relationship unresolved rather than double-counting it.
