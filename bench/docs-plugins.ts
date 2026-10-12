// 插件使用说明：安装、管理、权限，以及怎么写数据插件 / 代码插件。
// 与 docs/PLUGIN-ARCHITECTURE.md 同源；清单字段、贡献点或权限有变化时同步这里与 editor/i18n.ts 的 pl.* 文案。

import type { DocSection } from "./docs";

const same = (s: string) => ({ zh: s, en: s });

const MANIFEST = `{
  "id": "fx-crt",
  "name": { "zh-CN": "CRT 显像管效果", "en": "CRT monitor effect" },
  "version": "1.0.0",
  "engine": "^1.0",
  "description": "…",
  "main": "index.js",
  "contributes": {
    "effects": ["effects/crt.json"],
    "particles": ["particles/x.json"],
    "particles.components": ["particles/components/blend.json"],
    "shaders": ["glsl/crt.glsl"],
    "i18n": { "zh-CN": "i18n/zh-CN.json", "en": "i18n/en.json" }
  },
  "permissions": ["importers"]
}`;

const EFFECT = `{
  "id": "crt",
  "title": { "zh-CN": "CRT 显像管", "en": "CRT monitor" },
  "category": "stylize",
  "params": [
    { "key": "curvature", "type": "float", "default": 0.12, "min": 0, "max": 0.5, "step": 0.01,
      "label": { "zh-CN": "弯曲", "en": "Curvature" } }
  ],
  "declarations": "#include \\"wwgl/fx-crt/crt\\"\\n",
  "body": "effects/crt.body.glsl"
}`;

const CODE_PLUGIN = `import { definePlugin, type ExportRule } from "@webwallgl/plugin-sdk";

export default definePlugin({
  name: "export-lint-strict",
  inject: ["export.rules"],
  apply(ctx, host) {
    const maxMB = host.settings?.get("maxFileMB", 64) ?? 64;
    const rule: ExportRule = {
      id: "lint-strict",
      stage: "loose",
      order: 200,
      check(x) {
        for (const f of x.files)
          if (f.data.byteLength > maxMB * 1024 * 1024) x.diag("warn", "big-file", \`too big: \${f.path}\`, f.path);
      },
    };
    ctx.contribute("export.rules", rule);
  },
});`;

