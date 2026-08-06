import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthProvider } from "@/lib/auth/provider";
import { CreatedWithGrokBanner } from "@/components/created-with-grok-banner";
import appCss from "../styles.css?url";

const APP_NAME = "Air Quality Watchlist";
const APP_SHORT = "Air Quality";
const host = import.meta.env.VITE_PUBLIC_HOSTNAME;
const ogImage = host
  ? `https://og.grok.me/v1/card.png?host=${encodeURIComponent(host)}&title=${encodeURIComponent(APP_NAME)}`
  : undefined;

/**
 * Critical layout CSS inlined so the shell still works if a stale service worker
 * serves HTML without the hashed stylesheet (Safari symptom: left-stacked text,
 * bare Delete buttons, no card chrome).
 */
const CRITICAL_CSS = `
html{color-scheme:dark;max-width:100%;overflow-x:hidden;background:#0c0f12}
body{margin:0;min-height:100dvh;max-width:100%;overflow-x:hidden;background:#0c0f12;color:#e8eaed;font-family:system-ui,-apple-system,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
*,*::before,*::after{box-sizing:border-box}
/*
 * Solid sticky band under the status bar / Dynamic Island so system clock
 * and app title never fight. Uses env(safe-area-inset-top) when available;
 * on phones we also force a minimum height because some Safari modes report 0.
 */
.aqi-status-bar{
  position:sticky;
  top:0;
  z-index:300;
  width:100%;
  flex-shrink:0;
  background:#0c0f12;
  /* iOS 11.0–11.2 */
  height:constant(safe-area-inset-top);
  /* modern */
  height:env(safe-area-inset-top, 0px);
}
@media screen and (max-width: 768px){
  .aqi-status-bar{
    /* Dynamic Island / notch: never less than ~59px even if env is 0 */
    min-height:59px;
    height:max(59px, env(safe-area-inset-top, 0px));
  }
}
@media screen and (min-width: 769px){
  .aqi-status-bar{display:none}
}
.aqi-app-frame{
  min-height:calc(100dvh - var(--grok-banner-h, 0px));
  max-width:100vw;
  overflow-x:hidden;
  padding-top:var(--grok-banner-h, 0px);
}
.aqi-shell{
  width:100%;
  max-width:64rem;
  margin:0 auto;
  min-width:0;
  display:flex;
  flex-direction:column;
  gap:1.5rem;
  padding-top:1rem;
  padding-right:max(1rem, env(safe-area-inset-right, 0px));
  padding-bottom:max(4rem, env(safe-area-inset-bottom, 0px));
  padding-left:max(1rem, env(safe-area-inset-left, 0px));
}
.aqi-grid{display:grid;gap:.75rem;grid-template-columns:1fr;min-width:0;width:100%}
@media(min-width:640px){.aqi-grid{grid-template-columns:1fr 1fr}}
@media(min-width:1024px){.aqi-grid{grid-template-columns:1fr 1fr 1fr}}
.aqi-card{position:relative;width:100%;min-width:0;max-width:100%;overflow:hidden;border-radius:1.5rem}
.aqi-card-surface{position:relative;z-index:1;display:flex;width:100%;min-width:0;flex-direction:column;gap:.75rem;padding:1.25rem;text-align:left;border:1px solid #27303a;border-radius:1.5rem;background:#14191f;user-select:none}
.aqi-card-delete{position:absolute;inset:0 0 0 auto;z-index:0;display:flex;width:88px;align-items:stretch}
.aqi-card-delete button{display:flex;width:100%;flex-direction:column;align-items:center;justify-content:center;gap:.25rem;border:0;background:#e23d3d;color:#fff;cursor:pointer;font:inherit}
.aqi-add-tile{display:flex;width:100%;min-height:148px;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;padding:1.25rem;border:1px dashed #27303a;border-radius:1.5rem;background:rgba(20,25,31,.4);color:#8b949e;font:inherit;cursor:pointer}
`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: APP_NAME },
      {
        name: "description",
        content:
          "Track and forecast US Air Quality Index for up to 15 locations. Installable PWA with hourly and daily forecasts.",
      },
      { name: "theme-color", content: "#0c0f12" },
      { name: "color-scheme", content: "dark" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      },
      { name: "apple-mobile-web-app-title", content: APP_SHORT },
      { name: "application-name", content: APP_SHORT },
      { name: "format-detection", content: "telephone=no" },
      ...(ogImage
        ? [
            { property: "og:image", content: ogImage },
            { property: "og:image:width", content: "1200" },
            { property: "og:image:height", content: "630" },
            { property: "og:title", content: APP_NAME },
          ]
        : []),
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { rel: "icon", href: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
        sizes: "180x180",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon-167.png",
        sizes: "167x167",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon-152.png",
        sizes: "152x152",
      },
    ],
    styles: [{ children: CRITICAL_CSS }],
  }),
  component: RootDocument,
});

