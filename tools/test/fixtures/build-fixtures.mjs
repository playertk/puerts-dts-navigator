// tools/test/fixtures/build-fixtures.mjs
// 生成 mini-project fixture。**确定性**：无随机、无时间戳，重复运行逐字节相同。
// 用法: node tools/test/fixtures/build-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(import.meta.dirname, 'mini-project');
const w = (rel, text) => {
  mkdirSync(dirname(join(ROOT, rel)), { recursive: true });
  writeFileSync(join(ROOT, rel), text, 'utf8');
};

/** 4 空格 class 单元：1 行头 + body 行 + 1 行闭括号 */
const cls = (name, body) =>
  [`    class ${name} {`, ...Array.from({ length: body }, (_, i) => `        p${i}: number;`), '    }']
    .join('\n') + '\n';

w('tsconfig.json', JSON.stringify({ compilerOptions: { typeRoots: ['Typing'] } }, null, 2) + '\n');

// ue.d.ts：6×4 + 30 行。threshold=15 时 UE_XXL 单单元超阈值 -> 例外分支（切成 15+15 两片）
w('Typing/ue/ue.d.ts',
  '/// <reference path="./puerts.d.ts" />\n' +
  'declare module "ue" {\n' +
  Array.from({ length: 6 }, (_, i) => cls(`UE_C${i}`, 2)).join('') +
  cls('UE_XXL', 28) +
  '}\n');

// ue_bp.d.ts：3 个标记对，**一对一个类型**（一对多类型会让后面的类型在 manifest 里消失，
// 因为单元名取自单元内第一个 8 空格声明）。Game 两个 package、Niagara 一个。
// 单元文本 7 行/个、总 21 行；threshold=15 时 Game 的两个单元合成 bp-Game-001（14 <= 15），
// Niagara 另起一片 **002**（序号跨 root 共享，不是各自从 001 起）。
// 第二个 root 必须是**字母序在 Game 之后**的：按 (root, pkg, name) 排序后 Engine < Game，
// 若用 Engine，第一片就会是 bp-Engine-001，形状表里的 bp-Game-001 根本不存在。
const bpPair = (pkg, kw, name, prop) =>
  '// __TYPE_DECL_START: 5.7\n' +
  `    namespace ${pkg} {\n` +
  `        ${kw} ${name} {\n` +
  `            ${prop}\n` +
  '        }\n' +
  '    }\n' +
  '// __TYPE_DECL_END\n';

w('Typing/ue/ue_bp.d.ts',
  'declare module "ue" {\n' +
  bpPair('Game.Boss', 'class', 'BP_Boss_C', 'Health: number;') +
  bpPair('Game.Modes', 'enum', 'EPyKind', 'A = 0,') +
  bpPair('Niagara.PythonTypes', 'class', 'FPyObject', 'Name: string;') +
  '}\n');

w('Typing/ue/puerts_decorators.d.ts',
  'declare module "ue" {\n' +
  Array.from({ length: 4 }, (_, i) => cls(`DEC_C${i}`, 2)).join('') +
  '}\n');

// sliced:false 的源：只为让 SOURCES 表中每一项都存在，并覆盖"sliced:false 的行指向源文件本身"
w('Typing/ue/puerts.d.ts',
  'declare module "ue" {\n    function NewArray<T>(): T[];\n}\n');
w('Typing/ue/index.d.ts', '/// <reference path="./puerts.d.ts" />\n');
w('Typing/puerts/index.d.ts', 'declare module "puerts" {\n    const version: string;\n}\n');
w('Typing/ffi/index.d.ts', 'declare module "ffi" {\n    function binding(): void;\n}\n');
w('Typing/cpp/index.d.ts', 'declare module "cpp" {\n    function load(): void;\n}\n');

console.log(`fixture 已生成: ${ROOT}`);
