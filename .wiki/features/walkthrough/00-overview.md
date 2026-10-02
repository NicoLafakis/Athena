# Athena 3D walkthrough

A storybook-style, cutaway 3D house that explains Athena to people who have never built a command-line tool over a language model. One room per idea. Lives entirely in [`walkthrough/`](../../../walkthrough/); no existing Athena source is touched.

- **Live:** https://athena-walkthrough.vercel.app (a standalone static Vercel project named `athena-walkthrough`, deployed from the `walkthrough/` folder, not connected to the app build).
- **Two modes:** Tour (about 5 minutes, 7 stops plus a pull-back finale, 12 seconds per caption) and Explore (orbit, tap objects for captions, house-plan map).
- **Rooms:** front door (you type), study (the model thinks), tool wall (it can act), gatekeeper's lodge (permissions and trust), notebook room (memory, journal, key drawer), workshop annex (plugins), balcony (voice). Sources: `permissions-trust`, `credential-storage`, `self-reflection-journal`, `blind-first-jarvis`.

## Files

- `walkthrough/content.js`: every word shown to the visitor. Edit copy here only. Plain language, no jargon.
- `walkthrough/scene.js`: the house, props, characters (owl with olive-leaf crown is the one Athena nod).
- `walkthrough/app.js`: camera, Tour/Explore, captions, house plan, picking.
- `walkthrough/vendor/three/`: vendored three.js (MIT) plus OrbitControls, so the page needs no build step and no network. Excluded from lint in `eslint.config.js`.

## Rules for changes

- Keep the content in step with the product: when a room's mechanism changes (permissions, journal, voice, plugins), update `content.js` in the same commit (AGENTS.md section 9).
- Reduced-motion: the tour becomes manual (Next/Back), camera cuts instead of gliding, ambient motion stops.
- Phone: captions become a bottom sheet; the scene is shifted into the free area above it.
- No WebGL: a plain list of the same captions is shown instead.
- Redeploy: copy `walkthrough/` to a clean folder and run `vercel deploy --prod --scope nicos-projects-896b6ff8`. `window.__walk.tick(seconds)` advances time for automated checks when the browser throttles hidden tabs.
