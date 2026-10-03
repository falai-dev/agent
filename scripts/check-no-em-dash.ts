import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const forbidden = /—|&mdash;|&#0*8212;|&#x0*2014;/i;
const message =
  "No em dash in public text. Use a period, comma, colon or parentheses.";
const problems: string[] = [];
const codeExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const textExtensions = new Set([".md", ".html", ".json"]);
// This exact error is quoted from @providerkit/core, not authored by this package.
const externalError =
  "`the output cap ran out before any answer (2048 of 2048 output tokens went to reasoning) — raise maxTokens or lower effort`";
const externalQuotes = new Set(["CHANGELOG.md", "docs/reference/providers.md"]);

function filesIn(folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(
    (entry) => {
      const file = join(folder, entry.name);
      if (file === "docs/rfc") return [];
      if (entry.isDirectory()) return filesIn(file);
      return codeExtensions.has(extname(file)) ||
        textExtensions.has(extname(file))
        ? [file]
        : [];
    },
  );
}

function report(file: string, line: number): void {
  problems.push(`${file}:${line}: ${message}`);
}

function publicDeclaration(node: ts.Node): boolean {
  if (
    ts.canHaveModifiers(node) &&
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
    )
  )
    return false;
  if (
    (ts.isPropertyDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    ts.isPrivateIdentifier(node.name)
  )
    return false;
  const parent = node.parent;
  if (ts.isSourceFile(parent)) {
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node))
      return true;
    return (
      ts.canHaveModifiers(node) &&
      !!node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    );
  }
  if (ts.isBlock(parent)) return false;
  return publicDeclaration(parent);
}

function checkCode(
  file: string,
  text: string,
  firstLine = 1,
  docs = false,
): void {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const seen = new Set<number>();
  function visit(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) ||
        ts.isTemplateLiteralToken(node) ||
        ts.isJsxText(node)) &&
      forbidden.test(node.text)
    ) {
      report(
        file,
        firstLine +
          source.getLineAndCharacterOfPosition(node.getStart(source)).line,
      );
    }
    if (docs && publicDeclaration(node)) {
      const comments = [
        ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.getFullStart()) ?? []),
      ];
      for (const comment of comments) {
        if (seen.has(comment.pos) || !text.startsWith("/**", comment.pos))
          continue;
        seen.add(comment.pos);
        const copy = text.slice(comment.pos, comment.end);
        if (forbidden.test(copy) && !/@internal\b/.test(copy)) {
          report(
            file,
            firstLine + source.getLineAndCharacterOfPosition(comment.pos).line,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(source, visit);
}

function jsonContainsDash(value: unknown): boolean {
  if (typeof value === "string") return forbidden.test(value);
  if (Array.isArray(value)) return value.some(jsonContainsDash);
  if (value !== null && typeof value === "object")
    return Object.values(value).some(jsonContainsDash);
  return false;
}

const files = [
  "README.md",
  "CHANGELOG.md",
  "package.json",
  ...filesIn("src"),
  ...filesIn("examples"),
  ...filesIn("docs"),
];
for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  const extension = extname(file);
  if (codeExtensions.has(extension)) {
    checkCode(file, text, 1, file.startsWith("src/"));
  } else if (extension === ".json") {
    if (jsonContainsDash(JSON.parse(text))) report(file, 1);
  } else {
    let visible = text.replace(/<!--[\s\S]*?-->/g, (comment) =>
      comment.replace(/[^\n]/g, " "),
    );
    if (externalQuotes.has(file))
      visible = visible.replace(
        externalError,
        " ".repeat(externalError.length),
      );
    visible.split("\n").forEach((line, index) => {
      if (forbidden.test(line)) report(file, index + 1);
    });
    if (extension === ".md") {
      for (const fence of visible.matchAll(
        /^```(ts|typescript|js|javascript|tsx|jsx)[^\n]*\n([\s\S]*?)^```/gm,
      )) {
        const line = visible.slice(0, fence.index).split("\n").length + 1;
        checkCode(file, fence[2], line);
      }
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Checked ${files.length} public files: no em dashes.`);
