import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** 产物目录。放在 Typing/ 下是因为宿主 .gitignore 末行是 `Typing/*`（派生物，spec §2.1）。
 *  只放 .d.txt：typeRoots 会自动加载 Typing/ 下任何 .d.ts（spec §2.2）。 */
export const FRAGMENTS_DIR = 'Typing/ue/.fragments';

/** 孤儿归属前缀。三者互不重叠 => "属于某个源"良定义（spec §5.5）。 */
export const ORPHAN_PREFIX = {
  ue: ['ue.', 'ue-'],
  bp: ['bp-'],
  decorators: ['decorators.', 'decorators-'],
};

/**
 * 归属表的**不变量**：不同源的归属前缀**两两互不为前缀**（spec §5.5 的「三个源的归属前缀集合
 * 两两互不重叠……"属于 T"良定义」）。它是两条推理的**前提**：本文件 `cleanOrphans` 的"只删本目标
 * 的分片"，与 verify.mjs `checkUniqueFragNames` 的"这片恰好归属 1 个源"。
 *
 * 为什么值得断言：表里若有一项与别源重叠（例如给 ue 加 `'b'`），两个后果都**不报错就发生** ——
 * 别源的分片会被当孤儿删掉；归属判定算出 2 个源，报错还会把真因（表重叠）说成"这片没有归属"。
 * 而这条不变量此前**只以注释和散文形式存在**（本文件、pack.mjs、verify.mjs 各自的注释，
 * 以及 regenerate.md），没有任何一处断言过它 ⇒ 表被改坏时无人知晓。
 *
 * 只查**跨源**对：同源内部的多个前缀（`ue.` 与 `ue-`）允许包含关系，不属于本条约束。
 * 在模块加载时执行一次 —— 两个消费者都从这张表出发，任何一方用到它之前就该已确认它良定义。
 */
export function assertPrefixesDisjoint(prefixes) {
  const entries = Object.entries(prefixes).flatMap(([id, ps]) => ps.map((p) => [id, p]));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [ida, pa] = entries[i];
      const [idb, pb] = entries[j];
      if (ida === idb) continue;
      if (pa.startsWith(pb) || pb.startsWith(pa)) {
        throw new Error(`归属前缀重叠: ${ida} 的 「${pa}」 与 ${idb} 的 「${pb}」 互为前缀`
          + ' —— 分片「恰好归属 1 个源」不再良定义（spec §5.5）');
      }
    }
  }
}

assertPrefixesDisjoint(ORPHAN_PREFIX);

/**
 * 渲染一个分片：头部注释列出本片单元清单（便于整片读时建立心智地图），
 * 正文为单元原文拼接 —— **单元内部零改写**（spec §4.4）。
 */
export function layoutFragment(frag) {
  const head = frag.units.map((u) => `// ${u.kind} ${u.name}`).join('\n');
  const header = `// ${frag.name} — ${frag.units.length} unit(s)\n${head}\n\n`;
  const headerLines = header.split('\n').length - 1;

  let line = headerLines + 1;
  const placements = [];
  for (const unit of frag.units) {
    placements.push({ unit, frag: frag.name, line, sliced: true });
    line += unit.lines;
  }
  return { name: frag.name, text: header + frag.units.map((u) => u.text).join(''), placements };
}

/**
 * 删除目标 id 的孤儿分片：属于该源、后缀 .d.txt、且不在 keepNames 内。
 * **只在本目标内清理** —— 绝不触碰其他源的分片，这是分目标执行不互相破坏的核心保证。
 * manifest.jsonl 无 .d.txt 后缀，永不匹配。
 */
export function cleanOrphans(dir, id, keepNames) {
  const prefixes = ORPHAN_PREFIX[id];
  if (!prefixes) throw new Error(`未知源 id: ${id}`);
  const deleted = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.d.txt')) continue;
    if (keepNames.has(name)) continue;
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    // ⚠️ **本行不可达**：上面 `!name.endsWith('.d.txt')` 已把 manifest.jsonl 滤掉
    // （它没有 .d.txt 后缀），故该条件**永远不为真**。这一行是把 spec §5.5 的「删除前断言：
    // 待删集合不含 manifest.jsonl」写成一句自解释的声明 —— **不要把它当作那条判据**：
    // 真正在守的是上面那个**后缀过滤**（它同时挡住 .d.ts 泄漏等一切非分片文件）。
    if (name === 'manifest.jsonl') continue;
    unlinkSync(join(dir, name));
    deleted.push(name);
  }
  return deleted;
}
