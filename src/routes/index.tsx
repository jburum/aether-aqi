import { createFileRoute, Link } from "@tanstack/react-router";
import { AetherApp } from "@/components/aqi-components";
import { SignedIn, SignedOut, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <>
      <div className="mx-auto flex w-full max-w-5xl items-center justify-end gap-3 px-4 pt-3 sm:px-6">
        <AuthSlot />
      </div>
      <AetherApp />
    </>
  );
}

function AuthSlot() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return <div className="h-8 w-24 animate-pulse rounded-full bg-surface-2" />;
  }
  if (user) {
    return (
      <SignedIn>
        <UserButton />
      </SignedIn>
    );
  }
  return (
    <SignedOut>
      <Link
        to="/login"
        className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
      >
        Sign in
      </Link>
    </SignedOut>
  );
}