function resetDocumentChrome() {
  const html = document.documentElement;
  const body = document.body;
  const top = body.style.top;
  body.style.position = "";
  body.style.top = "";
  body.style.left = "";
  body.style.right = "";
  body.style.width = "";
  body.style.overflow = "";
  body.style.touchAction = "";
  body.style.userSelect = "";
  body.style.overscrollBehavior = "";
  html.style.overflow = "";
  html.style.overscrollBehavior = "";
  window.scrollTo(0, 0);
  if (top) {
    // ignore previous fixed offset — always start at top after recovery
  }
}

async function nukeServiceWorkersAndCaches() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    /* ignore */
  }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
}

/**
 * Detect unstyled shell (Tailwind utilities not applied) and force a clean load.
 * Keyed so we only auto-recover once per session.
 */
function stylesAreBroken(): boolean {
  const probe = document.createElement("div");
  probe.className = "flex bg-surface";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const broken = cs.display !== "flex";
  probe.remove();
  return broken;
}

function RootDocument() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    resetDocumentChrome();

    // Install cleanup SW (unregisters itself + clears caches), then stop using SW.
    const run = async () => {
      try {
        if ("serviceWorker" in navigator) {
          // Register cleanup worker so existing controllers tear down.
          await navigator.serviceWorker
            .register("/sw.js", { updateViaCache: "none" })
            .catch(() => null);
          // Also proactively unregister any controllers after a beat.
          window.setTimeout(() => {
            void nukeServiceWorkersAndCaches();
          }, 2500);
        }
      } catch {
        /* ignore */
      }

      // If the hashed stylesheet never applied, hard-recover once.
      window.setTimeout(() => {
        try {
          if (!stylesAreBroken()) return;
          const key = "aether-style-recover-v1";
          if (sessionStorage.getItem(key) === "1") return;
          sessionStorage.setItem(key, "1");
          void nukeServiceWorkersAndCaches().then(() => {
            const url = new URL(window.location.href);
            url.searchParams.set("_recovered", String(Date.now()));
            window.location.replace(url.toString());
          });
        } catch {
          /* ignore */
        }
      }, 400);
    };

    void run();

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "AETHER_SW_CLEARED") {
        window.location.reload();
      }
    };
    navigator.serviceWorker?.addEventListener?.("message", onMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener?.("message", onMessage);
    };
  }, []);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Duplicate critical CSS in body-adjacent head slot for older SW shells */}
        <style dangerouslySetInnerHTML={{ __html: CRITICAL_CSS }} />
      </head>
      <body className="max-w-[100vw] overflow-x-hidden bg-bg text-fg antialiased">
        {/* Opaque band under status bar / Dynamic Island (readable clock + title) */}
        <div className="aqi-status-bar" aria-hidden="true" />
        <CreatedWithGrokBanner />
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <div className="aqi-app-frame">
              <Outlet />
            </div>
          </QueryClientProvider>
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}
