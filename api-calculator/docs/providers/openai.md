# OpenAI

Map the response usage object as follows:

| Usage field | Meter | Rule |
|---|---|---|
| `prompt_tokens` | `prompt_total` | Inclusive total |
| `prompt_tokens_details.cached_tokens` | `cache_read` | Subset of prompt total |
| `completion_tokens` | `completion_total` | Inclusive total |
| `completion_tokens_details.reasoning_tokens` | `reasoning` | Subset of completion total |

Never add cached or reasoning meters to the inclusive totals. Capture tool calls and request status separately from token meters.
