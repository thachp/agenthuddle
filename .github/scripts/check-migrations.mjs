// Migrations are forward-only. A room or database that has run one never runs it again, so editing a merged one breaks
// whatever already ran it, and no test that starts from an empty schema notices.
//
//   node check-migrations.mjs <base-ref>     compares this checkout with what's merged at that ref
//   node check-migrations.mjs --self-test
//
// It covers the `Workspace` object's list and both D1 folders. The `Principal` object's schemas use IF NOT EXISTS and have
// no version, so there's no list to compare.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const STORE = "apps/api/src/store.rs";
const D1_FOLDERS = ["apps/api/migrations", "apps/gateway/migrations"];

/** The text of the list, from a Rust source file. */
export function migrationList(source) {
  const start = source.indexOf("const MIGRATIONS: &[&str] = &[");
  if (start < 0) return null;
  const open = source.indexOf("[\"", start);
  const close = source.indexOf("\"];", open);
  if (open < 0 || close < 0) return null;
  return source.slice(open + 1, close + 1);
}

/** Whether `merged` is an exact prefix, so everything after it is a new, whole migration. */
export function isExactPrefix(merged, current) {
  if (!current.startsWith(merged)) return false;
  const rest = current.slice(merged.length);
  return rest.trim() === "" || rest.trimStart().startsWith(",");
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function check(base) {
  const problems = [];
  const merged = migrationList(git("show", `${base}:${STORE}`));
  const current = migrationList(readFileSync(STORE, "utf8"));
  if (merged === null || current === null) problems.push(`${STORE}: couldn't find the MIGRATIONS list, so nothing was checked. Update this script if the list moved.`);
  else if (!isExactPrefix(merged, current)) problems.push(`${STORE}: a merged migration changed. Restore it exactly and add a new one at the end. If ${base} has moved on, merge it first.`);
  for (const folder of D1_FOLDERS) {
    for (const name of git("ls-tree", "--name-only", base, `${folder}/`).split("\n").filter(Boolean)) {
      if (!existsSync(name)) problems.push(`${name}: a merged D1 migration was removed.`);
      else if (readFileSync(name, "utf8") !== git("show", `${base}:${name}`)) problems.push(`${name}: a merged D1 migration changed. Add a new file instead.`);
    }
  }
  return problems;
}

function selfTest() {
  const source = (body) => `fn a() {}\nconst MIGRATIONS: &[&str] = &[${body}];\nfn b() {}\n`;
  const merged = '"\nCREATE TABLE a (x);\n", "\nALTER TABLE a ADD y;\nCREATE TABLE b (z);\n"';
  const list = migrationList(source(merged));
  const cases = [
    ["found", list === merged],
    ["no list", migrationList("fn a() {}") === null],
    ["unchanged", isExactPrefix(list, merged)],
    ["one added", isExactPrefix(list, `${merged}, "\nCREATE TABLE c (w);\n"`)],
    ["a trailing comma", isExactPrefix(list, `${merged},`)],
    ["one edited", !isExactPrefix(list, merged.replace("(z)", "(q)"))],
    ["one removed", !isExactPrefix(list, '"\nCREATE TABLE a (x);\n"')],
    ["added to the last one", !isExactPrefix(list, merged.replace('(z);\n"', '(z);\nCREATE TABLE c (w);\n"'))],
    ["one inserted before the end", !isExactPrefix(list, merged.replace('", "\nALTER', '", "\nCREATE TABLE c (w);\n", "\nALTER'))],
    // The mistake this exists for: a new migration placed in the middle of a merged one, splitting it.
    ["one split", !isExactPrefix(list, merged.replace("\nCREATE TABLE b", '\n", "\nCREATE TABLE c (w);\nCREATE TABLE b'))],
    ["the order changed", !isExactPrefix(list, '"\nALTER TABLE a ADD y;\nCREATE TABLE b (z);\n", "\nCREATE TABLE a (x);\n"')],
  ];
  const failed = cases.filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length) throw new Error(`self-test failed: ${failed.join(", ")}`);
  console.log(`${cases.length} self-test cases pass`);
}

const [arg] = process.argv.slice(2);
if (arg === "--self-test") selfTest();
else if (!arg) {
  console.error("usage: node check-migrations.mjs <base-ref> | --self-test");
  process.exit(2);
} else {
  const problems = check(arg);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`merged migrations at ${arg} are unchanged`);
}
