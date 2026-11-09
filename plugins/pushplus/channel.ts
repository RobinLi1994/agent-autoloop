// A one-way personal channel. A PushPlus receipt means accepted, not read or delivered to WeChat.
import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";

type Card = {
  id: number;
  version: number;
  ref: string | null;
  title: string;
  text: string;
  state: string;
  options: string[];
  link: string | null;
};
type Context = {
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(id: number, version: number, ref: string | null): Promise<unknown>;
    failed(id: number, version: number, error: string): Promise<unknown>;
  };
  options: Record<string, unknown>;
  log(line: string): void;
  signal: AbortSignal;
};

const runFile = promisify(execFile);
const endpoint = "https://www.pushplus.plus/send";

async function credential(options: Context["options"]) {
  if (typeof options.keychainService === "string") {
    try {
      const { stdout } = await runFile(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-a",
          userInfo().username,
          "-s",
          options.keychainService,
          "-w",
          join(homedir(), "Library/Keychains/login.keychain-db"),
        ],
        { timeout: 10_000 },
      );
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* Do not propagate subprocess output containing authentication material. */
    }
    throw new Error("PUSHPLUS_KEYCHAIN_UNAVAILABLE");
  }
  const token = process.env[String(options.tokenEnv ?? "PUSHPLUS_TOKEN")]?.trim();
  if (!token) throw new Error("PUSHPLUS_TOKEN_MISSING");
  return token;
}

export default async function pushplus({ hub, options, log, signal }: Context) {
  const url = String(options.url ?? endpoint);
  const local = new URL(url);
  if (
    url !== endpoint &&
    !(
      options.allowTestEndpoint === true &&
      local.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(local.hostname)
    )
  ) {
    throw new Error("PUSHPLUS_ENDPOINT_INVALID");
  }
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch {
      if (signal.aborted) return;
      log("PushPlus 通道暂时无法连接中台");
      await pause(10_000, undefined, { signal }).catch(() => {});
      continue;
    }
    if (!card) continue;
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    let problem = "PUSHPLUS_NETWORK_ERROR";
    let receipt: string;
    try {
      const token = await credential(options);
      const choices = card.state === "open" ? card.options.map((word, i) => `${i + 1}. ${word}`).join("\n") : "";
      const content = [card.text, choices, card.state === "open" ? card.link : null].filter(Boolean).join("\n\n");
      if ([...card.title].length > 100 || [...content].length > 20000) throw new Error("PUSHPLUS_MESSAGE_TOO_LONG");
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, title: card.title, content, template: "txt", channel: "wechat" }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(Number(options.timeoutMs ?? 30_000))]),
      });
      if (!response.ok) throw new Error(`PUSHPLUS_HTTP_${response.status}`);
      problem = "PUSHPLUS_INVALID_RESPONSE";
      const result = await response.json();
      if (!result || result.code !== 200) {
        throw new Error(Number.isInteger(result?.code) ? `PUSHPLUS_CODE_${result.code}` : problem);
      }
      if (typeof result.data !== "string" || !result.data.trim() || result.data.length > 500) throw new Error(problem);
      receipt = result.data;
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : "";
      if (/^PUSHPLUS_[A-Z0-9_]+$/.test(message)) problem = message;
      log(`PushPlus 卡片发送结果未确认 ${card.id}：${problem}`);
      await hub.failed(card.id, card.version, problem).catch(() => {});
      continue;
    }
    // Keep reporting separate: losing the hub acknowledgement does not mean the provider rejected it.
    await hub.delivered(card.id, card.version, receipt);
  }
}
