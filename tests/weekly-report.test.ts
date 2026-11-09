// Failure cases: Monday holidays trigger early, make-up Sundays never trigger,
// or delayed runs summarize this week rather than the last complete calendar week.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planWeek, notices, collectWeek } from "../examples/recipes/weekly-report/workflow.ts";

const calendar = [2026, 2027].map((year) =>
  JSON.parse(
    readFileSync(new URL(`../examples/recipes/weekly-report/calendars/${year}.json`, import.meta.url), "utf8"),
  ),
);

test("weekly reports wait through Chinese holidays and include make-up Sundays", () => {
  assert.equal(planWeek("2026-10-05", calendar), null);
  assert.deepEqual(planWeek("2026-10-08", calendar), {
    from: "2026-09-28",
    until: "2026-10-04",
    firstWorkday: "2026-10-08",
  });
  assert.equal(planWeek("2026-02-20", calendar), null);
  assert.equal(planWeek("2027-02-13", calendar), null);
  assert.deepEqual(planWeek("2027-02-14", calendar), {
    from: "2027-02-01",
    until: "2027-02-07",
    firstWorkday: "2027-02-14",
  });
});

test("weekly reports catch up on a later workday using a stable previous-week key and refuse missing calendars", () => {
  assert.deepEqual(planWeek("2026-11-10", calendar), planWeek("2026-11-09", calendar));
  assert.equal(planWeek("2026-11-14", calendar), null);
  assert.throws(() => planWeek("2028-03-06", calendar), /日历/);
});

test("long reports keep all content across bounded notification parts", () => {
  const text = "本周完成工作：\n" + "1、完成工作。😀\n".repeat(700);
  const parts = notices("2026-11-02", text);
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.ok(parts.every((part) => [...part.text].length <= 4000 && part.text.isWellFormed()));
  assert.throws(() => notices("2026-11-02", ""), /周报/);
});

test("repeated collection preserves the original snapshot and a missing repository cannot create a partial one", () => {
  const work = mkdtempSync(join(tmpdir(), "weekly-snapshot-"));
  const plan = { from: "2026-11-02", until: "2026-11-08", firstWorkday: "2026-11-09" };
  const settings = { work, author: "robin.li", projects: [{ name: "notes", path: work, isGitRepository: false }] };
  try {
    collectWeek(settings, plan);
    const path = join(work, "inputs", `${plan.from}.json`);
    const first = readFileSync(path, "utf8");
    collectWeek({ ...settings, author: "someone-else" }, plan);
    assert.equal(readFileSync(path, "utf8"), first);
    const absent = { ...plan, from: "2026-10-26" };
    assert.throws(() =>
      collectWeek(
        { ...settings, projects: [{ name: "missing", path: join(work, "missing"), isGitRepository: true }] },
        absent,
      ),
    );
    assert.equal(existsSync(join(work, "inputs", `${absent.from}.json`)), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
