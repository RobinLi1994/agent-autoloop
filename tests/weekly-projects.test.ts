// Failure cases: newly registered projects stay out of reports, legacy/removed folders leak in,
// ignored projects reappear through linked roots, or a source error silently uses stale settings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { syncProjectSettings } from "../examples/recipes/weekly-report/projects.ts";
import { collectWeek } from "../examples/recipes/weekly-report/workflow.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "weekly-projects-")));
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,position INTEGER); CREATE TABLE project_roots (project_id TEXT,position INTEGER,path TEXT)",
  );
  const insert = (id: string, name: string, roots: string[]) => {
    db.prepare("INSERT INTO projects VALUES (?,?,?)").run(
      id,
      name,
      Number(db.prepare("SELECT COUNT(*) AS n FROM projects").get()!.n),
    );
    roots.forEach((path, position) => db.prepare("INSERT INTO project_roots VALUES (?,?,?)").run(id, position, path));
  };
  const repository = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    execFileSync("git", ["init", "-q", path]);
    return path;
  };
  const settingsFile = join(root, "settings.json");
  const settings = {
    work: root,
    author: "robin.li",
    projectSource: { type: "codex-desktop", codexHome },
    ignoredProjects: ["Tibometer", "蓝牙", "消消乐", "周报"],
    projects: [{ name: "stale", path: join(root, "stale"), isGitRepository: true }],
  };
  writeFileSync(settingsFile, JSON.stringify(settings));
  return {
    root,
    codexHome,
    db,
    insert,
    repository,
    settingsFile,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("desktop projects sync additions and removals, honor ignores and deduplicate linked repositories", () => {
  const f = fixture();
  try {
    const a = f.repository("a"),
      b = f.repository("b"),
      ignored = f.repository("ignore");
    const notes = join(f.root, "notes");
    mkdirSync(notes);
    f.insert("a", "项目A", [a, b, ignored]);
    f.insert("b", "项目B", [b]);
    f.insert("i", "Tibometer", [ignored]);
    f.insert("notes", "笔记", [notes]);
    let synced = syncProjectSettings(f.settingsFile);
    assert.deepEqual(
      synced.projects.map((p) => [p.name, p.isGitRepository]),
      [
        ["项目A", true],
        ["项目B", true],
        ["笔记", false],
      ],
    );
    assert.ok(!synced.projects.some((p) => p.path === ignored));
    const c = f.repository("c");
    f.insert("c", "新增项目", [c]);
    synced = syncProjectSettings(f.settingsFile);
    assert.ok(synced.projects.some((p) => p.path === c));
    f.db.prepare("DELETE FROM project_roots WHERE project_id='a'").run();
    f.db.prepare("DELETE FROM projects WHERE id='a'").run();
    assert.ok(!syncProjectSettings(f.settingsFile).projects.some((p) => p.path === a));
    for (const name of ["蓝牙", "消消乐", "周报"]) f.insert(name, name, [f.repository(name)]);
    assert.ok(
      !syncProjectSettings(f.settingsFile).projects.some((p) =>
        ["Tibometer", "蓝牙", "消消乐", "周报"].includes(p.name),
      ),
    );
  } finally {
    f.close();
  }
});

test("new desktop repositories join the next snapshot while the existing week stays unchanged", () => {
  const f = fixture();
  const plan = { from: "2026-11-02", until: "2026-11-08", firstWorkday: "2026-11-09" };
  try {
    f.insert("a", "项目A", [f.repository("a")]);
    collectWeek(syncProjectSettings(f.settingsFile), plan);
    const snapshot = join(f.root, "inputs", `${plan.from}.json`);
    const original = readFileSync(snapshot, "utf8");
    f.insert("b", "新增项目", [f.repository("b")]);
    const settings = syncProjectSettings(f.settingsFile);
    assert.equal(settings.projects.length, 2);
    collectWeek(settings, plan);
    assert.equal(readFileSync(snapshot, "utf8"), original);
    collectWeek(settings, { from: "2026-11-09", until: "2026-11-15", firstWorkday: "2026-11-16" });
    assert.equal(JSON.parse(readFileSync(join(f.root, "inputs/2026-11-09.json"), "utf8")).projects.length, 2);
  } finally {
    f.close();
  }
});

test("an unavailable or changed registry fails without replacing the last successful list", () => {
  const f = fixture();
  try {
    f.insert("a", "项目A", [f.repository("a")]);
    syncProjectSettings(f.settingsFile);
    const original = readFileSync(f.settingsFile, "utf8");
    f.db.exec("DROP TABLE project_roots");
    assert.throws(() => syncProjectSettings(f.settingsFile), /Codex.*项目/);
    assert.equal(readFileSync(f.settingsFile, "utf8"), original);
    const newer = new DatabaseSync(join(f.codexHome, "state_6.sqlite"));
    newer.close();
    assert.throws(() => syncProjectSettings(f.settingsFile), /Codex.*项目/);
  } finally {
    f.close();
  }
});

test("an empty valid registry removes stale entries and manual sources also apply ignores", () => {
  const f = fixture();
  try {
    assert.deepEqual(syncProjectSettings(f.settingsFile).projects, []);
    writeFileSync(
      f.settingsFile,
      JSON.stringify({
        work: f.root,
        author: "robin.li",
        ignoredProjects: ["周报"],
        projects: [{ name: "周报", path: f.root, isGitRepository: true }],
      }),
    );
    assert.deepEqual(syncProjectSettings(f.settingsFile).projects, []);
  } finally {
    f.close();
  }
});
