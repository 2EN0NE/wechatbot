/**
 * /wechat-setting 的 TUI 面板（ctx.ui.custom 覆盖层）。
 *
 * 两级 tab（见 docs/adr/0008-settings-panel-sections.md）：
 *  - 一级「作用域」：项目级 / 用户级，Tab 切换；
 *  - 二级「分区」：原生 → 透传 → 设置，←/→ 切换。
 *
 * 遵循 tui-standard 设计规范：纯横线边框、`>` 选中、↑↓ 导航、
 * `/` 筛选（逐字符过滤当前分区，所有 tab 可用）、禁双宽 emoji；
 * 扩展命令用告警色并在 footer 提示风险。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
  UserConfig,
  ProjectConfig,
  Switch,
  ProjectSwitch,
} from "./settings.js";

export type CommandSource = "native" | "skill" | "prompt" | "extension";

/** 二级 tab 分区。原生 = 桥重实现的命令；透传 = 插件命令；设置 = 非命令配置。 */
export type PanelSection = "native" | "plugin" | "setting";

/**
 * 按键匹配器：由 ctx.ui.custom 的 keybindings 注入（等价 pi-tui 的
 * KeybindingsManager.matches）。面板不直接依赖 @earendil-works/pi-tui，
 * 而是用这个最小接口——pi 自带的按键解码已正确处理 tmux / Kitty / 修饰键。
 */
export interface PanelKeyMatcher {
  matches(data: string, binding: string): boolean;
}

/** 设置区里「不活跃超时」项的 id：不参与命令开关门控，Enter 循环预设值。 */
export const TIMEOUT_ITEM_ID = "__timeout";

/** 不活跃超时可选值（秒），Enter 循环切换。 */
export const TIMEOUT_PRESETS = [60, 120, 180, 300, 600, 900] as const;

export interface PanelCommandItem {
  id: string;
  name: string;
  description: string;
  exempt: boolean;
  source: CommandSource;
  section: PanelSection;
}

export interface PanelOptions {
  items: PanelCommandItem[];
  user: UserConfig;
  project: ProjectConfig;
  theme: Theme;
  keys: PanelKeyMatcher;
  requestRender: () => void;
  done: () => void;
  saveUser: (c: UserConfig) => void;
  saveProject: (c: ProjectConfig) => void;
}

/** 二级 tab 顺序：原生 → 透传 → 设置（设置放最后，见 adr/0008）。 */
const SECTION_ORDER: PanelSection[] = ["native", "plugin", "setting"];
const SECTION_LABELS: Record<PanelSection, string> = {
  native: "原生",
  plugin: "透传",
  setting: "设置",
};

const MAX_VISIBLE = 12;

// ── 显示宽度工具 ────────────────────────────────────────────────────────
// pi-theme 的 fg/bold 会往文本里塞 ANSI SGR 码；拼宽/截断必须按「可见列
// 宽」计算（CJK 按 2 列），否则标题行会被 ANSI 码撑长、提前截成 `── WeChat
// 设置 ────…` 这种对不齐的短横线。

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// 常见 CJK/全角区间按 2 列宽，其余按 1 列（面板内容是中文+ASCII，足够准）。
// 半角片假名（\uff61-\uff9f）保持 1 列，不纳入全角区间。
const WIDE_RE =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/;

function charWidth(ch: string): number {
  return WIDE_RE.test(ch) ? 2 : 1;
}

