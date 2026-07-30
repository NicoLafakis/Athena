# Kimi

Kimi/Moonshot responses may expose input and output usage, but deployment plans can also include usage that is not billed per token. Capture all returned usage as meters. Use `pricing_status: "not_billable"` and cost `0` only when the plan explicitly makes that usage included; use `unpriced` and cost `null` when no current monetary rate is known.

Do not infer a token price from an app subscription price. Keep Kimi and Kimi Code as distinct provider identifiers when their billing semantics differ.
