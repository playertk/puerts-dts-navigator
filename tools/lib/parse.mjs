// split-dts 的解析层。零依赖：只允许 node: 内置模块。

export class ParseError extends Error {}

/** 源表。parser: 'decl4' = 4 空格声明族，'markers' = bp 标记对族，'none' = 无符号（仅登记哈希） */
export const SOURCES = [
  { id: 'ue',           path: 'Typing/ue/ue.d.ts',                sliced: true,  parser: 'decl4' },
  { id: 'bp',           path: 'Typing/ue/ue_bp.d.ts',             sliced: true,  parser: 'markers' },
  { id: 'decorators',   path: 'Typing/ue/puerts_decorators.d.ts', sliced: true,  parser: 'decl4' },
  { id: 'puerts',       path: 'Typing/ue/puerts.d.ts',            sliced: false, parser: 'decl4' },
  { id: 'puerts-index', path: 'Typing/puerts/index.d.ts',         sliced: false, parser: 'decl4' },
  { id: 'ffi',          path: 'Typing/ffi/index.d.ts',            sliced: false, parser: 'decl4' },
  { id: 'cpp',          path: 'Typing/cpp/index.d.ts',            sliced: false, parser: 'decl4' },
  { id: 'ue-index',     path: 'Typing/ue/index.d.ts',             sliced: false, parser: 'none' },
];

// 4 空格声明族的关键字。'abstract class' 必须排在 'class' 之前（正则分支有序）。
// 归一化：abstract class -> class（spec §2.4 实测 cpp/index.d.ts 用该形态）
const DECL_KEYWORDS = [
  ['abstract class', 'class'],
  ['class', 'class'],
  ['enum', 'enum'],
  ['interface', 'interface'],
  ['type', 'type'],
  ['const', 'const'],
  ['namespace', 'namespace'],
  ['function', 'function'],
];

// 名字允许 $ 前缀（实测 ue/puerts.d.ts 有 $CallbackID / $Delegate）
const DECL_RE = new RegExp(
  '^    (' + DECL_KEYWORDS.map(([kw]) => kw).join('|') + ') ([A-Za-z_$][A-Za-z0-9_$]*)'
);

const KIND_OF = new Map(DECL_KEYWORDS);
const EXTENDS_RE = /^\s*(?:abstract )?class \w+ extends (UE\.[A-Za-z0-9_$]+)/m;

/** 保留行尾切分，使单元文本能逐字节还原（兼容 CRLF：\r 留在前一行里） */
export function toLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { out.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** 去掉行尾换行（含 CR），用于锚定整行的正则匹配 */
const body = (line) => line.replace(/\r?\n$/, '');

/**
 * 4 空格声明族：扫描全部匹配行作**边界**，再按 kinds 筛出要成为单元的。
 * 边界依赖全量匹配（不是筛选后的匹配）—— 否则筛掉的关键字会消失，单元会被撑大。
 */
export function parseDeclarations(text, kinds = null) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = toLines(src);
  const cut = trimTrailer(lines);

  const hits = [];
  for (let i = 0; i < cut; i++) {
    const m = DECL_RE.exec(body(lines[i]));
    if (m) hits.push({ i, kw: KIND_OF.get(m[1]), name: m[2] });
  }

  const units = [];
  for (let h = 0; h < hits.length; h++) {
    const cur = hits[h];
    if (kinds && !kinds.includes(cur.kw)) continue;
    const endExclusive = h + 1 < hits.length ? hits[h + 1].i : cut;
    units.push(makeUnit(cur, endExclusive, lines));
  }

  if (units.length === 0) {
    throw new ParseError('4 空格声明族：识别到 0 个单元。边界规则与文件形态不匹配（spec §4.3）—— 拒绝静默返回空结果。');
  }
  return units;
}

function makeUnit(hit, endExclusive, lines) {
  const text = lines.slice(hit.i, endExclusive).join('');
  return {
    name: hit.name,
    kind: hit.kw,
    pkg: null,
    root: null,
    extends: (EXTENDS_RE.exec(text) || [null, null])[1],
    startLine: hit.i + 1,
    endLine: endExclusive,
    lines: endExclusive - hit.i,
    text,
  };
}

/**
 * 有意丢弃 trailer（spec §2.4 / §7）：4 空格族的 trailer 是包裹用的 `declare module` 闭合
 * `}`（可能前置空白行），不属于任何单元。§7 的"完整性"断言因此只覆盖**单元文本**，
 * 不宣称整文件逐字节可还原 —— 该丢弃是显式的，不是顺手切掉。
 * 0 缩进的 `}` 只可能是模块闭合（模块内声明都在 4 空格以上），故判据安全。
 */
