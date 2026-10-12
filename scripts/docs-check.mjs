/*
 * 文档链接与引用检查
 *
 *   node scripts/docs-check.mjs
 *
 * 五十篇文档互相引用，最容易烂掉的就是链接：改了文件名、删了数据文件、
 * 从别的目录相对跳错一层 —— 单测不会管，接手的人点进去 404 才发现。
 *
 * 检查两类：
 *   1. Markdown 相对链接（[文字](路径)）指向的**文件必须存在**；
 *   2. 文档里用反引号写出来的**仓库内路径**（如 docs/verification/data/x.txt）必须存在。
 * 只检查仓库内相对路径，外链（http/https）与锚点跳过。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

const files = [...walk(join(root, "docs")), join(root, "README.md")].filter(existsSync);
const broken = [];

for (const file of files) {
  const rel = file.slice(root.length);
  const text = readFileSync(file, "utf8");

  // 1) Markdown 链接
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = target.split("#")[0];
    if (!clean) continue;
    const resolved = resolve(dirname(file), clean);
    if (!existsSync(resolved)) broken.push({ file: rel, line: text.slice(0, match.index).split("\n").length, target, kind: "链接" });
  }

  // 2) 反引号里的仓库内路径
  const lines = text.split("\n");
  for (const match of text.matchAll(/`((?:docs|apps|deploy|scripts|server)\/[A-Za-z0-9._/-]+)`/g)) {
    const target = match[1];
    if (!/\.[a-z]{2,5}$/.test(target)) continue;          // 只要像文件的
    const line = lines[text.slice(0, match.index).split("\n").length - 1] || "";
    // 明确标注为"计划产出、未创建"的行跳过（标记写在行尾，可审查）
    if (line.includes("docs-check: planned")) continue;
    const resolved = join(root, target);
    if (!existsSync(resolved)) broken.push({ file: rel, line: lines.indexOf(line) + 1, target, kind: "路径" });
  }
}

if (broken.length) {
  console.log(`文档引用问题 ${broken.length} 处：`);
  for (const b of broken.slice(0, 30)) console.log(`  ${b.kind} ${b.file}:${b.line} -> ${b.target}`);
  if (broken.length > 30) console.log(`  …还有 ${broken.length - 30} 处`);
} else {
  console.log(`文档引用检查通过（${files.length} 篇）`);
}
process.exit(broken.length ? 1 : 0);
