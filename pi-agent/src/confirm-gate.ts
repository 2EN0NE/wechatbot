/**
 * 远端豁免弱桥接（ADR-0014，对接 nano-pi-agent-creator 的 ADR-0068）
 *
 * `@zenone/pi-selector` 在扩展工厂期把闸门接口挂到 `globalThis.__confirmGateApi`。
 * 本仓库**不依赖**该包（跨仓库解耦，同 ADR-0028 的弱桥接形态），只按鸭子类型读取。
 *
 * 三态语义（与 selector 的 `status().mode` 对齐）：
 *   off            — 接口不存在或未授予许可（启动命令没带 `--unattended-confirm`）
 *   licensed-idle  — 有许可但通道未占用（桥未连接）
 *   armed          — 通道占用中：selector 的确认框按调用点声明的默认值直接放行
 *
 * fail-soft：接口缺失、形状不符、无许可、arm 被拒，一律返回 undefined / "off"，绝不抛错。
 */

export type ConfirmGateMode = "off" | "licensed-idle" | "armed";

export interface ConfirmGateStatus {
	license: boolean;
	armed: boolean;
	owners: string[];
	mode: ConfirmGateMode;
}

export interface ConfirmGateApi {
	hasLicense(): boolean;
	isArmed(): boolean;
	owners(): string[];
	/** 引用计数占用；无许可时返回 undefined。返回的解除函数幂等。 */
	arm(owner: string): (() => void) | undefined;
	status(): ConfirmGateStatus;
}

function readApi(): ConfirmGateApi | undefined {
	const holder = globalThis as { __confirmGateApi?: unknown };
	const candidate = holder.__confirmGateApi;
	if (!candidate || typeof candidate !== "object") return undefined;

	// 鸭子类型校验：只认必需方法，避免读到旧版/残缺实现后 method is not a function。
	const api = candidate as Partial<ConfirmGateApi>;
	if (
		typeof api.hasLicense !== "function" ||
		typeof api.isArmed !== "function" ||
		typeof api.arm !== "function"
	) {
		return undefined;
	}
	return candidate as ConfirmGateApi;
}

/**
 * 最近一次探测失败的异常信息（诊断用，不参与状态判定）。
 *
 * `confirmGateMode()` 与 `armConfirmGate()` 是 fail-soft 的，异常被折叠成 `off` / `undefined`；
 * 这里保留原始错误，让调用方能区分「没有许可」与「接口实现抛错」，避免给出错误的排查指引。
 */
let lastProbeError: string | undefined;

export function confirmGateLastError(): string | undefined {
	return lastProbeError;
}

/** 当前闸门模式。接口不可用统一归为 `off`（与 selector 无许可时的取值一致）。 */
export function confirmGateMode(): ConfirmGateMode {
	try {
		const api = readApi();
		// 接口缺失 / 无许可都是「确定的结论」：顺手清掉上一次探测的陈旧异常，
		// 否则拒绝回执会把「没带 --unattended-confirm」误报成接口实现抛错（adr/0014 补充 4）。
		if (!api || !api.hasLicense()) {
			lastProbeError = undefined;
			return "off";
		}
		const armed = api.isArmed();
		lastProbeError = undefined;
		return armed ? "armed" : "licensed-idle";
	} catch (e) {
		// 接口实现可能在会话替换后访问失效的 ctx（selector 侧已单独修，见 ADR-0014）：
		// 状态判定只用于提示与自检，绝不能因此打断桥接流程。
		lastProbeError = e instanceof Error ? e.message : String(e);
		return "off";
	}
}

/**
 * 占用豁免（引用计数）。返回解除函数，由调用方在断开时调用并丢弃；无接口/无许可 → undefined。
 */
export function armConfirmGate(owner = "wechat"): (() => void) | undefined {
	try {
		const disarm = readApi()?.arm(owner);
		lastProbeError = undefined;
		return disarm;
	} catch (e) {
		// arm 只是「允许跳过确认」的优化，不应让连接流程失败（fail-soft，见 ADR-0014 D1）。
		lastProbeError = e instanceof Error ? e.message : String(e);
		return undefined;
	}
}
