import { createFileRoute, Link } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Wind } from "lucide-react";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  return (
    <main className="grid min-h-[calc(100dvh-var(--grok-banner-h,0px))] place-items-center px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-[var(--radius-lg)] bg-surface-2 ring-1 ring-border">
            <Wind className="size-5 text-muted" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Aether</h1>
          <p className="text-sm text-muted">Optional — locations already save on this device.</p>
        </div>
        {authEnabled ? (
          <div className="space-y-2">
            {GROK_PROVIDERS.map((p) => (
              <Button
                key={p.providerId}
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => signIn(p.providerId, { callbackURL: "/" })}
              >
                Continue with {p.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-center text-sm text-muted">Sign-in is disabled.</p>
        )}
        <p className="text-center text-sm">
          <Link to="/" className="text-muted underline-offset-4 hover:text-fg hover:underline">
            Back to dashboard
          </Link>
        </p>
      </div>
    </main>
  );
}
