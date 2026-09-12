// 单元 -> 分片分组。零依赖。
export class PackError extends Error {}

/** 分片命名前缀。三个前缀互不重叠（spec §5.5 孤儿清理依赖此性质）。 */
export const NAME_PREFIX = { ue: 'ue', bp: 'bp', decorators: 'decorators' };

/**
 * 稳定排序 —— 分片稳定性的**唯一来源**（spec §2.5：生成物不按名排序，源文件物理顺序
 * 跨次生成是否稳定未证实，故绝不能依赖输入顺序）。
 * Node 的 Array#sort 自 ES2019 起保证稳定，等键单元保持输入顺序。
 */
export function sortUnits(units, mode) {
  const out = units.slice();
  if (mode === 'bp') {
    out.sort((a, b) =>
      cmp(a.root, b.root) || cmp(a.pkg, b.pkg) || cmp(a.name, b.name));
    return out;
  }
  out.sort((a, b) => cmp(a.name, b.name));
  return out;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 贪心装箱。**判据前置**（切在加法之前）—— 这是本设计的关键正确性细节：
 * 若写成"累计超过阈值才切"，threshold=1800、current=1700 时装入 3,731 行的
 * KismetMathLibrary 会把分片顶到 5,431 行，不变量直接失效（spec §4.1）。
 */
export function pack(units, { threshold, id }) {
  const sorted = sortUnits(units, id === 'bp' ? 'bp' : 'name');
  const frags = [];
  let current = [];

  const flush = () => {
    if (current.length) { frags.push(current); current = []; }
  };

  for (const unit of sorted) {
    if (unit.lines > threshold) {
      // 例外分支：单元自身超阈值，必须内部再切（spec §4.3）
      flush();
      frags.push(...splitOversized(unit, threshold, id));
      continue;
    }
    const used = current.reduce((n, u) => n + u.lines, 0);
    if (current.length && used + unit.lines > threshold) flush();
    current.push(unit);
  }
  flush();

  return nameFragments(frags, id);
}

/** 超阈值单元的行区间划分：每片 <= threshold 行。**切片规则的唯一定义处**。 */
function chunkBounds(lines, threshold) {
  const out = [];
  for (let i = 0; i < lines; i += threshold) out.push([i, Math.min(i + threshold, lines)]);
  return out;
}

/** 单单元超阈值的内部切分：按行切片，每片 <= threshold 行。片内文本仍逐字节原样。 */
function splitOversized(unit, threshold, id) {
  return chunkBounds(unit.lines, threshold).map(([from, to]) => ({ oversized: { unit, from, to }, id }));
}

/**
 * 把超阈值单元按**与 `splitOversized` 完全相同**的规则展开成切片单元。
 *
 * 存在的理由：§7 的完整性断言按字面是 `sha1(源单元) == sha1(分片单元)`，但 §4.3 的例外分支
 * 强制把超阈值单元切成多片 —— 两侧不同构，按字面比对会把**正常产出**判为失败。
 * 展开后两侧同构，断言强度不变（丢失/重复/篡改仍会被 sha1 抓到）。
 *
 * 与 `splitOversized` 共用 `chunkBounds`：规则只有一处，两者不可能分叉。
 */
export function expandUnits(units, threshold) {
  const out = [];
  for (const u of units) {
    if (u.lines > threshold) {
      for (const [from, to] of chunkBounds(u.lines, threshold)) out.push(sliceUnit(u, from, to));
    } else out.push(u);
  }
  return out;
}

/**
 * 命名。常规 `ue.001.d.txt` / `decorators.001.d.txt` / `bp-<root>-<NNN>.d.txt`；
 * 例外 `ue-<Name>-NNN.d.txt` / `bp-<pkg 全路径>-NNN.d.txt`（点换连字符）。
 * packageRoot 是 bp 的硬边界：分片不跨 root，故 `bp-<root>-NNN` 良定义（spec §4.3）。
 */
function nameFragments(groups, id) {
  const frags = [];
  let n = 0;

  for (const g of groups) {
    if (Array.isArray(g)) {                       // 常规片
      if (!g.length) continue;
      if (id === 'bp') {
        const fragsOfRoot = [];
        // 逐 root 分段（排序后同 root 相邻）
        let cur = null;
        for (const u of g) {
          if (!cur || cur.root !== u.root) { cur = { root: u.root, units: [] }; fragsOfRoot.push(cur); }
          cur.units.push(u);
        }
        for (const r of fragsOfRoot) {
          frags.push({ name: `bp-${sanitize(r.root)}-${pad(++n)}.d.txt`, units: r.units });
        }
      } else {
        frags.push({ name: `${NAME_PREFIX[id]}.${pad(++n)}.d.txt`, units: g });
      }
    } else {                                      // 例外片
      const { unit, from, to } = g.oversized;
      const stem = id === 'bp'
        ? `bp-${sanitize(unit.pkg)}`
        : `${NAME_PREFIX[id]}-${sanitize(unit.name)}`;
      frags.push({
        name: `${stem}-${pad(++n)}.d.txt`,
        units: [sliceUnit(unit, from, to)],
      });
    }
  }

  assertUniqueNames(frags);
  return frags;
}

const pad = (n) => String(n).padStart(3, '0');
const sanitize = (s) => String(s).replace(/\./g, '-');

function sliceUnit(unit, from, to) {
  const lines = unit.text.split(/(?<=\n)/);
  const text = lines.slice(from, to).join('');
  return { ...unit, startLine: unit.startLine + from, endLine: unit.startLine + to - 1, lines: to - from, text };
}

/**
 * 文件名唯一性断言。常规名 `bp-A-B-001` 与例外名（root='A'、pkg='B'）会退化为同一串，
 * 同名的两个分片会互相覆盖 —— **静默数据丢失**。冲突必须响亮失败，不得自动改名
 * （改名会让 manifest 与文件不一致）；manifest 始终是权威定位依据，分片名仅供人读。
 */
export function assertUniqueNames(frags) {
  const seen = new Map();
  for (const f of frags) {
    if (seen.has(f.name)) throw new PackError(`分片文件名冲突（会互相覆盖）: ${f.name}`);
    seen.set(f.name, true);
  }
}
