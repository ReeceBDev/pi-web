import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import type { FastifyInstance, FastifyReply } from "fastify";

const PROBE_BATCH_LIMIT = 100_000;

// Scroll/touch diagnosis for the Android launcher bug: records compositor
// samples, scroll events, and touch streams so frozen-vs-yanked scrolling is
// provable on a real device without USB. Batches post every 2s and drop on
// failure (never retry-storms). ponytail: 200ms polling + an unauthenticated
// size-capped write endpoint are fine for a temporary diagnosis; remove this
// module when the scroll ticket closes.
const PROBE_JS = `
(function () {
  var events = [];
  var t0 = Date.now();
  function ev(type, extra) {
    if (events.length >= 500) return;
    var e = { t: Date.now() - t0, type: type };
    if (extra) { for (var k in extra) { e[k] = extra[k]; } }
    events.push(e);
  }
  ev("boot", { ua: navigator.userAgent, href: location.href });

  var scroller = null;
  var lastScan = 0;
  function findScroller() {
    if (scroller && scroller.isConnected && scroller.scrollHeight - scroller.clientHeight > 100) return scroller;
    var now = Date.now();
    if (now - lastScan < 5000) return null; // ponytail: backoff — a full-DOM rescan every 200ms lagged a Galaxy A70 badly
    lastScan = now;
    var best = null, bestH = 0;
    document.querySelectorAll("*").forEach(function (el) {
      var oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight - el.clientHeight > 100 && el.scrollHeight > bestH) {
        best = el; bestH = el.scrollHeight;
      }
    });
    scroller = best || document.scrollingElement || document.documentElement;
    return scroller;
  }

  setInterval(function () {
    var s = findScroller();
    if (s) ev("s", { y: Math.round(s.scrollTop), sh: s.scrollHeight, ch: s.clientHeight });
  }, 200);

  ["touchstart", "touchmove", "touchend"].forEach(function (name) {
    document.addEventListener(name, function (d) {
      var t = d.touches[0] || d.changedTouches[0];
      ev(name, t ? { x: Math.round(t.clientX), y: Math.round(t.clientY), n: d.touches.length } : {});
    }, { capture: true, passive: true });
  });

  window.addEventListener("scroll", function () {
    var s = scroller || findScroller();
    if (s) ev("scroll", { y: Math.round(s.scrollTop) });
  }, { capture: true, passive: true });

  setInterval(function () {
    if (!events.length) return;
    var batch = events;
    events = [];
    fetch("/__probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ua: navigator.userAgent, href: location.href, events: batch }),
      keepalive: true,
    }).catch(function () { events = batch.concat(events).slice(0, 500); });
  }, 2000);
})();
`;

export function registerScrollProbe(app: FastifyInstance, logFile = "/tmp/pi-web-scroll-probe/events.ndjson"): void {
  const withProbe = (html: string) => html.includes("</body>")
    ? html.replace("</body>", '<script src="/__probe.js"></script></body>')
    : `${html}<script src="/__probe.js"></script>`;

  const asHtmlString = async (reply: FastifyReply, payload: unknown): Promise<string | undefined> => {
    if (!String(reply.getHeader("content-type") ?? "").includes("text/html")) return undefined;
    if (typeof payload === "string") return payload;
    if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
    if (payload instanceof Readable) return text(payload);
    return undefined;
  };

  // Inject into every app-shell response (the static plugin streams index.html
  // for / and the SPA fallback, so routing around it is not worth the fight).
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.split("?")[0] !== "/") return payload;
    const html = await asHtmlString(reply, payload);
    return html === undefined ? payload : withProbe(html);
  });

  app.get("/__probe.js", async (_request, reply) => {
    return reply.header("cache-control", "no-store").type("application/javascript; charset=utf-8").send(PROBE_JS);
  });

  app.post("/__probe", async (request, reply) => {
    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    if (body.length > PROBE_BATCH_LIMIT) return reply.code(413).send({ error: "probe batch too large" });
    await mkdir(dirname(logFile), { recursive: true });
    await appendFile(logFile, `${body}\n`);
    return { ok: true };
  });
}
