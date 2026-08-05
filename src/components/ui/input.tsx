import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        // text-base (16px) avoids iOS Safari focus-zoom that pans content off-screen
        "flex h-11 w-full min-w-0 max-w-full rounded-[var(--radius-md)] border border-border bg-surface px-3 text-base text-fg placeholder:text-subtle",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
