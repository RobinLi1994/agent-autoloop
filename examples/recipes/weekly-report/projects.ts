// Read only the desktop's project registry, never its chat history or credentials.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Project = { name: string; path: string; isGitRepository: boolean; skipReason?: string };
export type Settings = {
  work: string;
  author: string;
  projects: Project[];
  projectSource?: { type: "codex-desktop"; codexHome?: string };
  ignoredProjects?: string[];
};
type Registered = { id: string; name: string; roots: string[] };
type RootRow = { id: string; name: string; path: string | null };

const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));

function registeredProjects(home: string): Registered[] {
  let db: DatabaseSync | undefined;
  try {
    const files = readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name));
    files.sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!files.length) throw new Error("没有项目注册表");
    db = new DatabaseSync(join(home, files[0]), { readOnly: true });
    const rows = db
      .prepare(
        "SELECT p.id,p.name,r.path FROM projects p LEFT JOIN project_roots r ON r.project_id=p.id ORDER BY p.position,p.id,r.position",
      )
      .all() as RootRow[];
    const projects = new Map<string, Registered>();
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.name !== "string" ||
        (row.path !== null && (typeof row.path !== "string" || !isAbsolute(row.path)))
      )
        throw new Error("项目结构不匹配");
      let project = projects.get(row.id);
      if (!project) {
        project = { id: row.id, name: row.name, roots: [] };
        projects.set(row.id, project);
      }
      if (row.path) project.roots.push(row.path);
    }
    return [...projects.values()];
  } catch {
    throw new Error("无法读取 Codex 本机项目注册表，请检查数据路径或更新项目读取适配；未使用旧清单代替");
  } finally {
    db?.close();
  }
}

function describe(path: string, name: string): Project {
  if (!existsSync(path)) return { name, path, isGitRepository: false, skipReason: "目录不存在，未统计" };
  const result = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw new Error(`无法检查 Git 项目：${name}`);
  if (result.status !== 0) {
    if (existsSync(join(path, ".git"))) throw new Error(`Git 项目无法读取：${name}`);
    return { name, path, isGitRepository: false };
  }
  return { name, path: canonical(result.stdout.trim()), isGitRepository: true };
}

export function syncProjectSettings(settingsFile: string): Settings {
  const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Settings;
  const ignored = settings.ignoredProjects ?? [];
  if (!Array.isArray(ignored) || !ignored.every((word) => typeof word === "string"))
    throw new Error("ignoredProjects 必须是项目名或编号列表");
  if (!settings.projectSource) {
    return { ...settings, projects: settings.projects.filter((project) => !ignored.includes(project.name)) };
  }
  if (settings.projectSource.type !== "codex-desktop") throw new Error("不支持的项目来源");
  const registered = registeredProjects(settings.projectSource.codexHome ?? join(homedir(), ".codex"));
  const excluded = (project: Registered) => ignored.includes(project.name) || ignored.includes(project.id);
  // A linked root must not reintroduce an explicitly excluded project's primary repository.
  const excludedRoots = new Set(
    registered.filter(excluded).flatMap((project) => project.roots.slice(0, 1).map(canonical)),
  );
  const primaryNames = new Map(
    registered
      .filter((project) => !excluded(project) && project.roots.length)
      .map((project) => [canonical(project.roots[0]), project.name]),
  );
  const seen = new Set<string>();
  const projects: Project[] = [];
  for (const project of registered) {
    if (excluded(project)) continue;
    for (const [index, path] of project.roots.entries()) {
      const normalized = canonical(path);
      if (excludedRoots.has(normalized)) continue;
      const item = describe(
        normalized,
        primaryNames.get(normalized) ?? (index === 0 ? project.name : basename(normalized)),
      );
      if (seen.has(item.path) || excludedRoots.has(item.path)) continue;
      seen.add(item.path);
      projects.push(item);
    }
  }
  const updated = { ...settings, projects };
  const temporary = `${settingsFile}.sync.tmp`;
  writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, settingsFile);
  return updated;
}