function visibleWidth(text: string): number {
  let w = 0;
  for (const ch of stripAnsi(text)) w += charWidth(ch);
  return w;
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  // 超宽：按列宽截断，末尾补 …（截断结果丢弃 ANSI 着色，保证列数正确）
  const plain = stripAnsi(text);
  let out = "";
  let w = 0;
  for (const ch of plain) {
    const cw = charWidth(ch);
    if (w + cw > width - 1) break; // 预留 1 列给省略号
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

export class WechatSettingsPanel {
  private tab: "user" | "project" = "user";
  private section: PanelSection = "native";
  private selectedIndex = 0;
  private scrollOffset = 0;
  /** 是否处于 `/` 筛选模式（仅筛选模式的输入会被当作文本追加）。 */
  private filterActive = false;
  /** 筛选关键字的原文。 */
  private filter = "";
  private readonly items: PanelCommandItem[];
  private user: UserConfig;
  private project: ProjectConfig;
  private readonly theme: Theme;
  private readonly keys: PanelKeyMatcher;
  private readonly requestRender: () => void;
  private readonly done: () => void;
  private readonly saveUser: (c: UserConfig) => void;
  private readonly saveProject: (c: ProjectConfig) => void;

  constructor(opts: PanelOptions) {
    this.items = opts.items;
    this.user = opts.user;
    this.project = opts.project;
    this.theme = opts.theme;
    this.keys = opts.keys;
    this.requestRender = opts.requestRender;
    this.done = opts.done;
    this.saveUser = opts.saveUser;
    this.saveProject = opts.saveProject;
  }

  private visibleItems(): PanelCommandItem[] {
    const inSection = this.items.filter((i) => i.section === this.section);
    if (!this.filterActive || this.filter === "") return inSection;
    const q = this.filter.toLowerCase();
    return inSection.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q),
    );
  }

  private resetSelection(): void {
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  private cycleSection(delta: number): void {
    const idx = SECTION_ORDER.indexOf(this.section);
    this.section =
      SECTION_ORDER[
        (idx + delta + SECTION_ORDER.length) % SECTION_ORDER.length
      ];
    this.clearFilter();
    this.resetSelection();
    this.invalidate();
    this.requestRender();
  }

  private clearFilter(): void {
    this.filterActive = false;
    this.filter = "";
  }

  private renderFilterBar(): string {
    const t = this.theme;
    const slash = t.fg("accent", "/");
    const cursor = t.fg("dim", "▏");
    return `  筛选：${slash}${this.filter}${cursor}`;
  }

  /** 是否可打印文本（过滤掉控制字符，避免 Ctrl 序列等污染筛选词）。 */
  private isPrintable(data: string): boolean {
    if (data.length === 0) return false;
    for (const ch of data) {
      const code = ch.codePointAt(0);
      if (code === undefined || code < 32 || code === 127) return false;
    }
    return true;
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const title = t.fg("accent", t.bold("WeChat 设置"));
    // 标题行按可见列宽补足到 width，末行不再用 clip 截短。
    const headDashes = Math.max(0, width - visibleWidth("── WeChat 设置 "));
    lines.push(clip(`── ${title} ${"─".repeat(headDashes)}`, width));

    // 一级 tab：作用域（文字加下划线区分级别，选中加粗）
    const projectTab =
      this.tab === "project"
        ? t.bold(t.underline("项目级"))
        : t.fg("dim", t.underline("项目级"));
    const userTab =
      this.tab === "user"
        ? t.bold(t.underline("用户级"))
        : t.fg("dim", t.underline("用户级"));
    lines.push(clip(`  ${projectTab} | ${userTab}`, width));

    // 二级 tab：分区
    const sectionTabs = SECTION_ORDER.map((s) =>
      this.section === s
        ? t.bold(SECTION_LABELS[s])
        : t.fg("dim", SECTION_LABELS[s]),
    ).join(" | ");
    lines.push(clip(`  ${sectionTabs}`, width));
    lines.push(clip(` ${"─".repeat(Math.max(0, width - 2))}`, width));

    // 筛选框（仅筛选模式显示，位于列表上方）
    if (this.filterActive) {
      lines.push(clip(this.renderFilterBar(), width));
    }

    // 滚动窗口：保证选中项可见
    const visible = this.visibleItems();
    const count = visible.length;
    if (this.selectedIndex >= count)
      this.selectedIndex = Math.max(0, count - 1);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
    if (this.selectedIndex < this.scrollOffset)
      this.scrollOffset = this.selectedIndex;
    if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) {
      this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
    }
    this.scrollOffset = Math.max(
      0,
      Math.min(this.scrollOffset, Math.max(0, count - MAX_VISIBLE)),
    );

    const end = Math.min(count, this.scrollOffset + MAX_VISIBLE);
    for (let i = this.scrollOffset; i < end; i++) {
      lines.push(
        clip(this.renderRow(visible, i, i === this.selectedIndex), width),
      );
    }
    if (count === 0) {
      lines.push(clip("   （无可用命令）", width));
    }

    lines.push(clip(` ${"─".repeat(Math.max(0, width - 2))}`, width));

    const hint = this.filterActive
      ? "  输入关键字 · 退格删除 · Enter 切换 · Esc 退出筛选"
      : "  ↑↓ 选择 · Enter 切换 · Tab 作用域 · ←→ 分区 · / 筛选 · Esc 关闭";
    lines.push(clip(t.fg("dim", hint), width));

    const selected = visible[this.selectedIndex];
    if (selected && selected.source === "extension") {
      lines.push(
        clip(
          t.fg("warning", "  注意：扩展命令的输出在 pi 终端，可能不会回传微信"),
          width,
        ),
      );
    }

    lines.push(clip("─".repeat(Math.max(0, width)), width));
    return lines;
  }

  private renderRow(
    visible: PanelCommandItem[],
    index: number,
    selected: boolean,
  ): string {
    const t = this.theme;
    const item = visible[index];
    const cursor = selected ? t.fg("accent", ">") : " ";
    if (item.id === TIMEOUT_ITEM_ID) {
      const secs =
        this.tab === "user"
          ? this.user.timeoutSeconds
          : (this.project.timeoutSeconds ?? this.user.timeoutSeconds);
      const stateText =
        this.tab === "project" && this.project.timeoutSeconds === undefined
          ? t.fg("muted", `[继承 ${secs}s]`)
          : t.fg("success", `[${secs}s ]`);
      const name = item.name;
      const desc = t.fg("dim", item.description);
      const line = `   ${cursor} ${stateText} ${name}  —  ${desc}`;
      return selected ? t.bold(line) : line;
    }
    const state = this.stateOf(item);
    let stateText: string;
    if (item.exempt) {
      stateText = t.fg("dim", `[${state}]`);
    } else if (state === "on") {
      stateText = t.fg("success", "[on ]");
    } else if (state === "inherit") {
      stateText = t.fg("muted", "[继承]");
    } else {
      stateText = t.fg("muted", "[off ]");
    }
    const name =
      item.source === "extension" ? t.fg("warning", item.name) : item.name;
    const desc = t.fg("dim", item.description);
    const line = `   ${cursor} ${stateText} ${name}  —  ${desc}`;
    return selected ? t.bold(line) : line;
  }

  private stateOf(item: PanelCommandItem): Switch | ProjectSwitch {
    if (this.tab === "user") {
      if (item.exempt) return "on";
      return this.user.commands[item.id] ?? "off";
    }
    if (item.exempt) return "on";
    return this.project.commands?.[item.id] ?? "inherit";
  }

  handleInput(data: string): void {
    // 1. Esc：筛选模式下先退出筛选，否则关闭面板
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.filterActive) {
        this.clearFilter();
        this.resetSelection();
        this.invalidate();
        this.requestRender();
      } else {
        this.done();
      }
      return;
    }

    // 2. 退格：仅筛选模式下删除最后一个字符（按 code point 删，兼容代理对）
    if (this.filterActive && (data === "\x7f" || data === "\b")) {
      this.filter = [...this.filter].slice(0, -1).join("");
      this.resetSelection();
      this.invalidate();
      this.requestRender();
      return;
    }

    // 3. `/` 进入筛选模式（筛选词不含首字符 `/`）
    if (!this.filterActive && data === "/") {
      this.filterActive = true;
      this.filter = "";
      this.resetSelection();
      this.invalidate();
      this.requestRender();
      return;
    }

    // 4. Tab 切作用域（切列表即清空筛选）
    if (data === "\t") {
      this.tab = this.tab === "user" ? "project" : "user";
      this.clearFilter();
      this.resetSelection();
      this.invalidate();
      this.requestRender();
      return;
    }

    // 5. ←/→ 切分区（切列表即清空筛选）
    if (this.keys.matches(data, "tui.editor.cursorLeft")) {
      this.cycleSection(-1);
      return;
    }
    if (this.keys.matches(data, "tui.editor.cursorRight")) {
      this.cycleSection(1);
      return;
    }

    // 6. ↑↓ 导航（基于筛选后的列表）
    const count = this.visibleItems().length;
    if (this.keys.matches(data, "tui.select.up")) {
      if (count > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      }
      this.invalidate();
      this.requestRender();
      return;
    }
    if (this.keys.matches(data, "tui.select.down")) {
      if (count > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % count;
      }
      this.invalidate();
      this.requestRender();
      return;
    }

    // 7. Enter / 空格切换选中项
    if (this.keys.matches(data, "tui.select.confirm") || data === " ") {
      this.toggle();
      return;
    }

    // 8. 筛选模式下追加可打印字符
    if (this.filterActive && this.isPrintable(data)) {
      this.filter += data;
      this.resetSelection();
      this.invalidate();
      this.requestRender();
    }
  }

  private toggleTimeout(): void {
    if (this.tab === "user") {
      const idx = TIMEOUT_PRESETS.indexOf(
        this.user.timeoutSeconds as (typeof TIMEOUT_PRESETS)[number],
      );
      this.user.timeoutSeconds =
        TIMEOUT_PRESETS[(idx + 1) % TIMEOUT_PRESETS.length];
      this.saveUser(this.user);
    } else {
      const cur = this.project.timeoutSeconds;
      if (cur === undefined) {
        this.project.timeoutSeconds = TIMEOUT_PRESETS[0];
      } else {
        const idx = TIMEOUT_PRESETS.indexOf(
          cur as (typeof TIMEOUT_PRESETS)[number],
        );
        if (idx === TIMEOUT_PRESETS.length - 1) {
          delete this.project.timeoutSeconds; // 回到继承用户级
        } else {
          this.project.timeoutSeconds = TIMEOUT_PRESETS[idx + 1];
        }
      }
      this.saveProject(this.project);
    }
    this.invalidate();
    this.requestRender();
  }

  private toggle(): void {
    const item = this.visibleItems()[this.selectedIndex];
    if (!item) return;
    if (item.id === TIMEOUT_ITEM_ID) {
      this.toggleTimeout();
      return;
    }
    if (item.exempt) return;
    if (this.tab === "user") {
      this.user.commands[item.id] =
        this.user.commands[item.id] === "on" ? "off" : "on";
      this.saveUser(this.user);
    } else {
      const cur = this.project.commands?.[item.id] ?? "inherit";
      const next: ProjectSwitch =
        cur === "inherit" ? "on" : cur === "on" ? "off" : "inherit";
      this.project.commands = { ...this.project.commands, [item.id]: next };
      this.saveProject(this.project);
    }
    this.invalidate();
    this.requestRender();
  }

  invalidate(): void {
    /* 无缓存，无需处理 */
  }

  dispose(): void {
    /* 无资源需释放 */
  }
}
