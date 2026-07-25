# Non-Functional Budgets

| Resource | Default/ceiling |
|---|---:|
| Interactive model calls | 200 |
| Interactive tool calls | 1,000 |
| Interactive tokens | 10,000,000 |
| Interactive cost | USD 50 |
| Interactive duration | 4 hours |
| `athena exec` model calls | 50 |
| `athena exec` tool calls | 200 |
| `athena exec` tokens | 2,000,000 |
| `athena exec` cost | USD 10 |
| `athena exec` duration | 30 minutes |
| Child concurrency | 2 effective in CLI wiring |
| Hook default timeout | 60 seconds |
| MCP connect timeout | 15 seconds |
| Default MCP output | 100,000 characters |
| Learning process output | 200,000 characters |
| Candidate patch | 2,000,000 characters |
| Live canary cost | USD 0.05 |
| Live canary duration | 120 seconds |

CLI callers can lower most run budgets. Raising a headless budget is always an
explicit argument. Output caps truncate or fail; they do not continue accumulating
unbounded in memory.
