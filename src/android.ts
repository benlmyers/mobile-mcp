import path from "path";
import { execFileSync } from "child_process";

import * as xml from "fast-xml-parser";

import { ActionableError, Button, InstalledApp, Robot, ScreenElement, ScreenElementRect, ScreenSize, SwipeDirection, Orientation } from "./robot";

export interface AndroidDevice {
	deviceId: string;
	deviceType: "tv" | "mobile";
}

interface UiAutomatorXmlNode {
	node: UiAutomatorXmlNode[];
	class?: string;
	text?: string;
	bounds?: string;
	hint?: string;
	focused?: string;
	clickable?: string;
	focusable?: string;
	enabled?: string;
	selected?: string;
	package?: string;
	"content-desc"?: string;
	"resource-id"?: string;
}

interface UiAutomatorXml {
	hierarchy: {
		node: UiAutomatorXmlNode;
	};
}

const getAdbPath = (): string => {
	let executable = "adb";
	if (process.env.ANDROID_HOME) {
		executable = path.join(process.env.ANDROID_HOME, "platform-tools", "adb");
	}

	return executable;
};

const BUTTON_MAP: Record<Button, string> = {
	"BACK": "KEYCODE_BACK",
	"HOME": "KEYCODE_HOME",
	"VOLUME_UP": "KEYCODE_VOLUME_UP",
	"VOLUME_DOWN": "KEYCODE_VOLUME_DOWN",
	"ENTER": "KEYCODE_ENTER",
	"DPAD_CENTER": "KEYCODE_DPAD_CENTER",
	"DPAD_UP": "KEYCODE_DPAD_UP",
	"DPAD_DOWN": "KEYCODE_DPAD_DOWN",
	"DPAD_LEFT": "KEYCODE_DPAD_LEFT",
	"DPAD_RIGHT": "KEYCODE_DPAD_RIGHT",
};

const TIMEOUT = 30000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 4;

type AndroidDeviceType = "tv" | "mobile";

export class AndroidRobot implements Robot {

	public constructor(private deviceId: string) {
	}

	public adb(...args: string[]): Buffer {
		return execFileSync(getAdbPath(), ["-s", this.deviceId, ...args], {
			maxBuffer: MAX_BUFFER_SIZE,
			timeout: TIMEOUT,
		});
	}