function trimTrailer(lines) {
  let end = lines.length;
  while (end > 0) {
    const b = body(lines[end - 1]);
    if (b.trim() === '' || /^\}\s*;?$/.test(b)) end--; else break;
  }
  return end;
}

// 标记字面量（源码实测 DeclarationGenerator.cpp:55-57 / :443-445）：
//   TYPE_DECL_START = "// __TYPE_DECL_START: "  + (版本串 | "ASSOCIATION")
//   TYPE_DECL_END   = "// __TYPE_DECL_END"
// 两标记均顶格。只认前缀，不解析版本值。
const MARK_START_RE = /^\/\/ __TYPE_DECL_START: \S/;
const MARK_END_RE = /^\/\/ __TYPE_DECL_END$/;
// NamespaceBegin 写 "    namespace <pkg> {\n"（NamespaceEnd 的 "    }\n\n" 使结束标记前有空行，仍在标记对内）
// m 标志：在**单元原文**上按行锚定（不是逐行传入）
const NS_RE = /^    namespace ([A-Za-z_$][A-Za-z0-9_$.]*)/m;
// 类型本体在 8 空格 —— 用它做"块内确有类型"的健全性断言
// m 标志同 NS_RE：单元原文以起始标记行开头（不是 8 空格行），缺 m 会恒不匹配
const BODY_RE = /^        (class|enum) ([A-Za-z_$][A-Za-z0-9_$]*)/m;

/**
 * bp 标记对族。边界**只能**靠标记对：bp 的 class/enum 在 8 空格（多套一层 namespace），
 * 用 ue.d.ts 的 4 空格规则会**静默切出 0 个单元**（spec §4.3）。
 */
export function parseBp(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = toLines(src);

  const units = [];
  let markerPairs = 0;
  let open = -1;

  for (let i = 0; i < lines.length; i++) {
    const b = body(lines[i]);
    if (MARK_START_RE.test(b)) {
      if (open >= 0) throw new ParseError(`bp: 第 ${open + 1} 行的起始标记未闭合就遇到第 ${i + 1} 行的新起始标记`);
      open = i;
    } else if (MARK_END_RE.test(b)) {
      if (open < 0) throw new ParseError(`bp: 第 ${i + 1} 行出现无起始标记的结束标记`);
      markerPairs++;
      units.push(makeBpUnit(lines, open, i + 1));
      open = -1;
    }
  }
  if (open >= 0) throw new ParseError(`bp: 第 ${open + 1} 行的起始标记没有对应的结束标记`);

  if (units.length === 0) {
    throw new ParseError('bp: 识别到 0 个标记对。标记文案或格式已变（spec §4.3）—— 拒绝静默返回空结果。');
  }
  if (markerPairs !== units.length) {
    throw new ParseError(`bp: 标记对数 ${markerPairs} != 单元数 ${units.length}`);
  }
  return { units, markerPairs };
}

function makeBpUnit(lines, startIdx, endIdx) {
  const text = lines.slice(startIdx, endIdx).join('');

  const ns = NS_RE.exec(text);          // NS_RE 带 m 标志，直接在原文上找 4 空格 namespace 行
  const pkg = ns ? ns[1] : null;
  if (!pkg) {
    throw new ParseError(
      `bp: 第 ${startIdx + 1} 行的单元内没有 4 空格 namespace 行（pkg 无法确定）。` +
      `若编译时定义了 WITHOUT_BP_NAMESPACE，package 边界与分片命名均不成立（spec §4.3）。`
    );
  }

  const b = BODY_RE.exec(text);         // 8 空格 class/enum 只用于取 name/kind
  if (!b) {
    throw new ParseError(`bp: 第 ${startIdx + 1} 行的单元内没有 8 空格 class/enum —— 文件形态已变`);
  }

  return {
    name: b[2],
    kind: b[1],
    pkg,
    root: pkg.split('.')[0],
    extends: (EXTENDS_RE.exec(text) || [null, null])[1],
    startLine: startIdx + 1,
    endLine: endIdx,
    lines: endIdx - startIdx,
    text,
  };
}

export function parseSource(id, text) {
  const src = SOURCES.find((s) => s.id === id);
  if (!src) throw new ParseError(`未知的源 id: ${id}`);
  if (src.parser === 'none') return { units: [], markerPairs: null };
  if (src.parser === 'decl4') return { units: parseDeclarations(text), markerPairs: null };
  if (src.parser === 'markers') return parseBp(text);
  throw new ParseError(`源 ${id} 的解析器 ${src.parser} 没有对应分支。SOURCES 表与 parseSource 失配 —— 拒绝静默返回 undefined。`);
}
