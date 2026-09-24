# Reliable Transcript Reading — Risk Register

> [Objective overview](00-overview.md) · [PRD](prd.md)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ink redraw or terminal-specific behavior still clears scrollback | Medium | High | Prototype in actual terminals; assert output sequences and manually verify streaming scroll position before choosing architecture |
| Separating live text from finalized rows duplicates or drops streamed deltas | Medium | High | Define a single transition from mutable live entry to finalized record; test many small deltas and turn boundaries |
| Normal terminal scrollback has a configured retention limit | High | Medium | State the limit; provide active-session search over complete stored records |
| Search omits tool progress or child-agent output not stored in session records | Medium | Medium | Audit persistence before claims; search only canonical stored content and mark transient events unavailable |
| Search over long tool results is slow or floods the terminal | Medium | Medium | Measure against fixture; bound snippets and paginate |
| Search output executes embedded terminal controls | Low | High | Sanitize control sequences and test malicious ANSI/OSC-shaped text |
| User changes working tree contain concurrent documentation or code work | Current | High | Limit edits to this feature folder and the wiki index entry; preserve unrelated changes and do not commit them |
