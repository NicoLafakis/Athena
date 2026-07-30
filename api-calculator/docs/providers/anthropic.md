# Anthropic

Map `response.usage` as follows:

| Usage field | Meter | Rule |
|---|---|---|
| `input_tokens` | `input_uncached` | Separate billable class |
| `cache_read_input_tokens` | `cache_read` | Separate billable class |
| `cache_creation_input_tokens` | `cache_write` | Separate billable class |
| `output_tokens` | `output` | Separate billable class |
| `server_tool_use.web_search_requests` | `web_search_requests` | Request meter |
| `server_tool_use.web_fetch_requests` | `web_fetch_requests` | Request meter |

Do not sum cache classes into `input_tokens`; Anthropic's classes are disjoint. Preserve `service_tier` and report hosted tools even when token usage is zero.
