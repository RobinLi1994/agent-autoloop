// Failure cases: HTTP 200 hides a business rejection, a retry duplicates an accepted card,
// or provider error text leaks the credential into the hub's log.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import pushplus from "../plugins/pushplus/channel.ts";
import type { Card } from "../host/channels.ts";

const card: Card = {
  id: 11,
  version: 1,
  ref: null,
  kind: "notice",
  state: "closed",
  title: "周报测试",
  text: "本周完成工作：\n1、测试。",
  options: [],
  recommend: null,
  choice: null,
  answer: null,
  result: null,
  link: null,
};

async function delivery(reply: unknown, status = 200, cards = [card], delay = 0) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof reply === "string" ? reply : JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = new AbortController();
  const accepted: unknown[][] = [];
  const failed: unknown[][] = [];
  const logs: string[] = [];
  const tokenEnv = "AUTOLOOP_TEST_PUSHPLUS_TOKEN";
  process.env[tokenEnv] = "test-secret-never-log";
  try {
    await pushplus({
      hub: {
        async nextCard() {
          const next = cards.shift();
          if (!next) stop.abort();
          return { card: next ?? null };
        },
        async delivered(...args: [number, number, string | null]) {
          accepted.push(args);
        },
        async failed(...args: [number, number, string]) {
          failed.push(args);
        },
      },
      options: {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/send`,
        allowTestEndpoint: true,
        tokenEnv,
        timeoutMs: delay ? 20 : 1000,
      },
      log: (line) => logs.push(line),
      signal: stop.signal,
    });
    return { requests, accepted, failed, logs };
  } finally {
    delete process.env[tokenEnv];
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("PushPlus accepts a personal plain text message and keeps its receipt without resending updates", async () => {
  const result = await delivery({ code: 200, data: "receipt-11" }, 200, [
    card,
    { ...card, ref: "receipt-11", version: 2 },
  ]);
  assert.deepEqual(result.requests, [
    { token: "test-secret-never-log", title: card.title, content: card.text, template: "txt", channel: "wechat" },
  ]);
  assert.deepEqual(result.accepted, [
    [11, 1, "receipt-11"],
    [11, 2, "receipt-11"],
  ]);
  assert.deepEqual(result.failed, []);
});

test("PushPlus rejects business errors, malformed responses and HTTP failures without leaking secrets", async () => {
  for (const [body, status] of [
    [{ code: 401, msg: "test-secret-never-log" }, 200],
    [{ code: "200", data: "receipt" }, 200],
    [{ code: 200 }, 200],
    ["not JSON test-secret-never-log", 200],
    [{ code: 200, data: "receipt" }, 503],
  ] as const) {
    const result = await delivery(body, status);
    assert.deepEqual(result.accepted, []);
    assert.equal(result.failed.length, 1);
    assert.doesNotMatch(JSON.stringify([result.logs, result.failed]), /test-secret-never-log/);
  }
});

test("PushPlus timeouts are failures and do not confirm a message", async () => {
  const result = await delivery({ code: 200, data: "late" }, 200, [card], 100);
  assert.deepEqual(result.accepted, []);
  assert.equal(result.failed.length, 1);
});
