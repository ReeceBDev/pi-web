/* Native push only: no fetch handler, offline cache, or session content. */
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function chatUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const scope = new URL(self.registration.scope);
    if (url.origin !== scope.origin || url.pathname !== scope.pathname || url.username || url.password || url.hash) return null;
    const keys = ["machine", "project", "workspace", "session", "view"];
    if ([...url.searchParams.keys()].length !== keys.length || keys.some((key) => url.searchParams.getAll(key).length !== 1)) return null;
    if (url.searchParams.get("machine") !== "local" || url.searchParams.get("view") !== "chat") return null;
    if (["project", "workspace", "session"].some((key) => !url.searchParams.get(key) || url.searchParams.get(key).length > 512 || /[\u0000-\u001f\u007f]/.test(url.searchParams.get(key)))) return null;
    return url.href;
  } catch { return null; }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data?.json(); } catch { data = undefined; }
    // Ignore provider-supplied text; lockscreen text is always generic.
    await self.registration.showNotification("PI WEB", {
      body: "A session update is ready.",
      data: { url: chatUrl(data?.url) },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = chatUrl(event.notification.data?.url) ?? self.registration.scope;
    const scope = new URL(self.registration.scope);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      const current = new URL(client.url);
      if (current.origin !== scope.origin || !current.pathname.startsWith(scope.pathname)) continue;
      try {
        const navigated = await client.navigate(url);
        if (navigated !== null) { await navigated.focus(); return; }
      } catch { /* A closed window must not prevent the safe open fallback. */ }
    }
    const opened = await self.clients.openWindow(url);
    await opened?.focus();
  })());
});
