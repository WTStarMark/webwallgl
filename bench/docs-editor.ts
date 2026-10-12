import type { DocSection } from "./docs";

export const EDITOR_DOC: DocSection[] = [
  {
    id: "ed-intro",
    title: { zh: "编辑器简介", en: "What the editor is" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "播放与编辑是同一个工作台：左侧「壁纸库」点一下就播放，同时可以直接改。新建的工程默认存在这台机器的浏览器存储里（刷新、重开编辑器都还在），改动自动保存；想拿到松散文件用「存到本机文件夹…」。从壁纸库打开的壁纸，按 ⌘S 选一个文件夹另存为项目之后也会自动保存——壁纸库里的原文件永远不改。导出时才选择打成 scene.pkg，或打成 zip 压缩包。",
          en: "Playing and editing share one workbench: click an item in the Library tab to play it and edit it right away. New projects live in this machine's browser storage by default (they survive a reload or restart) and autosave; use \"Save to local folder…\" when you want loose files. A wallpaper opened from the library starts autosaving once ⌘S saves it as a project in a folder you pick — library files are never modified. Export is when you choose a scene.pkg package or a zip archive.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "入口：根地址会转到工作台；本地开发地址为 http://localhost:1430/editor/，?item=<itemId> 直接打开库里的某个壁纸", en: "Entry: the root URL redirects to the workbench; the local dev URL is http://localhost:1430/editor/, and ?item=<itemId> opens that library wallpaper directly" },
          { zh: "按图层编辑的只有场景（Scene）壁纸；网页与视频壁纸可以播放、调「壁纸配置」，也能打开 / 另存为对应的工程（网页壁纸工程里的站点文件、视频壁纸工程里的视频原样保存），只是不参与图层编辑", en: "Layer editing applies to scene wallpapers; web and video wallpapers can be played and configured, and can also be opened / saved as their own kind of project (a web project keeps the site files, a video project keeps the video, unchanged) — they just take no part in layer editing" },
          { zh: "编辑器的功能都由插件提供，你也可以装外部插件添加效果、粒子、导入格式、导出目标等——见顶部切换到「插件」的说明", en: "Every editor feature is provided by a plugin, and you can install external plugins to add effects, particles, import formats, export targets and more — see the \"Plugins\" guide via the switch at the top" },
          { zh: "快捷键里的 ⌘ 在 Windows / Linux 上对应 Ctrl", en: "⌘ in shortcuts means Ctrl on Windows / Linux" },
        ],
      },
    ],
  },
  {
    id: "ed-layout",
    title: { zh: "界面布局", en: "Layout" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "区域", en: "Area" },
          { zh: "用途", en: "What it does" },
        ],
        rows: [
          [{ zh: "主工具条（顶）", en: "Main toolbar (top)" }, { zh: "新建 / 打开 .pkg / 打开项目 / 导出、撤销 / 重做、播放 / 暂停、重新加载、导出 PNG、插件、重置布局；右上角是赞赏、使用说明（?）、主题与语言", en: "New / Open .pkg / Open project / Export, undo / redo, play / pause, reload, export PNG, plugins, reset layout; sponsor, guide (?), theme and language sit at the top right" }],
          [{ zh: "图层 | 壁纸库（左）", en: "Layers | Library (left)" }, { zh: "图层树显示当前场景的全部对象；壁纸库按 Scene / Web / Video 过滤，点条目即播放并打开编辑，右键可新窗口播放、打开所在文件夹或删除", en: "The layer tree lists every object in the current scene; the library filters by Scene / Web / Video — click an item to play and edit it, right-click to play in a new window, reveal its folder or delete it" }],
          [{ zh: "视口 | 使用说明（中）", en: "Viewport | Guide (center)" }, { zh: "视口工具条切宽高比、适配方式与渲染 DPR；下方时间轴负责回到开头、逐帧、拖动定位和倍速，并按图层与字段（可切「全部字段」）显示动画条与关键帧。「使用说明」就是本页", en: "The viewport bar switches aspect ratio, fit and render DPR; the timeline below handles rewind, frame stepping, scrubbing and speed, and shows animation bars and keyframes per layer and per field (switch \"All fields\"). \"Guide\" is this page" }],
          [{ zh: "检视器 | 壁纸配置 | 渲染（右）", en: "Inspector | Wallpaper config | Render (right)" }, { zh: "检视器：不选图层时显示工程信息与用户属性，选中图层后按「属性 / 动画 / 模型 / 效果 / 逻辑 / 信息」分标签显示（见下方「检视器」）。壁纸配置：库条目的自定义属性（只记在本机，场景即时生效）。渲染：帧率上限、音量、抗锯齿 / 粒子 / 后处理档位，以及「系统实况」开关（全局）", en: "Inspector: project info and user properties with nothing selected; a selected layer is split into Properties / Animation / Model / Effects / Logic / Info tabs (see \"Inspector\" below). Wallpaper config: a library item's custom properties (stored on this machine, live for scenes). Render: FPS cap, volume, anti-aliasing / particle / post-processing levels, and the \"System live\" switch (global)" }],
          [{ zh: "控制台 | 性能（底）", en: "Console | Performance (bottom)" }, { zh: "控制台记录打开、保存、编辑操作与渲染器诊断；性能是实测帧率曲线（虚线为帧率上限）", en: "The console logs opening, saving, edits and renderer diagnostics; Performance plots the measured frame rate (the dashed line is the FPS cap)" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "各面板可拖动分隔条调整尺寸、双击分隔条收起，尺寸会被记住；工具条最右的「重置布局」恢复默认。",
          en: "Drag the splitters to resize panels and double-click one to collapse it; sizes are remembered. \"Reset layout\" at the right end of the toolbar restores the defaults.",
        },
      },
    ],
  },
  {
    id: "ed-open",
    title: { zh: "新建与打开", en: "Creating and opening" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "从壁纸库打开：左侧「壁纸库」标签点条目即播放，可直接编辑；状态栏提示「⌘S 另存为项目」，存过之后就和普通项目一样自动保存", en: "Open from the library: click an item in the Library tab to play it and edit it directly; the status bar shows \"⌘S to save as project\", after which it autosaves like any project" },
          { zh: "新建：直接选分辨率和「空白」或「以图片为背景」，工程默认放进浏览器存储（IndexedDB），改动自动保存；想放到本机文件夹，随后在「打开项目」里点「存到本机文件夹…」", en: "New: pick a resolution and \"Blank\" or \"Image background\"; the project goes to browser storage (IndexedDB) by default and autosaves. To move it to a real folder, use \"Save to local folder…\" in Open project afterwards" },
          { zh: "打开项目：列出这台机器上存的工程（浏览器存储，刷新 / 重开都还在），选中即打开；也可以「打开本地文件夹…」直接打开磁盘上的松散工程", en: "Open project: lists the projects stored on this machine (browser storage — they survive a reload or restart); pick one to open, or use \"Open local folder…\" to open a loose project on disk" },
          { zh: "打开 .pkg：选 scene.pkg 后内容解开成松散文件再编辑；「打开 .pkg」在「打开项目」面板里", en: "Open .pkg: pick a scene.pkg and its contents are unpacked to loose files for editing; \"Open .pkg\" lives in the Open project panel" },
          { zh: "网页 / 视频壁纸工程：打开网页壁纸时工程本体是那堆站点文件，打开视频壁纸时是那个视频文件——都原样保存、不参与图层编辑", en: "Web / video wallpaper projects: a web project's body is its site files and a video project's is its video file — both are kept as-is and take no part in layer editing" },
          { zh: "拖入图片：已打开项目则加为图片层；还没有项目时先新建再放入", en: "Drop images: they become layers when a project is open; otherwise a project is created first" },
          { zh: "自动保存：改动后约半秒写回工程（scene.json、资源、封面），⌘S 立刻再写一次。工程在浏览器存储里时同样自动保存", en: "Autosave: edits are written back after about half a second (scene.json, assets, cover); ⌘S writes immediately. Projects kept in browser storage autosave the same way" },
          { zh: "没保存的内容找回来：上一次编辑没写进文件就中断（崩溃、误关标签页）时，顶部会出现一条横幅，写明是哪份内容、什么时间的快照，点「恢复」接着改，点「丢弃」就不再提示", en: "Recovering unsaved work: if the last edit never made it to a file (crash, tab closed by accident), a banner at the top names the content and the snapshot time — Restore continues from it, Discard stops asking" },
          { zh: "壁纸自带的脚本默认被拦截（画面停在脚本初始值），确认来源可信后可点「仍然执行」，仅对本次打开有效", en: "Scripts bundled with a wallpaper are blocked by default (the canvas stays at their initial values); click \"Run anyway\" once you trust the source — it applies to this session only" },
        ],
      },
    ],
  },
  {
    id: "ed-canvas",
    title: { zh: "画面操作与图层", en: "Canvas and layers" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "操作", en: "Action" },
          { zh: "效果", en: "Result" },
        ],
        rows: [
          [{ zh: "点击画面", en: "Click the canvas" }, { zh: "选中该处最上层的可见图层", en: "Selects the topmost visible layer under the cursor" }],
          [{ zh: "Alt + 点击", en: "Alt + click" }, { zh: "在同一位置叠在一起的图层间逐层切换", en: "Cycles through layers stacked at that point" }],
          [{ zh: "拖动图层", en: "Drag a layer" }, { zh: "移动位置", en: "Moves it" }],
          [{ zh: "拖动角点", en: "Drag a corner" }, { zh: "缩放；按住 ⇧ 等比", en: "Scales it; hold ⇧ to keep proportions" }],
          [{ zh: "拖动顶部圆柄", en: "Drag the top handle" }, { zh: "旋转；按住 ⇧ 吸附 15°", en: "Rotates it; hold ⇧ to snap to 15°" }],
        ],
      },
      {
        k: "ul",
        items: [
          { zh: "图层树：眼睛图标切换可见性，锁形图标锁定（锁定后不参与点选与拖动，也不能编辑）", en: "Layer tree: the eye icon toggles visibility; the lock icon locks a layer (locked layers can't be picked, dragged or edited)" },
          { zh: "改名：双击图层名或选中后按 F2 就地改名（回车确认、Esc 取消），也可以在检视器「属性」页的「名称」里改；可撤销，场景脚本里按名字取图层也随之生效", en: "Rename: double-click a layer name or select it and press F2 to rename in place (Enter confirms, Esc cancels), or edit \"Name\" on the inspector's Properties tab; it's undoable, and scene scripts that look layers up by name follow the new name" },
          { zh: "图层工具（图层标签下的工具行）：添加图片 / 文字（文字、时钟、日期）/ 粒子（雪、雨、火花、光点）/ 视频 / 声音层，导入模型，前移 / 后移一层，成组，复制（⌘D），删除（Delete）", en: "Layer tools (the toolbar row under the Layers tab): add image / text (text, clock, date) / particle (snow, rain, embers, bokeh) / video / sound layers, import a model, move up / down, group, duplicate (⌘D), delete (Delete)" },
          { zh: "容器层：新建的空组，效果作用在整棵子树上（给一组图层加同一套效果，不必逐个加）", en: "Container layer: an empty group whose effects apply to its whole subtree (one set of effects for a group instead of one per layer)" },
          { zh: "全屏后期层：效果作用在整幅画面上；尺寸由引擎按画布分辨率覆盖，对象自己的 origin / scale 只当预览框。可标「直通」（效果只作用在画面背板上）或「全屏后期」（铺满画布）", en: "Full-screen post layer: effects apply to the entire picture; the engine overrides its size to the canvas resolution and the layer's own origin / scale act as a preview box only. Mark it \"Passthrough\" (effects hit the backdrop only) or \"Fullscreen\" (covers the canvas)" },
          { zh: "相机层与灯光层：添加相机（fov / zoom）或灯光（point / spot / tube / directional）作为场景对象，在检视器里调参数", en: "Camera and light layers: add a camera (fov / zoom) or a light (point / spot / tube / directional) as a scene object and tune it in the inspector" },
          { zh: "实心层：检视器里可把图层标为「实心（可被点选 / 参与遮挡）」——引擎按 solidlayer 前缀判定", en: "Solid layer: mark a layer \"Solid\" in the inspector so it can be picked and occludes other layers — the engine recognises it by the solidlayer prefix" },
          { zh: "拖入文件：图片、视频（mp4 / mov / webm，不是 H.264 的自动转码）、音频（mp3 / ogg / wav / flac）直接拖进画面即可新建对应图层", en: "Drop files: images, videos (mp4 / mov / webm; non-H.264 is transcoded automatically) and audio (mp3 / ogg / wav / flac) dropped onto the viewport become layers" },
          { zh: "导入模型：支持 .glb / .gltf / .fbx / .obj / .dae / .stl / .ply / .3ds，外部 .bin / .mtl / 贴图一起选上；带骨骼的转成可动画的 puppet，否则转成网格", en: "Import model: .glb / .gltf / .fbx / .obj / .dae / .stl / .ply / .3ds — select external .bin / .mtl / textures together; rigged models become animatable puppets, others become meshes" },
          { zh: "成组：新建空组把选中层放进去，画面不变；图层也可以在树里直接拖进 / 拖出其他层", en: "Group: wraps the selected layer in a new empty group without changing the picture; layers can also be dragged into / out of other layers in the tree" },
          { zh: "前移 = 更早绘制，会被后面的层盖住；后移 = 更晚绘制，盖在前面的层之上", en: "Move up = drawn earlier, so later layers cover it; move down = drawn later, on top of earlier layers" },
          { zh: "透视相机场景暂不支持画面拾取，请在图层树里选择", en: "Scenes with a perspective camera can't be picked on the canvas yet; select layers in the tree instead" },
        ],
      },
    ],
  },
  {
    id: "ed-timeline",
    title: { zh: "时间轴与关键帧", en: "Timeline and keyframes" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "底部时间轴按图层列出动画条，拖动播放头定位，暂停后逐帧检查动画最方便。关键帧可以直接在条上改。",
          en: "The timeline at the bottom lists animation bars per layer; drag the playhead to seek, and pausing then stepping frames is the easiest way to inspect animation. Keyframes are edited right on the bars.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "播放控制：回到开头、上一帧 / 下一帧、倍速；快捷键 ←/→ 挪 1 帧、⇧ 加方向键挪 10 帧", en: "Playback: go to start, previous / next frame, speed; ←/→ step 1 frame and ⇧ with the arrow keys steps 10" },
          { zh: "按属性分行：每个图层先有一条「全部字段」的汇总条，把该层所有字段的关键帧并在一起；下拉切成具体字段（位置 / 缩放 / 旋转 / 透明度 / 颜色 …）即可只看这一个属性的关键帧", en: "Per-field lanes: each layer starts with an \"All fields\" summary bar merging every field's keyframes; switch the dropdown to one field (position / scale / rotation / opacity / color …) to see only that property's keys" },
          { zh: "选中关键帧后出现选择条，写明「图层 · 字段 · 时间」，并给出「删除关键帧」与「改平滑 / 改线性」两个动作", en: "Selecting a keyframe opens a bar naming \"layer · field · time\" with \"Delete key\" and \"Make smooth / Make linear\" actions" },
          { zh: "←/→ 挪 1 帧（⇧ 10 帧）、Delete 删除、双击在平滑与线性之间切换；平滑 = 缓入缓出，是整条动画两侧手柄的开关", en: "←/→ nudges 1 frame (⇧ 10), Delete removes, double-click toggles smooth / linear; smooth means ease in and out and switches both handles of the whole animation" },
          { zh: "空态：工程还没有动画层时，时间轴会提示到「检视器 → 动画」给图层开一条动画，条与关键帧随即出现", en: "Empty state: with no animation layers yet, the timeline points you to Inspector → Animation; turn on an animation for a layer and its bar and keyframes show up" },
        ],
      },
    ],
  },
  {
    id: "ed-inspector",
    title: { zh: "检视器", en: "Inspector" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "选中图层后，检视器按功能分成多个标签，只显示与该图层相关的标签（例如模型标签只在模型层出现）；最后停留的标签会被记住。不选图层时显示工程信息与用户属性。",
          en: "With a layer selected, the inspector is split into tabs by function and only shows the tabs that apply (the Model tab, for example, only appears for model layers); the last tab you used is remembered. With nothing selected it shows project info and user properties.",
        },
      },
      {
        k: "table",
        head: [
          { zh: "标签", en: "Tab" },
          { zh: "说明", en: "Details" },
        ],
        rows: [
          [{ zh: "属性", en: "Properties" }, { zh: "变换与外观：位置、缩放、旋转（以度显示）、尺寸、不透明度、颜色、可见，改动当帧生效并写回文档（变换绑了脚本或动画的层会被覆盖）；文字 / 粒子 / 声音 / 视频层各自的参数；附着到父层或骨骼。多选时可批量改", en: "Transform & appearance: position, scale, rotation (in degrees), size, opacity, color and visibility — applied on the next frame and written to the document (layers driven by a script or animation get overridden); the specific settings of text / particle / sound / video layers; attaching to a parent layer or bone. Works on multi-selection too" }],
          [{ zh: "动画", en: "Animation" }, { zh: "图层关键帧动画；模型层的动画层与动画片段（增删、改元数据、帧事件）", en: "Layer keyframe animation; for models, animation layers and clips (add / remove, metadata, frame events)" }],
          [{ zh: "模型", en: "Model" }, { zh: "模型信息、材质贴图替换、骨骼列表与姿势编辑（视口里可直接点选骨骼）；「操控变形」入口也在这里（见下方专门一节）", en: "Model info, material texture replacement, bone list and pose editing (bones can be picked in the viewport); the puppet-warp entry lives here too (see its own section below)" }],
          [{ zh: "效果", en: "Effects" }, { zh: "可添加颜色叠加、色彩调整、暗角、模糊、波浪、滚动、呼吸以及插件提供的效果；每个效果可启停、调整先后顺序或移除。作品自带的外部效果参数也能在这里直接改（参数与编译期分支内联进工程），「效果库」还能把本机壁纸库里的效果加进来", en: "Add tint, color adjust, vignette, blur, wave, scroll, pulse or plugin-provided effects; each can be toggled, reordered or removed. Parameters of external effects shipped with the wallpaper are editable here too (parameters and compile-time branches are inlined into the project), and the effect library adds effects from the local wallpaper library" }],
          [{ zh: "逻辑", en: "Logic" }, { zh: "属性绑定：把用户属性绑到图层的可见、不透明度、亮度、缩放、颜色或文本上。脚本：给图层字段挂 SceneScript，新建时可挑生命周期模板（update / init / applyUserProperties / cursor* / media* / resizeScreen / animationEvent / destroy 共 8 类），实时检查语法和入口，Tab 缩进，⌘Enter 应用，移除后字段回到快照值", en: "Property bindings: bind user properties to a layer's visibility, opacity, brightness, scale, color or text. Scripts: attach a SceneScript to a layer field and pick one of the 8 lifecycle templates when creating it (update / init / applyUserProperties / cursor* / media* / resizeScreen / animationEvent / destroy); syntax and entry points are checked as you type, Tab indents, ⌘Enter applies, and removing it restores the snapshot value" }],
          [{ zh: "信息", en: "Info" }, { zh: "只读：字段一览与当前对象在 scene.json 中的原始 JSON，便于核对", en: "Read-only: a field overview and the object's raw JSON in scene.json, for reference" }],
          [{ zh: "用户属性（不选图层时）", en: "User properties (nothing selected)" }, { zh: "场景级声明，类型有滑条、颜色、开关、下拉、文本；可设显示名、默认值、范围（最小 最大 步长）或选项（每行「值=标签」）", en: "Declared at scene level. Types: slider, color, bool, combo and text; set the display name, default value, range (min max step) or options (one \"value=label\" per line)" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "右栏另外两个标签：「壁纸配置」调壁纸库条目的自定义属性（只记在本机，场景壁纸即时生效，网页 / 视频壁纸会重新加载；勾「显示条件隐藏项」可看到被条件隐藏的项）；「渲染」是全局的帧率上限、音量、抗锯齿 / 粒子 / 后处理档位与「系统实况」开关，改动即时生效、不写进工程（见「系统实况与媒体」）。",
          en: "The other two right-hand tabs: \"Wallpaper config\" edits a library item's custom properties (stored on this machine, live for scenes, web / video wallpapers reload; tick \"Show hidden\" to see condition-hidden entries); \"Render\" holds the global FPS cap, volume, anti-aliasing / particle / post-processing levels and the \"System live\" switch — applied instantly, never written into the project (see \"System live and media\").",
        },
      },
    ],
  },
  {
    id: "ed-scene",
    title: { zh: "场景设置", en: "Scene settings" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "工具条上的「场景设置」改的是这份壁纸自己的参数（scene.json 的 general 段）：写进工程、改一次进一次撤销栈；和右栏「渲染」那份本机偏好是两回事。要打开一个场景工程之后才能改。",
          en: "\"Scene settings\" in the toolbar edits the wallpaper's own parameters (scene.json general): written into the project and undoable one change at a time — a different thing from the local \"Render\" preferences on the right. It needs a scene project open.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "清屏与环境光：清屏开关、清屏色、环境光色、天光色", en: "Clear & ambient: clear-screen switch, clear color, ambient color, skylight color" },
          { zh: "相机：视角 FOV、近 / 远裁剪面、缩放、透视 FOV 覆盖、相机渐入", en: "Camera: FOV, near / far clip, zoom, perspective FOV override, camera fade" },
          { zh: "相机抖动：开关、幅度、粗糙度、速度", en: "Camera shake: switch, amplitude, roughness, speed" },
          { zh: "鼠标视差：开关、幅度、延迟、鼠标影响", en: "Mouse parallax: switch, amount, delay, mouse influence" },
          { zh: "泛光 / HDR：泛光开关与强度 / 阈值 / 染色；HDR 开关与强度 / 阈值 / 扩散 / 羽化 / 迭代次数", en: "Bloom / HDR: bloom switch with strength / threshold / tint; HDR switch with strength / threshold / scatter / feather / iterations" },
          { zh: "每项标「未设置 / 已设」；被脚本或动画驱动（写了包装）的键会标「脚本 / 动画」，面板不会覆盖它", en: "Each key is marked unset / set; keys driven by a script or animation are marked \"scripted\" and the panel leaves them alone" },
          { zh: "面板只写上面列出的键：文档里的未知键、正交投影与相机预览等保持原样", en: "The panel only writes the keys listed above; unknown keys, orthogonal projection and camera preview are left untouched" },
        ],
      },
    ],
  },
  {
    id: "ed-effects",
    title: { zh: "效果与效果库", en: "Effects and the effect library" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "图层效果：颜色叠加、色彩调整、暗角、模糊、波浪、滚动、呼吸，以及插件提供的效果；每个效果可启停、调先后顺序、移除，参数改动写进工程的 scene.json", en: "Layer effects: tint, color adjust, vignette, blur, wave, scroll, pulse and plugin-provided effects; each can be toggled, reordered and removed, and parameter changes go into the project's scene.json" },
          { zh: "效果库（本机壁纸库）：只读枚举本机壁纸库里的松散效果目录，点「添加引用」就能用作品自带的那些效果；工程只写引用，效果文件留在壁纸库里（换台机器打开可能缺效果）", en: "Effect library (local wallpaper library): read-only enumeration of the loose effect folders in the local wallpaper library — \"Add reference\" brings the wallpaper's own effects in. The project stores only the reference; effect files stay in the library (another machine may be missing them)" },
          { zh: "面板会标出「库内 / 已在工程」，并统计有多少条目把效果打包在 scene.pkg 里（打包的不解包，只列出来）", en: "Entries are marked \"in library / in project\", with a count of items whose effects are packed inside scene.pkg (packed ones are listed but not unpacked)" },
          { zh: "编译期分支（combos）：勾选 = 写 1、取消勾选 = 写 0，都写进工程并覆盖材质声明的默认档；「复位」删掉覆盖、回到库内默认", en: "Compile-time branches (combos): ticking writes 1 and unticking writes 0, both into the project, overriding the material's declared defaults; \"Reset\" drops the override and returns to the library default" },
          { zh: "作品自带效果的参数可以直接在检视器里改：折叠面板按参数分组，未知参数与缺文件会标出来", en: "Parameters of wallpaper-shipped effects are editable right in the inspector: collapsible groups by parameter, with unknown parameters and missing files flagged" },
        ],
      },
    ],
  },
  {
    id: "ed-warp",
    title: { zh: "操控变形", en: "Puppet warp" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "操控变形把一张图片变成可以拖拽形变的「木偶」：按图片像素建三角网格，每个钉子一根骨、顶点权重按钉子距离分配。转完画面逐像素不变，之后拖钉子就像 Live2D 那样拉形变。入口在检视器的「模型」标签里。",
          en: "Puppet warp turns an image into a draggable puppet: a triangle mesh built from the image pixels, one bone per pin, vertex weights split by pin distance. The picture stays pixel-identical after conversion; from then on dragging pins deforms it like a Live2D puppet. The entry sits on the inspector's Model tab.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "转为操控变形木偶：把当前图片层转成木偶（会写回 .mdl 片段）；转换只做一次，之后随时可以退出 / 再进入操控变形", en: "Convert to puppet warp: turns the image layer into a puppet (written back into an .mdl clip); conversion happens once and you can leave / re-enter the warp mode any time" },
          { zh: "在视口里拖钉子实时预览（预览不进文档），「记录关键帧」把当前形变写进 .mdl 片段；「复位预览」丢弃未记录的位移", en: "Drag pins in the viewport for a live preview (not written to the document); \"Record keyframe\" writes the current deformation into the .mdl clip, \"Reset preview\" drops unrecorded moves" },
          { zh: "面板显示「钉子数 / 上限 · 当前第几帧 · 有几根钉子有未记录的位移」，并有：加钉子、删除这根钉子、衰减、网格密度、记录关键帧、复位预览、烘焙形变", en: "The panel shows \"pins / max · current frame · pins with unrecorded moves\" and offers: add pin, delete this pin, falloff, mesh density, record keyframe, reset preview, bake deformation" },
          { zh: "钉子数量有上限；建不了网格或读不到骨架时面板会直接说明原因，不会留下半个木偶", en: "The pin count is capped; if a mesh can't be built or the skeleton can't be read the panel says why instead of leaving half a puppet behind" },
        ],
      },
    ],
  },
  {
    id: "ed-media",
    title: { zh: "系统实况与媒体", en: "System live and media" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "「渲染」里的「系统实况」开关：把系统正在播放的声音频谱与「正在播放」信息（歌名 / 专辑封面）喂给引擎；音频反应层（频谱条等）与封面层才会跟着系统声音动", en: "The \"System live\" switch under Render feeds the spectrum and now-playing info (title / album art) of what your system is playing to the engine, so audio-reactive layers (bars, etc.) and cover layers move with the system sound" },
          { zh: "封面：播放器自己不提供封面时，宿主会按「歌名 + 歌手」去公开曲库补一张（歌名对得上才采用，歌手只加分），结果缓存 30 天", en: "Artwork: when the player offers none, the host fetches one from public catalogues by title + artist (the title must match; the artist only raises the score) and caches it for 30 days" },
          { zh: "脚本侧对应 media* 一组回调：属性、缩略图、播放、时间轴、状态、歌词", en: "Scripts get a matching set of media* callbacks: properties, thumbnail, playback, timeline, state and lyrics" },
          { zh: "编辑器预览不会占住系统的「正在播放」：停止试听或把音量归零时会释放媒体会话，你自己的播放器不受影响", en: "The editor preview does not hold the system's now-playing slot: stopping the preview or dropping the volume to zero releases the media session, leaving your own player alone" },
        ],
      },
    ],
  },
  {
    id: "ed-playback",
    title: { zh: "预览与导出", en: "Preview and export" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "播放 / 暂停、重新加载（按当前文档重新挂载场景）", en: "Play / pause, and reload (remounts the scene from the current document)" },
          { zh: "时间轴：回到开头、上一帧 / 下一帧、拖动定位、倍速；暂停后逐帧检查动画最方便（见「时间轴与关键帧」）", en: "Timeline: rewind, previous / next frame, scrub and speed; pausing and stepping frames is the easiest way to inspect animation (see \"Timeline and keyframes\")" },
          { zh: "视口：宽高比（可选填满视口）、适配方式（裁切填满 / 完整显示 / 拉伸）、渲染 DPR", en: "Viewport: aspect ratio (or fill the viewport), fit (cover / contain / stretch) and render DPR" },
          { zh: "导出 PNG：按场景分辨率导出当前帧", en: "Export PNG: saves the current frame at the scene's resolution" },
        ],
      },
    ],
  },
  {
    id: "ed-save",
    title: { zh: "自动保存与导出", en: "Autosave and export" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "动作", en: "Action" },
          { zh: "说明", en: "Details" },
        ],
        rows: [
          [{ zh: "自动保存", en: "Autosave" }, { zh: "改动写入工程（浏览器存储里的虚拟工程，或本机文件夹里的松散文件），不写进壁纸库；写盘失败时草稿是唯一副本，编辑器会保留它", en: "Edits go into the project (a virtual project in browser storage, or loose files in a local folder), never into the wallpaper library; if writing fails the draft is the only copy and the editor keeps it" }],
          [{ zh: "存到本机文件夹", en: "Save to local folder" }, { zh: "把浏览器存储里的工程整份写进选定的文件夹，之后的自动保存改到那里（工程卡上的同名按钮）", en: "Writes the whole browser-stored project into a folder you pick and moves autosave there (same button on the project card)" }],
          [{ zh: "打包导出 scene.pkg", en: "Export scene.pkg" }, { zh: "下载一个 zip：project.json、封面和 scene.pkg（图片贴图转为 .tex），官方 Wallpaper Engine 可直接加载", en: "Downloads a zip of project.json, the cover and scene.pkg (image textures become .tex) that the official Wallpaper Engine loads" }],
          [{ zh: "压缩包导出 .zip", en: "Export .zip" }, { zh: "下载松散工程的 zip 压缩包", en: "Downloads a zip of the loose project" }],
          [{ zh: "导出到文件夹", en: "Export to folder" }, { zh: "写成创意工坊上传用的目录结构", en: "Writes the folder layout used for Workshop uploads" }],
          [{ zh: "录制为视频 .mp4", en: "Record as video .mp4" }, { zh: "按设定的分辨率、帧率、时长逐帧渲染后编码（不丢帧，比实时慢，不含声音）", en: "Renders frame by frame at the chosen resolution, frame rate and duration, then encodes (no dropped frames, slower than real time, no audio)" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "导出前会做 Wallpaper Engine 兼容性检查，发现错误时详情写进控制台并先确认是否仍要导出；插件也可以追加导出目标和检查项。",
          en: "Export first runs a Wallpaper Engine compatibility check; errors are written to the console and you're asked whether to export anyway. Plugins can add export targets and checks.",
        },
      },
      {
        k: "p",
        v: {
          zh: "导出不会改工程里的松散文件。状态栏显示保存中 / 已保存 / 未保存。⌘S 立刻把当前文档再写一次。",
          en: "Export does not replace the project's loose files. The status bar shows Saving / Saved / Unsaved. ⌘S writes the current document immediately.",
        },
      },
    ],
  },
  {
    id: "ed-plugins",
    title: { zh: "插件", en: "Plugins" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "主工具条的「插件」打开插件管理。插件可以添加效果、粒子模板、shader 片段、导入格式、导出目标和检视器面板；内置功能本身也是插件。管理器里每个插件的权限可以逐项开关，运行日志也在同一面板里。",
          en: "\"Plugins\" in the main toolbar opens the plugin manager. Plugins can add effects, particle templates, shader snippets, import formats, export targets and inspector panels; the built-in features are plugins too. Each plugin's permissions are toggled one by one, and its log lives in the same panel.",
        },
      },
      {
        k: "p",
        v: {
          zh: "安装、权限、示例，以及怎么自己写数据插件 / 代码插件，见本页顶部切换到「插件」的完整说明（插件管理弹窗里的「插件说明」也会直达）。",
          en: "For installing, permissions, examples and writing your own data / code plugins, switch to \"Plugins\" at the top of this page for the full guide (\"Plugin guide\" in the plugin manager goes there too).",
        },
      },
    ],
  },
  {
    id: "ed-palette",
    title: { zh: "命令面板与无障碍", en: "Command palette and accessibility" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "⌘K（或 ⇧⌘P）打开命令面板：输入命令名、快捷键或分类过滤，↑↓ 选择、Enter 执行、⌘K / Esc 关闭；插件登记的命令和快捷键也会出现在这里", en: "⌘K (or ⇧⌘P) opens the command palette: filter by command name, shortcut or category; ↑↓ to choose, Enter to run, ⌘K / Esc to close. Commands and shortcuts registered by plugins show up here too" },
          { zh: "命令不可用时面板会说明原因（缺条件、需要参数），不会静默失败", en: "When a command can't run the palette says why (missing condition, needs an argument) instead of failing silently" },
          { zh: "「快捷键总览」按命令注册表动态生成，因此永远不会和实际快捷键对不上", en: "The shortcut overview is generated from the command registry, so it can never drift from the real shortcuts" },
          { zh: "图层树是键盘可达的树控件：聚焦后 ↑↓ 在可见行之间移动，←→ 折叠 / 展开，Home / End 到首尾；行上的可见性与锁定按钮都有可读标签", en: "The layer tree is a keyboard-reachable tree: focus it and ↑↓ move between visible rows, ←→ collapse / expand, Home / End jump to the ends; the per-row visibility and lock buttons carry readable labels" },
        ],
      },
    ],
  },
  {
    id: "ed-keys",
    title: { zh: "快捷键", en: "Shortcuts" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "按键", en: "Keys" },
          { zh: "作用", en: "Action" },
        ],
        codeCols: [0],
        rows: [
          [{ zh: "⌘Z", en: "⌘Z" }, { zh: "撤销", en: "Undo" }],
          [{ zh: "⇧⌘Z / ⌘Y", en: "⇧⌘Z / ⌘Y" }, { zh: "重做", en: "Redo" }],
          [{ zh: "⌘S", en: "⌘S" }, { zh: "立刻保存到工程；从壁纸库打开的壁纸则另存为项目", en: "Save to the project now; for a wallpaper opened from the library, save it as a project" }],
          [{ zh: "⌘D", en: "⌘D" }, { zh: "复制选中图层", en: "Duplicate the selected layer" }],
          [{ zh: "⌘A", en: "⌘A" }, { zh: "选中全部图层", en: "Select every layer" }],
          [{ zh: "⌘C / ⌘X / ⌘V", en: "⌘C / ⌘X / ⌘V" }, { zh: "复制 / 剪切 / 粘贴选中图层", en: "Copy / cut / paste the selected layers" }],
          [{ zh: "F2", en: "F2" }, { zh: "改名选中图层", en: "Rename the selected layer" }],
          [{ zh: "Delete / Backspace", en: "Delete / Backspace" }, { zh: "删除选中图层", en: "Delete the selected layer" }],
          [{ zh: "⌘K / ⇧⌘P", en: "⌘K / ⇧⌘P" }, { zh: "打开命令面板（快捷键总览在里面）", en: "Open the command palette (the shortcut overview lives there)" }],
          [{ zh: "←/→、⇧ + 方向键", en: "←/→, ⇧ + arrow" }, { zh: "时间轴上把选中关键帧挪 1 帧 / 10 帧", en: "Nudge the selected keyframe 1 / 10 frames on the timeline" }],
          [{ zh: "Alt + 点击", en: "Alt + click" }, { zh: "逐层切换选中", en: "Cycle selection through stacked layers" }],
          [{ zh: "⌘Enter", en: "⌘Enter" }, { zh: "应用正在编辑的脚本", en: "Apply the script being edited" }],
        ],
      },
    ],
  },
];