export const PLUGINS_DOC: DocSection[] = [
  {
    id: "pl-intro",
    title: { zh: "插件是什么", en: "What plugins are" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "编辑器按「万物即插件」组织：本体只是一个小内核加页面装配，效果、shader 片段、粒子模板、模型导入、图层类型、检视器面板、木偶工具、导出目标 / 钩子 / 检查规则全部由插件提供。内置功能和你装的外部插件走同一套装配、权限与生命周期——外部插件能做的事，和内置功能一样多。",
          en: "The editor is organized as \"everything is a plugin\": the core is just a small kernel plus page wiring, while effects, shader snippets, particle templates, model importers, layer kinds, inspector panels, puppet tools and export targets / hooks / rules are all contributed by plugins. Built-in features and the external plugins you install share the same wiring, permissions and lifecycle — an external plugin can do as much as a built-in one.",
        },
      },
      {
        k: "p",
        v: {
          zh: "无论装了什么插件，导出的产物始终是 Wallpaper Engine 能直接读的工程：插件效果的 shader 片段在写进工程时内联展开，粒子只允许引擎认识的组件，导出前还会用引擎自己的解析器回读检查。",
          en: "Whatever plugins you install, the export is always a project Wallpaper Engine reads directly: plugin shader snippets are inlined when written to the project, particles may only use components the engine understands, and export re-reads the result with the engine's own parsers before finishing.",
        },
      },
      {
        k: "table",
        head: [
          { zh: "可以扩展", en: "Extension point" },
          { zh: "在界面上体现为", en: "Shows up as" },
        ],
        rows: [
          [{ zh: "效果（effects）", en: "Effects (effects)" }, { zh: "检视器「效果」标签的添加菜单里多出新效果；参数面板由参数表自动生成", en: "New entries in the add menu of the inspector's Effects tab; the parameter panel is generated from the param table" }],
          [{ zh: "shader 片段（shaders）", en: "Shader snippets (shaders)" }, { zh: "效果里可 #include \"wwgl/<插件 id>/<名字>\"；导出时内联展开", en: "Effects can #include \"wwgl/<plugin id>/<name>\"; inlined on export" }],
          [{ zh: "粒子模板 / 组件", en: "Particle templates / components" }, { zh: "「添加粒子层」菜单里多出新模板", en: "New templates in the \"Add particle layer\" menu" }],
          [{ zh: "模型导入（importers）", en: "Model importers (importers)" }, { zh: "「导入模型」支持新扩展名，或用 sniff 接管同扩展名的某类文件", en: "\"Import model\" accepts new extensions, or takes over some files of an existing extension via sniff" }],
          [{ zh: "图层类型（layerKinds）", en: "Layer kinds (layerKinds)" }, { zh: "识别 scene.json 里的某种对象并提供新建入口与能力描述", en: "Recognizes a kind of object in scene.json and provides a create entry and capabilities" }],
          [{ zh: "检视器分组 / 标签", en: "Inspector groups / tabs" }, { zh: "检视器里多出分组，或多出一个新标签", en: "Extra groups in the inspector, or a whole new tab" }],
          [{ zh: "木偶工具 / 生成器", en: "Puppet tools / generators" }, { zh: "模型层的工具；生成器把别的东西变成可动画模型（内置：图片 → 摆动网格）", en: "Tools for model layers; generators turn something else into an animatable model (built in: image → swaying mesh)" }],
          [{ zh: "导出目标 / 钩子 / 规则", en: "Export targets / hooks / rules" }, { zh: "导出菜单里多出目标；导出前改写产物或追加检查项", en: "New targets in the Export menu; rewrite the output or add checks before export" }],
          [{ zh: "命令 / 界面槽位 / 词条", en: "Commands / UI slots / strings" }, { zh: "新命令与快捷键（也汇总进 ⌘K / Ctrl+K 命令面板）；七个界面槽位各有落点：toolbar（主工具条「导出 PNG」左边）、menu.add（左栏添加按钮排）、menu.export（导出下拉里）、inspector.project（检视器顶部的工程级区块）、panel.right（右栏底部的面板区）、statusbar（底部状态栏）、viewport.overlay（视口叠层，里面的子元素照常可点）；中英文案", en: "New commands and shortcuts (collected into the ⌘K / Ctrl+K command palette too); seven UI slots, each with its own home: toolbar (the main toolbar, left of \"Export PNG\"), menu.add (the left column's add-button row), menu.export (inside the export dropdown), inspector.project (the project-level block at the top of the inspector), panel.right (the panel area at the bottom of the right column), statusbar (the bottom status bar) and viewport.overlay (the viewport overlay, whose children stay clickable); zh / en strings" }],
        ],
      },
    ],
  },
  {
    id: "pl-manage",
    title: { zh: "安装与管理", en: "Installing and managing" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "点主工具条的「插件」打开插件管理，列出所有外部插件及其状态。",
          en: "Click \"Plugins\" in the main toolbar to open the plugin manager, which lists every external plugin and its status.",
        },
      },
      {
        k: "table",
        head: [
          { zh: "来源", en: "Source" },
          { zh: "说明", en: "Details" },
        ],
        rows: [
          [{ zh: "内置示例", en: "Bundled example" }, { zh: "examples/plugins 里的示例随应用自带，默认已安装并启用；不需要可以停用，但不能卸载", en: "The examples in examples/plugins ship with the app and are installed and enabled by default; you can disable them but not uninstall them" }],
          [{ zh: "已安装", en: "Installed" }, { zh: "点「安装插件文件夹…」选一个含 wwgl-plugin.json 的文件夹，整包存进浏览器本地存储；可卸载", en: "Click \"Install plugin folder…\" and pick a folder containing wwgl-plugin.json; the whole package is stored in browser storage and can be uninstalled" }],
          [{ zh: "插件目录", en: "Plugin folder" }, { zh: "放进 ~/.webwallgl/plugins/<目录>（或环境变量 WWGL_PLUGIN_DIRS 指向的目录），点「重新扫描」；桌面版可用「打开插件目录」在访达里打开", en: "Put it in ~/.webwallgl/plugins/<folder> (or a folder listed in the WWGL_PLUGIN_DIRS environment variable) and click \"Rescan\"; the desktop app can reveal the folder with \"Open plugin folder\"" }],
        ],
      },
      {
        k: "ul",
        items: [
          { zh: "同一个插件多处都有时按「插件目录 > 已安装 > 内置示例」取生效版本（开发中的插件盖过已安装的旧版，你装的版本盖过自带示例）；高优先级的移走后自动回落", en: "If a plugin exists in several places, the copy used is plugin folder > installed > bundled example (a plugin under development overrides the installed one, and your installed copy overrides the bundled example); removing the higher one falls back automatically" },
          { zh: "每个插件可启用 / 停用、重载、卸载；停用会撤回它贡献的全部内容，再启用即恢复", en: "Each plugin can be enabled / disabled, reloaded or uninstalled; disabling withdraws everything it contributed, and enabling restores it" },
          { zh: "状态：运行中 / 等待依赖（列出缺的服务，多半是清单没申请对应权限）/ 出错 / 无效（清单不合法）/ 已停用", en: "Status: running / waiting for dependencies (lists the missing services — usually a permission missing from the manifest) / error / invalid (bad manifest) / disabled" },
          { zh: "清单里申请了权限的插件，每一行列出逐项权限开关（默认全开，高风险能力带 ⚠）；关掉某一项会立刻按新的白名单重新挂载插件，该项能力即时收回——插件若正依赖它，状态会退回「等待依赖」", en: "For plugins that request permissions, each row lists a switch for every permission (all on by default; high-risk capabilities are marked ⚠). Turning one off reloads the plugin against the new whitelist right away, so that capability is withdrawn at once — if the plugin depends on it, its status falls back to \"waiting for dependencies\"" },
          { zh: "每一行还有一个可折叠的「插件日志」：安装、权限开关和报错都记在这里（最近 200 条，出错自动展开、倒序显示、可一键清空）；日志只存在内存里，刷新页面即清空，出错仍照旧写控制台", en: "Each row also has a collapsible \"plugin log\" where installs, permission switches and errors are recorded (the latest 200 entries; it auto-expands on error, shows newest first and can be cleared). The log lives in memory only — a page refresh clears it — and errors still go to the console as before" },
          { zh: "插件目录里的文件改动后约 1.5 秒自动热重载，不用刷新页面", en: "Files changed in the plugin folder hot-reload automatically within about 1.5 seconds — no page refresh needed" },
          { zh: "插件出错会写进控制台；连续出错 5 次的插件会被自动停用，不影响编辑器本身", en: "Plugin errors are written to the console; a plugin that fails 5 times in a row is disabled automatically without affecting the editor" },
          { zh: "导出时，正在使用的外部插件（id 与版本）会记进 project.json 的 editor.plugins，便于以后知道工程依赖了哪些插件", en: "On export, the active external plugins (id and version) are recorded in editor.plugins of project.json, so you can later tell which plugins a project relied on" },
        ],
      },
    ],
  },
  {
    id: "pl-perms",
    title: { zh: "权限与安全", en: "Permissions and safety" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "纯数据插件（只有效果、粒子、shader 片段、词条）不运行代码，也不申请能力。代码插件必须在清单的 permissions 里声明要用的能力，安装时会弹窗列出，只有声明过且你同意安装的能力才能用。",
          en: "Data-only plugins (effects, particles, shader snippets, strings) run no code and request no capabilities. Code plugins must declare the capabilities they use in the manifest's permissions; they are listed in a confirmation when installing, and only declared capabilities you accepted are usable.",
        },
      },
      {
        k: "table",
        head: [
          { zh: "风险", en: "Risk" },
          { zh: "能力", en: "Capabilities" },
        ],
        codeCols: [1],
        rows: [
          [{ zh: "低：只能往注册表里加东西", en: "Low: can only add entries to registries" }, same("effects shaders particles.templates particles.components importers layerKinds inspector inspector.tabs puppet.tools puppet.generators export.rules i18n commands ui settings storage")],
          [{ zh: "高：能改文档、读写工程文件或改写导出产物（安装时单独警示）", en: "High: can modify the document, read / write project files or rewrite exports (flagged separately on install)" }, same("doc history assets engine exporters export.hooks")],
        ],
      },
      {
        k: "p",
        v: {
          zh: "清单里的权限不是一锤定音：装好之后可以在插件管理里逐项关掉（默认全开），关掉立即生效，不用卸载重装。",
          en: "The permissions in the manifest are not settled once and for all: after installing you can turn each one off per plugin in the plugin manager (all are on by default), and a switch takes effect immediately — no need to uninstall and reinstall.",
        },
      },
      {
        k: "p",
        v: {
          zh: "注意：权限挡的是误用和越权调用，不是对恶意代码的沙箱——代码插件和编辑器页面同源运行。只安装你信任来源的插件。",
          en: "Note: permissions stop misuse and out-of-scope calls; they are not a sandbox against malicious code — code plugins run in the same origin as the editor page. Only install plugins from sources you trust.",
        },
      },
    ],
  },
  {
    id: "pl-examples",
    title: { zh: "示例插件", en: "Example plugins" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "仓库的 examples/plugins 里有七个示例，覆盖数据插件、低风险代码插件和需要高风险权限的代码插件。它们随应用自带、默认已安装并启用（插件管理里标为「内置示例」），不需要的可以停用；也可以复制一份当作模板：",
          en: "examples/plugins in the repository has seven examples covering data plugins, low-risk code plugins and a code plugin that needs a high-risk permission. They ship with the app and are installed and enabled by default (marked \"Bundled example\" in the plugin manager); disable any you don't need, or copy one as a template:",
        },
      },
      {
        k: "table",
        head: [
          { zh: "示例", en: "Example" },
          { zh: "类型", en: "Kind" },
          { zh: "演示", en: "Shows" },
        ],
        codeCols: [0],
        rows: [
          [same("fx-crt"), { zh: "数据", en: "Data" }, { zh: "CRT 显像管效果：效果描述 + shader 片段 include，参数面板自动生成", en: "CRT monitor effect: effect description + shader snippet include, with an auto-generated parameter panel" }],
          [same("fx-glow"), { zh: "数据", en: "Data" }, { zh: "柔光辉光：多 pass + FBO（提取高光 → 半分辨率模糊 → 叠回原图），参数分属不同 pass；用词条给效果分类起中英文名", en: "Soft glow: multi-pass with FBOs (extract highlights → half-resolution blur → add back), parameters split across passes; strings name the effect category in zh / en" }],
          [same("particle-fireflies"), { zh: "数据", en: "Data" }, { zh: "萤火虫粒子模板（只用引擎认识的组件）", en: "A firefly particle template (engine-supported components only)" }],
          [same("import-ply-pointcloud"), { zh: "代码（importers）", en: "Code (importers)" }, { zh: "同扩展名的第二个导入器 + sniff：没有面的 PLY 每个点变一个方片，有面的仍交给内置导入", en: "A second importer for an existing extension with sniff: face-less PLY files become one quad per point; meshes still go to the built-in importer" }],
          [same("export-lint-strict"), { zh: "代码（export.rules settings）", en: "Code (export.rules settings)" }, { zh: "导出规则：文件名含空格 / 非 ASCII 报错，超大文件和缺封面告警，阈值存在插件私有设置里", en: "Export rule: errors on file names with spaces / non-ASCII, warns on oversized files and a missing preview; thresholds live in the plugin's private settings" }],
          [same("inspector-layer-stats"), { zh: "代码（inspector inspector.tabs i18n）", en: "Code (inspector inspector.tabs i18n)" }, { zh: "检视器新增「统计」标签：子图层数、效果、绑定 / 脚本 / 关键帧字段数、引用的文件；只读", en: "Adds a \"Stats\" inspector tab: descendants, effects, bound / scripted / keyframed field counts and referenced files; read-only" }],
          [same("cmd-layer-align"), { zh: "代码（commands ui doc i18n，含高风险 doc）", en: "Code (commands ui doc i18n — doc is high risk)" }, { zh: "两条带快捷键的命令（⇧⌘K 居中、⇧⌘U 缩放 / 旋转归位）+ 主工具条按钮；经 doc.editObject 改文档，可撤销", en: "Two commands with shortcuts (⇧⌘K center, ⇧⌘U reset scale / rotation) plus main-toolbar buttons; edits go through doc.editObject and can be undone" }],
        ],
      },
    ],
  },
  {
    id: "pl-data",
    title: { zh: "写一个数据插件", en: "Writing a data plugin" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "一个文件夹 + 根目录的 wwgl-plugin.json 清单就是一个插件。不写 main 就是纯数据插件：",
          en: "A folder with a wwgl-plugin.json manifest at its root is a plugin. Without main it is a data-only plugin:",
        },
      },
      { k: "code", v: same(MANIFEST) },
      {
        k: "ul",
        items: [
          { zh: "id：2–64 位小写字母、数字和 -；version：x.y.z；engine：插件 API 范围（* / 1 / 1.x / ^1.0 / >=1.0，当前 API 为 1.0.0）", en: "id: 2–64 lowercase letters, digits and -; version: x.y.z; engine: the plugin API range (* / 1 / 1.x / ^1.0 / >=1.0; the current API is 1.0.0)" },
          { zh: "name / description 可以是字符串，也可以是 { \"zh-CN\": …, \"en\": … }", en: "name / description can be a string or { \"zh-CN\": …, \"en\": … }" },
          { zh: "未知的 contributes 键、无法授予的权限、看不懂的 engine 写法都会让清单无效", en: "Unknown contributes keys, ungrantable permissions or an unrecognized engine range make the manifest invalid" },
          { zh: "所有贡献先解析再登记：任何一项不合法，整个插件加载失败，已登记的部分一并撤回，不会留下半个插件", en: "All contributions are parsed before registering: if any is invalid, the whole plugin fails and anything registered is withdrawn — no half-loaded plugins" },
        ],
      },
      {
        k: "p",
        v: {
          zh: "效果描述 JSON（params 自动生成 uniform 与检视器面板；body / frag / vert 可写包内路径或内联源码；多 pass 用 passes + fbos；导出时目录前缀自动为 wwgl_<插件 id>_）：",
          en: "Effect description JSON (params generate the uniforms and the inspector panel; body / frag / vert can be a path in the package or inline source; multi-pass uses passes + fbos; the export folder prefix is wwgl_<plugin id>_ automatically):",
        },
      },
      { k: "code", v: same(EFFECT) },
      {
        k: "ul",
        items: [
          { zh: "效果 id 不要与内置效果重名（如 blur、glow），否则会盖掉内置效果；多 pass 时除最后一个外每个 pass 都要写 target，参数用 pass 指定落在哪个 pass", en: "Don't reuse a built-in effect id (such as blur or glow) or you'll override the built-in effect; in multi-pass effects every pass except the last needs a target, and each param's pass says which pass it belongs to" },
          { zh: "shader 片段：contributes.shaders 里的文件，include 名为 wwgl/<插件 id>/<文件名去扩展名>", en: "Shader snippets: files in contributes.shaders, included as wwgl/<plugin id>/<file name without extension>" },
          { zh: "粒子模板：附带的贴图写 files: [{ \"name\": <工程里的路径>, \"src\": <包内路径> }]；只能用引擎认识的粒子组件，出现别的组件整条拒绝", en: "Particle templates: bundled textures go in files: [{ \"name\": <project path>, \"src\": <package path> }]; only engine-supported particle components are allowed, otherwise the template is rejected" },
          { zh: "粒子组件（contributes 里的 \"particles.components\"，与粒子模板是两张表）：每份 JSON 写 { \"id\": <引擎组件名>, \"kind\": \"emitter\" | \"initializer\" | \"operator\" | \"renderer\", \"params\": [ … ] }；只能给引擎认识、且已登记的组件补参数描述（同 kind 同名覆盖，撤下回落到内置描述），凭空造新名字会被拒；params 与效果参数表同一套写法，组件先于模板登记，模板里的算子才对得上", en: "Particle components (\"particles.components\" in contributes — a separate registry from particle templates): each JSON is { \"id\": <engine component name>, \"kind\": \"emitter\" | \"initializer\" | \"operator\" | \"renderer\", \"params\": [ … ] }. You can only attach a parameter description to a component the engine knows and that is already registered (same kind + name overrides, and removing it falls back to the built-in description); inventing a new name is rejected. params uses the same notation as effect params, and components register before templates so a template's operators resolve" },
          { zh: "词条：{ 键: 文本 }，只能新增，不能覆盖编辑器自带文案", en: "Strings: { key: text } — they can only add entries, never override the editor's own text" },
        ],
      },
    ],
  },
  {
    id: "pl-code",
    title: { zh: "写一个代码插件", en: "Writing a code plugin" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "清单里写 \"main\": \"index.js\" 并在 permissions 里声明要用的能力。index.js 是单文件 ESM，默认导出一个插件；inject 列出依赖的服务，全部就绪才会调用 apply，任一消失会自动撤销、恢复后自动重新 apply。经 ctx 做的一切（贡献、监听、定时器）在停用或卸载时都会被逆序撤销。",
          en: "Set \"main\": \"index.js\" in the manifest and declare the capabilities you use in permissions. index.js is a single-file ESM module whose default export is a plugin; inject lists the services it depends on — apply runs once they are all ready, is undone if any disappears, and re-runs when they return. Everything done through ctx (contributions, listeners, timers) is undone in reverse order on disable or uninstall.",
        },
      },
      { k: "code", v: same(CODE_PLUGIN) },
      {
        k: "ul",
        items: [
          { zh: "apply(ctx, host) 的 host 提供 manifest、file(path) / text(path) 读包内文件，以及按插件隔离的 settings 与 storage", en: "host in apply(ctx, host) provides the manifest, file(path) / text(path) to read package files, and settings / storage isolated per plugin" },
          { zh: "SDK：pnpm build:plugin-sdk 生成 dist/plugin-sdk（包名 @webwallgl/plugin-sdk，类型声明 + definePlugin）", en: "SDK: pnpm build:plugin-sdk produces dist/plugin-sdk (package @webwallgl/plugin-sdk: type declarations + definePlugin)" },
          { zh: "构建：node scripts/build-plugin-sdk.mjs --plugin <插件目录> 把 src/index.ts 打成 index.js；只允许从 SDK 导入，直接 import 编辑器或渲染器源码会被拒绝", en: "Build: node scripts/build-plugin-sdk.mjs --plugin <plugin folder> bundles src/index.ts into index.js; only SDK imports are allowed — importing editor or renderer sources directly is rejected" },
          { zh: "shader 源码可以放进单独的 .glsl 文件再 import（构建时打成文本模块，剥掉注释和空行，// {\"material\": …} 这类契约注释保留）", en: "Shader source can live in its own .glsl file and be imported (bundled as a text module; comments and blank lines are stripped, while contract comments such as // {\"material\": …} are kept)" },
          { zh: "开发流程：插件目录放进 ~/.webwallgl/plugins/（或用 WWGL_PLUGIN_DIRS 指向工作目录）→ pnpm dev 打开工作台 → 改源码后重新构建，编辑器约 1.5 秒内自动热重载", en: "Workflow: put the plugin folder in ~/.webwallgl/plugins/ (or point WWGL_PLUGIN_DIRS at your working folder) → pnpm dev and open the workbench → rebuild after editing, and the editor hot-reloads within about 1.5 seconds" },
          { zh: "替换内置能力：同名服务后提供的生效，撤下后回落到上一个；同 id 的注册项也是后加优先", en: "Replacing built-ins: the last provider of a service wins and removing it falls back to the previous one; registry entries with the same id also favor the latest" },
          { zh: "命令：用 ctx.get(\"commands\").register(def, ctx.name) 注册（内置的那几条也走同一个入口）；def = { id, title, category, keys, needsArg, when, run }——title / category 可以是 { zh, en } 或词条名（缺省按 cmd.<id> 找词条、再退回 id 字面量，分类缺省归到「其它」），keys 写 \"Mod+Shift+K\"（Mod = ⌘ / Ctrl）或一串等价键，when() 为假时命令在面板里列为不可用，needsArg 表示这条命令要参数、面板只列出不执行；注册的命令进 ⌘K / Ctrl+K 的命令面板，同一个键后注册的优先（可盖过内置命令）；返回撤销函数，owner 用于记归属、随插件卸载一起撤回", en: "Commands: register with ctx.get(\"commands\").register(def, ctx.name) — the built-in ones go through the same entry point. def = { id, title, category, keys, needsArg, when, run }: title / category take { zh, en } or an i18n key (by default the key cmd.<id> is looked up, then the literal id; a category defaults to \"Other\"), keys is \"Mod+Shift+K\" (Mod = ⌘ / Ctrl) or an array of equivalent shortcuts, a false when() lists the command as unavailable, and needsArg means the command takes arguments so the palette lists it without running it. Registered commands appear in the ⌘K / Ctrl+K palette, and for the same key the later registration wins (so a built-in command can be overridden); it returns a disposer, and owner records the contribution so it is withdrawn with the plugin" },
          { zh: "界面槽位：用 ctx.get(\"ui\").add(slot, { id, order, render }) 加元素，render() 返回一个 HTMLElement（或 null）；宿主目前为 toolbar / menu.add / menu.export / inspector.project / panel.right / statusbar / viewport.overlay 七个槽位提供落点，同一槽位里 order 小的在前（缺省 0），没有任何贡献的槽位连占位都不显示，切语言或贡献变化时槽位会整体重建，所以文案要在 render 里按当前语言取。导出下拉里的项：宿主先关掉菜单，点击交给插件自己的监听处理", en: "UI slots: add elements with ctx.get(\"ui\").add(slot, { id, order, render }), where render() returns an HTMLElement (or null); the host currently provides a home for seven slots — toolbar / menu.add / menu.export / inspector.project / panel.right / statusbar / viewport.overlay. Within a slot, a smaller order comes first (default 0), a slot with no contributions shows nothing at all, and slots are rebuilt as a whole on language change or when contributions change — so read the current language inside render. For items in the export dropdown the host closes the menu first and leaves the click to the plugin's own listener" },
          { zh: "完整契约见仓库 docs/PLUGIN-ARCHITECTURE.md", en: "The full contract is in docs/PLUGIN-ARCHITECTURE.md in the repository" },
        ],
      },
    ],
  },
];
