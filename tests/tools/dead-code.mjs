// 辅助脚本：扫描 ui/ 下未被引用的顶层声明（只做提示，可能有少量误报）
// 用法：node tests/tools/dead-code.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = ['ui/server.js', 'ui/main.js'];
let findings = 0;

for (const file of files) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = src.split('\n');
  const declarations = [];
  lines.forEach((line, index) => {
    let match;
    if ((match = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      declarations.push([match[1], index + 1]);
    }
    if ((match = /^(?:const|let|var)\s*\{([^}]+)\}/.exec(line))) {
      match[1].split(',').forEach(entry => {
        const name = entry.trim().split(':').pop().trim();
        if (name) declarations.push([name, index + 1]);
      });
    }
  });

  const unused = [];
  for (const [name, line] of declarations) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
    const count = (src.match(pattern) || []).length;
    if (count <= 1) unused.push(`  ${file}:${line}  ${name}`);
  }
  if (unused.length) {
    findings += unused.length;
    console.log(`=== ${file} ===`);
    console.log(unused.join('\n'));
  }
}

console.log(findings ? `\n发现 ${findings} 处可能未被引用的声明（请人工确认）` : '未发现未被引用的顶层声明 ✅');
process.exit(findings ? 1 : 0);
