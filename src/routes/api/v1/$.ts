import { createFileRoute } from "@tanstack/react-router";

import { UnauthorizedError, requireUserId } from "@/lib/auth/verify.server";
import { getSql } from "@/lib/db";
import { handleV1 } from "@/lib/v1/http";
import { TestPushSender } from "@/lib/v1/push";

/**
 * Server delivery path for v1 week 1. The sender is the in-process test
 * sender: no APNs credential, no paid push vendor, no scheduler.
 */
async function dispatch(request: Request): Promise<Response> {
  try {
    const userId = await requireUserId();
    const sql = await getSql();
    return await handleV1(request, {
      sql,
      userId,
      sender: new TestPushSender(),
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "unauthorized", message: "Unauthorized" }, { status: 401 });
    }
    console.error("[v1]", err instanceof Error ? err.message : "request failed");
    return Response.json({ error: "server_error", message: "Request failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/v1/$")({
  server: {
    handlers: {
      GET: ({ request }) => dispatch(request),
      POST: ({ request }) => dispatch(request),
      DELETE: ({ request }) => dispatch(request),
    },
  },
});
