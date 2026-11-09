// Calendar checks and delivery receipts are deterministic; only the summary needs a model.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProjectSettings, type Settings } from "./projects.ts";

type Calendar = { year: number; days: { date: string; isOffDay: boolean }[] };
const DAY = 86400000;
const date = (day: number) => new Date(day).toISOString().slice(0, 10);

export function planWeek(today: string, calendars: Calendar[]) {
  const time = Date.parse(`${today}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(time) || date(time) !== today) throw new Error("日期无效");
  const monday = time - ((new Date(time).getUTCDay() + 6) % 7) * DAY;
  const known = new Set(calendars.map((item) => item.year));
  const overrides = new Map(
    calendars.flatMap((item) => item.days.map((entry) => [entry.date, !entry.isOffDay] as const)),
  );
  const working = (day: number) => {
    if (!known.has(new Date(day).getUTCFullYear())) throw new Error("缺少该年度已核实的中国工作日日历");
    return overrides.get(date(day)) ?? ![0, 6].includes(new Date(day).getUTCDay());
  };
  let first: number | undefined;
  for (let i = 0; i < 7; i++) {
    if (working(monday + i * DAY)) {
      first = monday + i * DAY;
      break;
    }
  }
  if (first === undefined || time < first || !working(time)) return null;
  return { from: date(monday - 7 * DAY), until: date(monday - DAY), firstWorkday: date(first) };
}

export function notices(from: string, text: string) {
  if (!text.trim()) throw new Error("周报为空，禁止发送");
  const characters = [...text];
  if (characters.length > 40000) throw new Error("周报超过十条通知的容量");
  const count = Math.ceil(characters.length / 4000);
  return Array.from({ length: count }, (_, i) => ({
    key: `weekly-${from}-${i + 1}`,
    title: `周报 ${from}${count > 1 ? `（${i + 1}/${count}）` : ""}`,
    text: characters.slice(i * 4000, (i + 1) * 4000).join(""),
    fyi: true,
  }));
}

const receipt = (summary: string, body: object) =>
  `${summary}\n\n\`\`\`agent-autoloop\n${JSON.stringify(body)}\n\`\`\``;

type Plan = NonNullable<ReturnType<typeof planWeek>>;

export function collectWeek(settings: Settings, plan: Plan) {
  const work = resolve(settings.work);
  const snapshot = join(work, "inputs", `${plan.from}.json`);
  if (existsSync(snapshot)) {
    const prior = JSON.parse(readFileSync(snapshot, "utf8"));
    if (prior.from !== plan.from || prior.until !== plan.until || !Array.isArray(prior.projects))
      throw new Error("已有周报快照不完整");
    return;
  }
  const projects = settings.projects.map((project) => {
    if (!project.isGitRepository)
      return { ...project, status: project.skipReason ?? "非 Git 项目，未统计", commits: "" };
    const commits = execFileSync(
      "git",
      [
        "-C",
        project.path,
        "log",
        "--all",
        "--no-merges",
        `--author=${settings.author}`,
        `--since=${plan.from} 00:00:00 +0800`,
        `--until=${plan.until} 23:59:59 +0800`,
        "--date=iso-strict",
        "--pretty=format:%H|%aI|%s%n%b",
        "--shortstat",
      ],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
    return { ...project, status: commits.trim() ? "有本人提交" : "无本人提交", commits };
  });
  mkdirSync(join(work, "inputs"), { recursive: true });
  mkdirSync(join(work, "reports"), { recursive: true });
  const input = { ...plan, author: settings.author, projects };
  const temporary = `${snapshot}.tmp`;
  writeFileSync(temporary, JSON.stringify(input, null, 2), { mode: 0o600 });
  renameSync(temporary, snapshot);
}

async function main() {
  const [mode, settingsPath] = process.argv.slice(2);
  const settings =
    mode === "collect" || mode === "sync-projects"
      ? syncProjectSettings(settingsPath)
      : (JSON.parse(readFileSync(settingsPath, "utf8")) as Settings);
  const work = resolve(settings.work);
  if (mode === "sync-projects") {
    console.log(
      `已同步项目清单：${settings.projects.length} 个目录，其中 ${settings.projects.filter((project) => project.isGitRepository).length} 个 Git 仓库；未生成或推送周报`,
    );
  } else if (mode === "collect") {
    const calendarDir = join(import.meta.dirname, "calendars");
    const calendars = readdirSync(calendarDir)
      .filter((name) => /^\d{4}\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(calendarDir, name), "utf8")));
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const plan = planWeek(today, calendars);
    if (!plan) {
      console.log("没事可做：未到本周首个实际工作日，或今天休息");
      return;
    }
    collectWeek(settings, plan);
    console.log(
      receipt("上周 Git 资料已完整收集", {
        events: [{ id: `ready-${plan.from}`, type: "weekly.ready", subject: plan.from }],
      }),
    );
  } else if (mode === "publish") {
    const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
    const dates = [...new Set<string>(context.events.map((event: { subject: string }) => event.subject))];
    if (!dates.length || dates.some((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value)))
      throw new Error("周报事件缺少可信日期编号");
    const messages = dates.flatMap((from) => {
      const text = readFileSync(join(work, "reports", `${from}.txt`), "utf8");
      if (!text.includes("本周完成工作：") || !text.includes("本周工作总结："))
        throw new Error("周报缺少必要段落，未发送");
      return notices(from, text);
    });
    if (messages.length > 10) throw new Error("一次最多十条通知，请分期发布");
    console.log(receipt("周报已交给 PushPlus 通道投递", { notice: messages }));
  } else throw new Error("用法：workflow.ts collect|publish|sync-projects settings.json");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
