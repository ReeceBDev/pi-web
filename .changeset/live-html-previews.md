---
"@jmfederico/pi-web": patch
---

Render HTML files live in the Files viewer: previews run the page's scripts and load its CDN assets from a blob URL inside an opaque-origin sandboxed frame (`allow-scripts`, no same-origin access to the app), and HTML files default to Preview instead of raw source. Open ↗ hands the same sandboxed document a standalone window via a script-free wrapper page instead of the script-killing server preview URL.