	public getSystemFeatures(): string[] {
		return this.adb("shell", "pm", "list", "features")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("feature:"))
			.map(line => line.substring("feature:".length));
	}

	public async getScreenSize(): Promise<ScreenSize> {
		const screenSize = this.adb("shell", "wm", "size")
			.toString()
			.split(" ")
			.pop();

		if (!screenSize) {
			throw new Error("Failed to get screen size");
		}

		const scale = 1;
		const [width, height] = screenSize.split("x").map(Number);
		return { width, height, scale };
	}

	public async listApps(): Promise<InstalledApp[]> {
		return this.adb("shell", "cmd", "package", "query-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("packageName="))
			.map(line => line.substring("packageName=".length))
			.filter((value, index, self) => self.indexOf(value) === index)
			.map(packageName => ({
				packageName,
				appName: packageName,
			}));
	}

	public async launchApp(packageName: string): Promise<void> {
		this.adb("shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1");
	}

	public async listRunningProcesses(): Promise<string[]> {
		return this.adb("shell", "ps", "-e")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("u")) // non-system processes
			.map(line => line.split(/\s+/)[8]); // get process name
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const screenSize = await this.getScreenSize();
		const centerX = screenSize.width >> 1;

		let x0: number, y0: number, x1: number, y1: number;

		switch (direction) {
			case "up":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.80);
				y1 = Math.floor(screenSize.height * 0.20);
				break;
			case "down":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.20);
				y1 = Math.floor(screenSize.height * 0.80);
				break;
			case "left":
				x0 = Math.floor(screenSize.width * 0.80);
				x1 = Math.floor(screenSize.width * 0.20);
				y0 = y1 = Math.floor(screenSize.height * 0.50);
				break;
			case "right":
				x0 = Math.floor(screenSize.width * 0.20);
				x1 = Math.floor(screenSize.width * 0.80);
				y0 = y1 = Math.floor(screenSize.height * 0.50);
				break;
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}

		this.adb("shell", "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, "1000");
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const screenSize = await this.getScreenSize();

		let x0: number, y0: number, x1: number, y1: number;

		// Use provided distance or default to 30% of screen dimension
		const defaultDistanceY = Math.floor(screenSize.height * 0.3);
		const defaultDistanceX = Math.floor(screenSize.width * 0.3);
		const swipeDistanceY = distance || defaultDistanceY;
		const swipeDistanceX = distance || defaultDistanceX;

		switch (direction) {
			case "up":
				x0 = x1 = x;
				y0 = y;
				y1 = Math.max(0, y - swipeDistanceY);
				break;
			case "down":
				x0 = x1 = x;
				y0 = y;
				y1 = Math.min(screenSize.height, y + swipeDistanceY);
				break;
			case "left":
				x0 = x;
				x1 = Math.max(0, x - swipeDistanceX);
				y0 = y1 = y;
				break;
			case "right":
				x0 = x;
				x1 = Math.min(screenSize.width, x + swipeDistanceX);
				y0 = y1 = y;
				break;
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}

		this.adb("shell", "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, "1000");
	}

	public async getScreenshot(): Promise<Buffer> {
		return this.adb("exec-out", "screencap", "-p");
	}

	private collectElements(node: UiAutomatorXmlNode): ScreenElement[] {
		const elements: Array<ScreenElement> = [];

		if (node.node) {
			if (Array.isArray(node.node)) {
				for (const childNode of node.node) {
					elements.push(...this.collectElements(childNode));
				}
			} else {
				elements.push(...this.collectElements(node.node));
			}
		}

		// Include elements with text/labels OR clickable/focusable elements (like icons, buttons)
		const hasTextOrLabel = node.text || node["content-desc"] || node.hint || node["resource-id"];
		const isInteractive = node.clickable === "true" || node.focusable === "true" ||
			(node.class && (node.class.includes("Button") || node.class.includes("ImageView") ||
			node.class.includes("ImageButton") || node.class.includes("View")));

		if (hasTextOrLabel || isInteractive) {
			const element: ScreenElement = {
				type: node.class || "element",
				text: node.text,
				label: node["content-desc"] || node.hint || "",
				rect: this.getScreenElementRect(node),
			};

			if (node.focused === "true") {
				// only provide it if it's true, otherwise don't confuse llm
				element.focused = true;
			}

			const resourceId = node["resource-id"];
			if (resourceId !== null && resourceId !== "") {
				element.identifier = resourceId;
			}

			if (element.rect.width > 0 && element.rect.height > 0) {
				elements.push(element);
			}
		}

		return elements;
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const parsedXml = await this.getUiAutomatorXml();
		const hierarchy = parsedXml.hierarchy;
		const elements = this.collectElements(hierarchy.node);
		return elements;
	}

	public async terminateApp(packageName: string): Promise<void> {
		this.adb("shell", "am", "force-stop", packageName);
	}

	public async openUrl(url: string): Promise<void> {
		this.adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url);
	}

	public async sendKeys(text: string): Promise<void> {
		// adb shell requires some escaping
		const _text = text.replace(/ /g, "\\ ");
		this.adb("shell", "input", "text", _text);
	}

	public async pressButton(button: Button) {
		if (!BUTTON_MAP[button]) {
			throw new ActionableError(`Button "${button}" is not supported`);
		}

		this.adb("shell", "input", "keyevent", BUTTON_MAP[button]);
	}

	public async tap(x: number, y: number): Promise<void> {
		this.adb("shell", "input", "tap", `${x}`, `${y}`);
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		const orientationValue = orientation === "portrait" ? 0 : 1;

		// disable auto-rotation prior to setting the orientation
		this.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
		this.adb("shell", "content", "insert", "--uri", "content://settings/system", "--bind", "name:s:user_rotation", "--bind", `value:i:${orientationValue}`);
	}

	public async getOrientation(): Promise<Orientation> {
		const rotation = this.adb("shell", "settings", "get", "system", "user_rotation").toString().trim();
		return rotation === "0" ? "portrait" : "landscape";
	}

	public async getDeviceLogs(options?: { timeWindow?: string; filter?: string; process?: string }): Promise<string> {
		const timeWindow = options?.timeWindow || "1m";
		const filter = options?.filter;
		const processFilter = options?.process;
		let packageFilter: string | null = null;
		let searchQuery: string | null = null;
		let effectiveFilter = filter;
		// For Android: if both process and filter are provided, combine them as "package:<process> <filter>"
		if (processFilter && filter && !filter.includes("package:")) {
			effectiveFilter = `package:${processFilter} ${filter}`;
		} else if (processFilter && !filter) {
			effectiveFilter = `package:${processFilter}`;
		}
		// Handle Android package filtering syntax
		if (effectiveFilter) {
			if (effectiveFilter.startsWith("package:mine")) {
				// Filter to user apps only
				const query = effectiveFilter.replace("package:mine", "").trim();
				searchQuery = query || null;
				// Will filter user packages in post-processing
			} else if (effectiveFilter.includes("package:")) {
				// Handle specific package filters like package:com.example.app search_term
				const packageMatch = effectiveFilter.match(/package:([^\s]+)(?:\s+(.+))?/);
				if (packageMatch) {
					packageFilter = packageMatch[1];
					searchQuery = packageMatch[2] || null;
				}
			} else {
				// Regular search filter
				searchQuery = effectiveFilter;
			}
		}

		const args = ["shell", "logcat"];
		if (timeWindow) {
			// Calculate timestamp for time-based filtering using -T
			const timeInSeconds = this.parseTimeWindow(timeWindow);
			const startTime = new Date(Date.now() - (timeInSeconds * 1000));
			// Format as MM-dd HH:mm:ss.mmm
			const month = String(startTime.getMonth() + 1).padStart(2, "0");
			const day = String(startTime.getDate()).padStart(2, "0");
			const hours = String(startTime.getHours()).padStart(2, "0");
			const minutes = String(startTime.getMinutes()).padStart(2, "0");
			const seconds = String(startTime.getSeconds()).padStart(2, "0");
			const milliseconds = String(startTime.getMilliseconds()).padStart(3, "0");

			const timeFormat = `${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
			args.push("-T", timeFormat);
		} else {
			args.push("-d");
		}
		// Add package filtering directly to logcat if we have a specific package
		if (packageFilter && packageFilter !== "mine") {
			// Use logcat's native package filtering with --pid
			try {
				// First get the PID(s) for this package
				const pidOutput = this.adb("shell", "pidof", packageFilter).toString().trim();
				if (pidOutput) {
					const pids = pidOutput.split(/\s+/);
					for (const pid of pids) {
						args.push("--pid", pid);
					}
				}
			} catch (error) {
				// If pidof fails, fall back to post-processing
			}
		}
		const output = this.adb(...args).toString();

		// Post-process filtering
		const lines = output.split("\n").filter(line => line.trim());
		let filteredLines = lines;
		// Filter by specific package if provided (fallback if --pid didn't work)
		if (packageFilter && packageFilter !== "mine") {
			filteredLines = filteredLines.filter(line => {
				return line.includes(packageFilter!);
			});
		}
		// Filter for user packages if package:mine
		if (filter && filter.startsWith("package:mine")) {
			filteredLines = filteredLines.filter(line => {
				// Look for user app indicators - avoid system/Android logs
				return !line.includes("com.android.") &&
					!line.includes("android.") &&
					!line.includes("system_") &&
					(line.includes("com.") || line.includes("io.") || line.includes("net.") || line.includes("app."));
			});
		}
		// Apply text search if provided
		if (searchQuery) {
			filteredLines = filteredLines.filter(line => {
				return line.toLowerCase().includes(searchQuery!.toLowerCase());
			});
		}
		return filteredLines.join("\n");
	}

	private parseTimeWindow(timeWindow: string): number {
		const match = timeWindow.match(/^(\d+)([smh])$/);
		if (!match) {
			return 60;
		}
		const value = parseInt(match[1], 10);
		const unit = match[2];
		switch (unit) {
			case "s":
				return value;
			case "m":
				return value * 60;
			case "h":
				return value * 3600;
			default:
				return 60;
		}
	}

	private async getUiAutomatorDump(): Promise<string> {
		for (let tries = 0; tries < 10; tries++) {
			const dump = this.adb("exec-out", "uiautomator", "dump", "/dev/tty").toString();
			// note: we're not catching other errors here. maybe we should check for <?xml
			if (dump.includes("null root node returned by UiTestAutomationBridge")) {
				// uncomment for debugging
				// const screenshot = await this.getScreenshot();
				// console.error("Failed to get UIAutomator XML. Here's a screenshot: " + screenshot.toString("base64"));
				continue;
			}

			return dump.substring(dump.indexOf("<?xml"));
		}

		throw new ActionableError("Failed to get UIAutomator XML");
	}

	private async getUiAutomatorXml(): Promise<UiAutomatorXml> {
		const dump = await this.getUiAutomatorDump();
		const parser = new xml.XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "",
		});

		return parser.parse(dump) as UiAutomatorXml;
	}

	private getScreenElementRect(node: UiAutomatorXmlNode): ScreenElementRect {
		const bounds = String(node.bounds);

		const [, left, top, right, bottom] = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.map(Number) || [];
		return {
			x: left,
			y: top,
			width: right - left,
			height: bottom - top,
		};
	}
}

export class AndroidDeviceManager {

	private getDeviceType(name: string): AndroidDeviceType {
		const device = new AndroidRobot(name);
		const features = device.getSystemFeatures();
		if (features.includes("android.software.leanback") || features.includes("android.hardware.type.television")) {
			return "tv";
		}

		return "mobile";
	}

	public getConnectedDevices(): AndroidDevice[] {
		try {
			const names = execFileSync(getAdbPath(), ["devices"])
				.toString()
				.split("\n")
				.filter(line => !line.startsWith("List of devices attached"))
				.filter(line => line.trim() !== "")
				.map(line => line.split("\t")[0]);

			return names.map(name => ({
				deviceId: name,
				deviceType: this.getDeviceType(name),
			}));
		} catch (error) {
			console.error("Could not execute adb command, maybe ANDROID_HOME is not set?");
			return [];
		}
	}
}
