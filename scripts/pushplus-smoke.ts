// Explicit opt-in: normal test runs never read a real credential or send a real message.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pushplus from "../plugins/pushplus/channel.ts";

if (process.argv[2] !== "--send" || !process.argv[3]) {
  throw new Error("真实推送需显式指定：pushplus-smoke.ts --send <结果文件>");
}
const output = resolve(process.argv[3]);
if (existsSync(output)) {
  const prior = JSON.parse(readFileSync(output, "utf8"));
  if (prior.accepted) {
    console.log("测试消息已受理，未重复发送：" + prior.receipt);
    process.exit(0);
  }
}
const stop = new AbortController();
let taken = false;
let accepted = false;
await pushplus({
  hub: {
    async nextCard() {
      if (taken) {
        stop.abort();
        return { card: null };
      }
      taken = true;
      return {
        card: {
          id: 1,
          version: 1,
          ref: null,
          state: "closed",
          options: [],
          link: null,
          title: "agent-autoloop PushPlus 连通性测试",
          text:
            "这是一条你授权的真实测试消息。Codex 后台调用和 PushPlus 插件本地测试均已通过。收到这条消息说明本人微信接收链路可用；周报自动化正在接入。测试时间：" +
            new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
        },
      };
    },
    async delivered(_id, _version, receipt) {
      accepted = true;
      writeFileSync(
        output,
        JSON.stringify(
          { accepted: true, receipt, at: new Date().toISOString(), meaning: "平台受理，微信接收待本人确认" },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log("PushPlus 已受理测试消息，流水号：" + receipt);
    },
    async failed(_id, _version, error) {
      console.error("真实测试未受理：" + error);
    },
  },
  options: { keychainService: "codex.pushplus.user-token" },
  log: (message) => console.error(message),
  signal: stop.signal,
});
if (!accepted) process.exitCode = 1;
