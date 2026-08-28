import { describe, it, expect, vi } from "vitest";
import {
  WechatSettingsPanel,
  TIMEOUT_ITEM_ID,
  type PanelCommandItem,
} from "../src/panel.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
  fg: (_kind: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
  underline: (text: string) => text,
} as unknown as Theme;

// 模拟真实 theme 会输出 ANSI SGR 码，用来回归「标题行被 ANSI 码撑长提前截断」的 bug。
const ansiTheme = {
  fg: (_kind: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[0m`,
} as unknown as Theme;

function colWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    w +=
      /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(
        ch,
      )
        ? 2
        : 1;
  }
  return w;
}

// 面板单元测试用 mock 按键匹配器，映射 pi 内置 keybindings 的标准序列。
const keys = {
  matches: (data: string, binding: string): boolean => {
    switch (binding) {
      case "tui.select.cancel":
        return data === "\x1b" || data === "\x1b\x1b";
      case "tui.select.up":
        return data === "\x1b[A" || data === "\x1bOA";
      case "tui.select.down":
        return data === "\x1b[B" || data === "\x1bOB";
      case "tui.select.confirm":
        return data === "\r" || data === "\n";
      case "tui.editor.cursorLeft":
        return data === "\x1b[D" || data === "\x1bOD";
      case "tui.editor.cursorRight":
        return data === "\x1b[C" || data === "\x1bOC";
      default:
        return false;
    }
  },
};

const items: PanelCommandItem[] = [
  {
    id: "stop",
    name: "stop",
    description: "中止",
    exempt: true,
    source: "native",
    section: "native",
  },
  {
    id: "status",
    name: "/status",
    description: "查询",
    exempt: false,
    source: "native",
    section: "native",
  },
  {
    id: "review",
    name: "/review",
    description: "审阅",
    exempt: false,
    source: "skill",
    section: "plugin",
  },
  {
    id: TIMEOUT_ITEM_ID,
    name: "不活跃超时（秒）",
    description: "无进展多久后微信提醒一次",
    exempt: true,
    source: "native",
    section: "setting",
  },
];

function makePanel() {
  const user = {
    timeoutSeconds: 180,
    commands: {} as Record<string, "on" | "off">,
  };
  const project = {
    commands: {} as Record<string, "on" | "off" | "inherit">,
    timeoutSeconds: undefined as number | undefined,
  };
  const saveUser = vi.fn();
  const saveProject = vi.fn();
  const done = vi.fn();
  const requestRender = vi.fn();
  const panel = new WechatSettingsPanel({
    items,
    user,
    project,
    theme,
    keys,
    requestRender,
    done,
    saveUser,
    saveProject,
  });
  return { panel, user, project, saveUser, saveProject, done, requestRender };
}

/** 切到「设置」分区：原生 → 透传 → 设置（两次 →）。 */
function toSettingSection(panel: WechatSettingsPanel): void {
  panel.handleInput("\x1b[C");
  panel.handleInput("\x1b[C");
}

describe("WechatSettingsPanel", () => {
  it("render 输出标题、三个分区与原生区命令", () => {
    const { panel } = makePanel();
    const out = panel.render(80).join("\n");
    expect(out).toContain("WeChat 设置");
    expect(out).toContain("/status");
    expect(out).toContain("原生");
    expect(out).toContain("透传");
    expect(out).toContain("设置");
    // tab 不带方括号，用 | 分割（下划线在 mock theme 下不产生 ANSI）
    expect(out).toContain("项目级 | 用户级");
    expect(out).toContain("原生 | 透传 | 设置");
  });

  it("标题行按可见列宽填满，不被 ANSI 码提前截断", () => {
    const user = {
      timeoutSeconds: 180,
      commands: {} as Record<string, "on" | "off">,
    };
    const ansiPanel = new WechatSettingsPanel({
      items,
      user,
      project: { commands: {} },
      theme: ansiTheme,
      keys,
      requestRender: vi.fn(),
      done: vi.fn(),
      saveUser: vi.fn(),
      saveProject: vi.fn(),
    });
    const first = ansiPanel.render(80)[0];
    expect(first).not.toContain("…");
    expect(colWidth(first)).toBe(80);
  });

  it("用户级开关 on/off 二态切换并持久化", () => {
    const { panel, user, saveUser } = makePanel();
    panel.handleInput("\x1b[B"); // ↓ → status（原生区 index 1）
    panel.handleInput("\r");
    expect(user.commands.status).toBe("on");
    expect(saveUser).toHaveBeenCalledTimes(1);
    panel.handleInput("\r");
    expect(user.commands.status).toBe("off");
    expect(saveUser).toHaveBeenCalledTimes(2);
  });

  it("项目级三级循环 inherit→on→off→inherit", () => {
    const { panel, project, saveProject } = makePanel();
    panel.handleInput("\t"); // 切到项目级
    panel.handleInput("\x1b[B"); // ↓ → status
    panel.handleInput("\r");
    expect(project.commands.status).toBe("on");
    panel.handleInput("\r");
    expect(project.commands.status).toBe("off");
    panel.handleInput("\r");
    expect(project.commands.status).toBe("inherit");
    expect(saveProject).toHaveBeenCalledTimes(3);
  });

  it("豁免命令不可切换且不触发保存", () => {
    const { panel, user, saveUser, saveProject } = makePanel();
    panel.handleInput("\r"); // 初始选中 stop（原生区 index 0，豁免）
    expect(user.commands.stop).toBeUndefined();
    expect(saveUser).not.toHaveBeenCalled();
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("esc 触发 done", () => {
    const { panel, done } = makePanel();
    panel.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("↑↓ 在原生区内循环导航", () => {
    const { panel, user } = makePanel();
    panel.handleInput("\x1b[A"); // 从 stop ↑ → 回绕到 status（原生区 index 1）
    panel.handleInput("\r");
    expect(user.commands.status).toBe("on");
    expect(user.commands.stop).toBeUndefined();
  });

  it("←→ 循环切换二级分区", () => {
    const { panel } = makePanel();
    expect(panel.render(80).join("\n")).toContain("/status");

    panel.handleInput("\x1b[C"); // → 透传
    expect(panel.render(80).join("\n")).toContain("/review");

    panel.handleInput("\x1b[C"); // → 设置
    expect(panel.render(80).join("\n")).toContain("不活跃超时");

    panel.handleInput("\x1b[C"); // → 回绕原生
    expect(panel.render(80).join("\n")).toContain("/status");

    panel.handleInput("\x1b[D"); // ← 回设置
    expect(panel.render(80).join("\n")).toContain("不活跃超时");
  });
});

describe("「/」筛选", () => {
  it("「/」进入筛选，逐字符过滤当前分区，退格可删", () => {
    const { panel, user } = makePanel();
    panel.handleInput("\x1b[C"); // → 透传（仅 review 一项）
    panel.handleInput("/");
    expect(panel.render(80).join("\n")).toContain("筛选：/");

    for (const ch of "xyz") panel.handleInput(ch);
    expect(panel.render(80).join("\n")).toContain("（无可用命令）");

    panel.handleInput("\x7f");
    panel.handleInput("\x7f");
    panel.handleInput("\x7f"); // 退格 ×3 → 回到空筛选词
    expect(panel.render(80).join("\n")).toContain("/review");

    for (const ch of "rev") panel.handleInput(ch);
    expect(panel.render(80).join("\n")).toContain("/review");

    panel.handleInput("\r"); // 筛选命中项上 Enter 切换
    expect(user.commands.review).toBe("on");
  });

  it("Esc 先退出筛选（不关面板），再 Esc 关闭", () => {
    const { panel, done } = makePanel();
    panel.handleInput("/");
    panel.handleInput("s");
    expect(panel.render(80).join("\n")).toContain("筛选：/s");

    panel.handleInput("\x1b"); // 退出筛选
    expect(done).not.toHaveBeenCalled();
    expect(panel.render(80).join("\n")).not.toContain("筛选：/");

    panel.handleInput("\x1b"); // 关闭
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("Tab / ←→ 切换列表时清空筛选", () => {
    const { panel } = makePanel();
    panel.handleInput("/");
    panel.handleInput("s");
    expect(panel.render(80).join("\n")).toContain("筛选：/s");

    panel.handleInput("\x1b[C"); // → 透传，清空筛选
    const out = panel.render(80).join("\n");
    expect(out).not.toContain("筛选：/");
    expect(out).toContain("/review");
  });

  it("原生区同样可用筛选", () => {
    const { panel } = makePanel();
    panel.handleInput("/");
    for (const ch of "sta") panel.handleInput(ch);
    const out = panel.render(80).join("\n");
    expect(out).toContain("/status");
    expect(out).not.toContain("/review");
    expect(out).not.toContain("stop");
  });
});

describe("超时配置项", () => {
  it("用户级 Enter 循环预设值并持久化", () => {
    const { panel, user, saveUser } = makePanel();
    toSettingSection(panel);
    panel.handleInput("\r"); // 180 → 300
    expect(user.timeoutSeconds).toBe(300);
    expect(saveUser).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 300 }),
    );
  });

  it("项目级 继承→60→120，末尾回继承", () => {
    const { panel, project, saveProject } = makePanel();
    panel.handleInput("\t"); // 切项目级
    toSettingSection(panel);
    panel.handleInput("\r"); // 继承 → 60
    expect(project.timeoutSeconds).toBe(60);
    panel.handleInput("\r"); // 60 → 120
    expect(project.timeoutSeconds).toBe(120);
    expect(saveProject).toHaveBeenCalledTimes(2);

    // 直接顶到末尾再回车应回到继承
    project.timeoutSeconds = 900;
    panel.handleInput("\r");
    expect(project.timeoutSeconds).toBeUndefined();
  });

  it("render 显示当前超时秒数", () => {
    const { panel } = makePanel();
    toSettingSection(panel);
    expect(panel.render(80).join("\n")).toContain("180s");
  });
});
