/**
 * Every ```ts fence under docs/ and in README.md must typecheck as a file of
 * its own against src/index.ts, so a snippet cannot drift from the API.
 *
 * A fence that shows a shape rather than a program opens as ```ts fragment
 * and is skipped. Snippets without an import or export get `export {}` so
 * two of them never share a global scope.
 *
 * Run: bun run check:docs                      every doc
 *      bun run check:docs docs/guides/*.md     just these; concurrent runs get their own folder
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const only = process.argv.slice(2).map((arg) => relative(ROOT, join(ROOT, arg)));
const OUT = join(ROOT, ".snippets", only.length ? only.join("_").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80) : "all");
const SKIP = ["docs/rfc/", "docs/migration/v1-to-v2.md", "docs/migration/v2-3-to-v2-4.md", "docs/migration/v2-6-to-v2-7.md"];
const FENCE = /^```(?:ts|typescript)([^\n]*)\n([\s\S]*?)^```/gm;

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const origin = new Map<string, string>();
const files = [join(ROOT, "README.md"), ...markdownFiles(join(ROOT, "docs"))]
  .filter((file) => !SKIP.some((skip) => relative(ROOT, file).startsWith(skip)))
  .filter((file) => !only.length || only.includes(relative(ROOT, file)));
let checked = 0;
let skipped = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  const slug = rel.replace(/[^a-zA-Z0-9]+/g, "_");
  let n = 0;
  for (const match of text.matchAll(FENCE)) {
    n++;
    if (/\bfragment\b/.test(match[1])) {
      skipped++;
      continue;
    }
    const line = text.slice(0, match.index).split("\n").length + 1;
    const body = match[2];
    const isModule = /^\s*(import|export)\b/m.test(body);
    const name = `${slug}__${n}.ts`;
    writeFileSync(join(OUT, name), isModule ? body : `${body}\nexport {};\n`);
    origin.set(name, `${rel}:${line}`);
    checked++;
  }
}

writeFileSync(
  join(OUT, "tsconfig.json"),
  JSON.stringify(
    {
      extends: "../../examples/tsconfig.json",
      compilerOptions: { baseUrl: ".", paths: { "@falai/agent": ["../../src/index.ts"] }, noUnusedLocals: false, noUnusedParameters: false },
      include: ["./*.ts"],
    },
    null,
    2,
  ),
);

const tsc = spawnSync("bunx", ["tsc", "--noEmit", "-p", join(OUT, "tsconfig.json")], { cwd: ROOT, encoding: "utf8" });
const report = `${tsc.stdout}${tsc.stderr}`
  .split("\n")
  .filter((line) => line.trim())
  .map((line) =>
    line.replace(/^\.snippets\/[^/]+\/([^(]+)\((\d+),(\d+)\)/, (_, name: string, row: string, col: string) => {
      const from = origin.get(name);
      if (!from) return `${relative(ROOT, OUT)}/${name}(${row},${col})`;
      const [doc, start] = from.split(":");
      return `${doc}:${Number(start) + Number(row) - 1}:${col}`;
    }),
  );
console.log(`${checked} snippet(s) checked, ${skipped} fragment(s) skipped, in ${files.length} file(s).`);
if (tsc.status !== 0) {
  console.log(report.join("\n"));
  process.exit(1);
}
