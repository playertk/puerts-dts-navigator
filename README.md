## puerts-dts-navigator 技能介绍
### 技能解决痛点
PuerTS 项目生成的类型声明文件 ue.d.ts 是 11 MB、25 万行的巨型单体，内含 14,317 个类和 2,556 个枚举，另有随项目蓝图资产持续变化的 ue_bp.d.ts。智能体每次查询类型都要反复打开这个大文件，一次 Read 只能覆盖 0.78%，检索效率极低。

### 技能的核心机制 “后处理分片 + 索引导航” ​
一个零依赖的 Node 脚本扫描 Typing 目录，把超大声明文件按声明边界切成 ≤1,800 行的 .d.txt 分片（该后缀可绕开 tsconfig typeRoots，对编译零影响），同时生成 JSONL 格式的 manifest 索引，记录每个符号对应的分片文件和片内行号。分片采用贪心装箱算法与三级稳定排序，保证任何类、枚举、蓝图包不被切断，且分片结果与源文件块序无关、跨次生成稳定。

对智能体而言，使用方式从"反复打开 11 MB 文件"变为四步：先校验 manifest 中源文件哈希；若蓝图增删导致哈希失效，重跑脚本一秒自愈；然后 Grep 索引一行定位；最后精准 Read 一个 ≤1,800 行的分片。读取规模直降 127 倍，达到分类目录项目的阅读效率。

技能采用"瘦路由"结构：SKILL.md 只做调度导航，检索工作流、manifest 规约、分片再生成、故障自愈等具体内容全部下沉到引用文件，用结构设计强制智能体走引用链路。它不修改任何生成物、不需要重编插件、可随 zip 分发到任意 PuerTS 项目，安装时脚本复制到项目 Tools 目录，重生成声明后重跑即可，对项目体量完全弹性。

### 技能安装方法

#### 前置条件

- 目标项目已启用 Puerts，并在 UE 编辑器内执行过代码生成命令 `Puerts.Gen`，`Typing/` 下已存在各源 `.d.ts`（脚本只**重新切分**已生成的声明，不负责重新生成）。
- Node.js ≥ 22.18（脚本依赖 `import.meta.main`）。工具零依赖，**无需** `npm install`。

#### 方式一：npx 安装（推荐）

通过 `skills` CLI 从仓库直接安装：

```bash
npx skills add playertk/puerts-dts-navigator
```

会把本技能安装到项目的 AI 编码助手技能目录。

#### 方式二：手动安装

未使用安装器时，按同样布局手动放置即可：

1. 把 `puerts-dts-navigator/` 整个目录复制到目标项目的 AI 工具技能目录，例如 `<项目根>\.trae\skills\puerts-dts-navigator\`（其他工具同理：`.claude\skills\`、`.agents\skills\`、`.pi\skills\`）。
2. 把 `puerts-dts-navigator/tools/` 的**内容**复制到 `<项目根>\Tools\split-dts\`，保持 `split-dts.mjs` 与 `lib/` 的相对位置不变。

#### 安装后首次运行

首次没有 manifest，脚本会自动全量重建，产出 `<项目根>/Typing/ue/.fragments/` 与其中的 `manifest.jsonl`：

```bash
node <项目根>/Tools/split-dts/split-dts.mjs
```

脚本会自行向上查找含 `tsconfig.json` 的项目根；也可用 `--project <路径>` 显式指定。切分后默认自动自检。

#### 声明更新后重切

源 `.d.ts` 变化后（蓝图资产增删、引擎 / 插件或 Puerts 版本变化），重新切分即可，无需重装：

```bash
node <项目根>/Tools/split-dts/split-dts.mjs             # 增量：只重切哈希漂移的源
node <项目根>/Tools/split-dts/split-dts.mjs --target bp # 仅重切蓝图源（高频）
node <项目根>/Tools/split-dts/split-dts.mjs --help      # 查看完整参数
```

完整触发条件与参数集见 [references/regenerate.md](references/regenerate.md)。