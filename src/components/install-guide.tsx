import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Home,
  MoreHorizontal,
  Share,
  Smartphone,
  SquarePlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DISMISS_KEY = "aether-install-guide-dismissed-v1";

type Platform = "ios" | "android" | "desktop";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    return "ios";
  }
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches
  );
}

const SHARE_BLURB = `🌬️ Air Quality Watchlist
Track US AQI for the places you care about.

Open in Safari → Share → Add to Home Screen

https://aether-aqi.vercel.app`;

const IOS_STEPS = [
  {
    icon: Share,
    title: "Open in Safari",
    body: "If you’re in Messages or another app, tap the link, then open it in Safari (not an in-app browser).",
  },
  {
    icon: Share,
    title: "Tap Share",
    body: "Tap the Share button at the bottom of Safari (square with an upward arrow).",
  },
  {
    icon: SquarePlus,
    title: "Add to Home Screen",
    body: "Scroll the sheet and tap “Add to Home Screen”, then tap Add. The 42 AQI icon appears on your Home Screen.",
  },
] as const;

const ANDROID_STEPS = [
  {
    icon: MoreHorizontal,
    title: "Open the menu",
    body: "In Chrome, tap the ⋮ menu in the top-right of the browser.",
  },
  {
    icon: Home,
    title: "Install app",
    body: "Tap “Install app” or “Add to Home screen”, then confirm. Launch from your app drawer like any app.",
  },
] as const;

const DESKTOP_STEPS = [
  {
    icon: Smartphone,
    title: "Best on your phone",
    body: "Open aether-aqi.vercel.app in Safari (iPhone) or Chrome (Android) for the full installable experience.",
  },
  {
    icon: Share,
    title: "iPhone: Share → Add to Home Screen",
    body: "In Safari, tap Share, then “Add to Home Screen” for a one-tap Home Screen app.",
  },
] as const;

function StepCard({
  step,
  index,
  icon: Icon,
  title,
  body,
}: {
  step: number;
  index: number;
  icon: typeof Share;
  title: string;
  body: string;
}) {
  return (
    <li
      className={cn(
        "relative flex gap-3 rounded-2xl border border-border bg-surface-2/60 p-3.5",
        "shadow-sm shadow-black/20",
      )}
    >
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl",
          "bg-gradient-to-br from-aqi-good/25 to-aqi-good/5",
          "ring-1 ring-aqi-good/30",
        )}
        aria-hidden
      >
        <Icon className="size-5 text-aqi-good" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-fg/10 text-[10px] font-semibold tabular text-muted">
            {step}
          </span>
          <p className="text-sm font-semibold text-fg">{title}</p>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>
      </div>
      {index === 0 && (
        <span className="sr-only">Step {step}</span>
      )}
    </li>
  );
}

/**
 * Visual “save to Home Screen” guide — shown in-browser only (hidden when
 * already installed as a PWA). Dismissible; platform-aware steps.
 */
export function InstallGuide({ className }: { className?: string }) {
  const [platform, setPlatform] = useState<Platform>("desktop");
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isStandalone()) {
      setVisible(false);
      return;
    }
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") {
        setVisible(false);
        return;
      }
    } catch {
      /* private mode */
    }
    setPlatform(detectPlatform());
    setVisible(true);
    // Auto-expand on iOS — that’s where Home Screen install matters most
    if (detectPlatform() === "ios") setExpanded(true);
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setVisible(false);
  }

  async function copyShareBlurb() {
    try {
      await navigator.clipboard.writeText(SHARE_BLURB);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  if (!visible) return null;

  const steps =
    platform === "ios"
      ? IOS_STEPS
      : platform === "android"
        ? ANDROID_STEPS
        : DESKTOP_STEPS;

  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-border",
        "bg-gradient-to-br from-surface via-surface to-aqi-good/10",
        "shadow-lg shadow-black/25",
        className,
      )}
      aria-label="Install on Home Screen"
    >
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl",
            "bg-[#0c0f12] ring-1 ring-border-strong shadow-md",
          )}
        >
          <img
            src="/apple-touch-icon.png"
            alt=""
            width={48}
            height={48}
            className="size-12 object-cover"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-aqi-good">
            Get the app feel
          </p>
          <h2 className="mt-0.5 text-base font-semibold tracking-tight text-fg sm:text-lg">
            Add to your Home Screen
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted sm:text-sm">
            {platform === "ios"
              ? "Works like a native app — full screen, one tap from your Home Screen. Takes about 10 seconds in Safari."
              : platform === "android"
                ? "Install from Chrome for a full-screen app icon on your home screen."
                : "On iPhone, open this site in Safari and use Share → Add to Home Screen."}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-lg p-1.5 text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          aria-label="Dismiss install guide"
        >
          <X className="size-4" />
        </button>
      </div>

      {expanded && (
        <ol className="space-y-2 border-t border-border/80 px-4 py-3 sm:px-5">
          {steps.map((s, i) => (
            <StepCard
              key={s.title}
              step={i + 1}
              index={i}
              icon={s.icon}
              title={s.title}
              body={s.body}
            />
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/80 px-4 py-3 sm:px-5">
        <Button
          type="button"
          size="sm"
          variant={expanded ? "secondary" : "default"}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Hide steps" : "Show steps"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void copyShareBlurb()}
          className="gap-1.5"
        >
          {copied ? (
            <Check className="size-3.5 text-aqi-good" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied!" : "Copy invite text"}
        </Button>
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto text-xs text-subtle underline-offset-2 hover:text-muted hover:underline"
        >
          Don’t show again
        </button>
      </div>
    </section>
  );
}

/** Plain text for pasting into Messages when you share the link. */
export function getInstallShareBlurb(): string {
  return SHARE_BLURB;
}
