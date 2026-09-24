# Reliable Transcript Reading — Risk Register

> [Objective overview](00-overview.md) · [PRD](prd.md)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A streaming entry growth moves the fullscreen reading position | Medium | High | Anchor to the first visible row and assert stability in a real Ink TTY integration test |
| Viewport clipping makes canonical transcript content unavailable | Low | High | Keep session records complete and treat viewport virtualization as render-only |
| An unclipppable tool card falls partly outside a page boundary | Medium | Medium | Keep tool cards whole and test page movement around oversized cards |
| Search omits tool progress or child-agent output not stored in session records | Medium | Medium | Audit persistence before claims; search only canonical stored content and mark transient events unavailable |
| Search over long tool results is slow or floods the terminal | Medium | Medium | Measure against fixture; bound snippets and paginate |
| Search output executes embedded terminal controls | Low | High | Sanitize control sequences and test malicious ANSI/OSC-shaped text |
| User changes working tree contain concurrent documentation or code work | Current | High | Limit edits to this feature folder and the wiki index entry; preserve unrelated changes and do not commit them |
