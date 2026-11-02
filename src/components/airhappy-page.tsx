import type { ReactNode } from "react";

/**
 * AirHappy launch pages (Support, Privacy Policy). These are the URLs the App Store listing
 * points at, so they stand on their own: no sign-in, no watchlist chrome, readable without
 * JavaScript once rendered.
 */

export const AIRHAPPY = {
  name: "AirHappy",
  publisher: "BBCVC LLC",
  question: "When is it safe to be outside today?",
  /** Mailbox on airhappy.app. Must exist and be read before the listing is submitted. */
  supportEmail: "support@airhappy.app",
  monthlyUsd: "1.99",
  yearlyUsd: "12.99",
} as const;

export function AirHappyPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pt-[calc(env(safe-area-inset-top,0px)+1.5rem)] pb-16">
      <header className="mb-8 space-y-2">
        <p className="text-sm font-medium tracking-wide text-aqi-good">{AIRHAPPY.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-fg">{title}</h1>
        {updated ? <p className="text-sm text-muted">Last updated {updated}</p> : null}
      </header>
      <div className="space-y-8 text-[15px] leading-relaxed text-fg/90">{children}</div>
      <footer className="mt-12 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-6 text-sm text-muted">
        <a className="hover:text-fg hover:underline" href="/support">
          Support
        </a>
        <a className="hover:text-fg hover:underline" href="/privacy">
          Privacy Policy
        </a>
        <a className="hover:text-fg hover:underline" href={`mailto:${AIRHAPPY.supportEmail}`}>
          {AIRHAPPY.supportEmail}
        </a>
        <span>© 2026 {AIRHAPPY.publisher}</span>
      </footer>
    </main>
  );
}

export function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3">
      <h2 className="text-lg font-semibold tracking-tight text-fg">{title}</h2>
      {children}
    </section>
  );
}

export function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 marker:text-subtle">{children}</ul>;
}

export function MailLink({ subject }: { subject?: string }) {
  const href = subject
    ? `mailto:${AIRHAPPY.supportEmail}?subject=${encodeURIComponent(subject)}`
    : `mailto:${AIRHAPPY.supportEmail}`;
  return (
    <a className="font-medium text-fg underline underline-offset-4" href={href}>
      {AIRHAPPY.supportEmail}
    </a>
  );
}
