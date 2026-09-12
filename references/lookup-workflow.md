# 检索工作流

查询 Puerts 类型定义的唯一标准流程。核心是**先校验、再查询** —— 索引与源文件不一致时，
查到的东西不代表源文件的真实内容。

下文 `<项目根>` 指含 `tsconfig.json` 的项目根目录；索引产物固定在
`<项目根>/Typing/ue/.fragments/`，入口是其中的 `manifest.jsonl`。

## 步骤 1：逐源校验哈希

manifest 的**第一行**是 meta 记录，内含每个源的 `sha1`：

```bash
head -1 "<项目根>/Typing/ue/.fragments/manifest.jsonl"
```

把 `sources[]` 中每一项的 `sha1` 与该源**实际文件**的当前哈希逐一比对：

```bash
sha1sum "<项目根>/Typing/ue/ue.d.ts"                  # POSIX / Git Bash
certutil -hashfile "<项目根>\Typing\ue\ue.d.ts" SHA1   # Windows
```

- **逐源判定**：`sources[]` 逐源独立记录哈希，所以能判断"是哪个源漂移了" —— 只有漂移的源需要重切，
  不必因为 `ue_bp.d.ts` 变了就重切整个 `ue.d.ts`。
- 有源漂移时**先按 `regenerate.md` 重切**，再继续查询。跳过这一步会让后面的结论建立在过期索引上。
- meta 首行缺失、非法 JSON 或没有 `sources[]` → 索引已损坏，见 `troubleshooting.md`。

## 步骤 2：在 manifest 中定位符号

用 `Grep` 工具在 `<项目根>/Typing/ue/.fragments/manifest.jsonl` 中搜索符号名。
manifest 是 **JSONL（一符号一行）**，所以命中**只返回一行**，不会把整个索引倒进上下文。

- 搜索样式：`"name":"<符号名>"`
- 命中行给出 `frag`（目标文件）与 `line`（行号），两者的基准由 `sliced` 决定（见步骤 3）
- **`name` 不唯一**：同名不同类型的符号确实存在。查询键是 **`(name, kind)`**，
  命中多行时按 `kind` 与 `src` 挑行，不要取第一行就下结论

字段定义见 `manifest-spec.md`。

## 步骤 3：按 `sliced` 分流读取

| `sliced` | `frag` 的基准 | `line` 的含义 | 该读哪个文件 |
|---|---|---|---|
| `true` | `<项目根>/Typing/ue/.fragments/` | **分片内**行号 | `<项目根>/Typing/ue/.fragments/<frag>` |
| `false` | **项目根** | **原文件**行号 | `<项目根>/<frag>`（即源文件本身） |

- `sliced: true` → 读分片。分片长度已被切到一次可读完的规模，正常整片读即可。
- `sliced: false` → 该源**未切分**，`frag` 指向原文件。用 `offset` 只读目标符号附近，
  **不要**因此把整份文件当成"一个分片"整读。

## 完整示例（查 `Actor` 的定义）

```text
1. head -1 <项目根>/Typing/ue/.fragments/manifest.jsonl
   → 取出 sources[] 各项的 sha1，与 Typing/ue/ 下各源文件的实际哈希比对，全部一致
2. Grep `"name":"Actor"` in <项目根>/Typing/ue/.fragments/manifest.jsonl
   → 命中 {"name":"Actor","src":"ue","kind":"class","pkg":null,"extends":"UE.Object","frag":"<分片名>","line":<行号>,"sliced":true}
3. sliced=true ⇒ frag 相对 <项目根>/Typing/ue/.fragments/
   → 读 <项目根>/Typing/ue/.fragments/<分片名>，从 <行号> 起
4. 读到的类定义与 ue.d.ts 中同名定义逐字节一致（单元内部零改写）
```

`<分片名>` 与 `<行号>` 是占位符，由脚本每次运行实测分配。本示例是 `ue` 源，故常规片形如
`ue.NNN.d.txt`；`decorators` 的常规片同为点式，而 `bp` 的常规片是 `bp-<root>-NNN.d.txt`（不是点式）。
完整规则（三个源 / 两种形态 / 编号来源）见 `regenerate.md` 的「分片命名」一节。
**不要**把上次运行看到的名字或行号缓存下来 —— 重切后片名与片内行号都会变。

## 读不到、或读到的不是目标

| 现象 | 去处 |
|---|---|
| 符号一个都搜不到 | `troubleshooting.md`（新增类型 / `kind` 用错 / 索引过期） |
| 哈希不匹配、manifest 损坏 | `troubleshooting.md`，处置命令在 `regenerate.md` |
| 分片名或行号与上次不同 | `troubleshooting.md`（属预期行为，改以符号名二次定位） |
| 分片缺失、索引过期需重切 | `regenerate.md` |
