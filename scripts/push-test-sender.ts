/**
 * Sends the week-1 sample payloads through the in-process test sender.
 * No network, no API key, no launchd job.
 *
 *   node --experimental-strip-types scripts/push-test-sender.ts
 */
import { TestPushSender } from "../src/lib/v1/push.ts";
import { samplePushPayloads } from "../src/lib/v1/samples.ts";

const sender = new TestPushSender();
const payloads = samplePushPayloads();
const sent = [];
for (const [index, payload] of payloads.entries()) {
  const result = await sender.send(payload, `sample-${index + 1}`);
  sent.push({ result, payload });
}

process.stdout.write(`${JSON.stringify({ sender: sender.name, sent }, null, 2)}\n`);
if (sender.sent.length !== payloads.length) process.exitCode = 1;
