import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { z, ZodRawShape, ZodTypeAny } from "zod";
import path from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { writeFileSync } from "fs";

import { error, trace } from "./logger";
import { AndroidRobot, AndroidDeviceManager } from "./android";
import { ActionableError, Robot } from "./robot";
import { SimctlManager } from "./iphone-simulator";
import { IosManager, IosRobot } from "./ios";
import { PNG } from "./png";
import { isImageMagickInstalled, Image } from "./image-utils";

const formatBytes = (bytes: number): string => {
	if (bytes === 0) {
		return "0 B";
	}
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export const getAgentVersion = (): string => {
	const json = require("../package.json");
	return json.version;
};

const getLatestAgentVersion = async (): Promise<string> => {
	const response = await fetch("https://api.github.com/repos/mobile-next/mobile-mcp/tags?per_page=1");
	const json = await response.json();
	return json[0].name;
};

const checkForLatestAgentVersion = async (): Promise<void> => {
	try {
		const latestVersion = await getLatestAgentVersion();
		const currentVersion = getAgentVersion();
		if (latestVersion !== currentVersion) {
			trace(`You are running an older version of the agent. Please update to the latest version: ${latestVersion}.`);
		}
	} catch (error: any) {
		// ignore
	}
};

export const createMcpServer = (): McpServer => {

	const server = new McpServer({
		name: "mobile-mcp",
		version: getAgentVersion(),
		capabilities: {
			resources: {},
			tools: {},
		},
	});

	const noParams = z.object({});

	const tool = (name: string, description: string, paramsSchema: ZodRawShape, cb: (args: z.objectOutputType<ZodRawShape, ZodTypeAny>) => Promise<string>) => {
		const wrappedCb = async (args: ZodRawShape): Promise<CallToolResult> => {
			try {
				trace(`Invoking ${name} with args: ${JSON.stringify(args)}`);
				const response = await cb(args);
				trace(`=> ${response}`);
				return {
					content: [{ type: "text", text: response }],
				};
			} catch (error: any) {
				if (error instanceof ActionableError) {
					return {
						content: [{ type: "text", text: `${error.message}. Please fix the issue and try again.` }],
					};
				} else {
					// a real exception
					trace(`Tool '${description}' failed: ${error.message} stack: ${error.stack}`);
					return {
						content: [{ type: "text", text: `Error: ${error.message}` }],
						isError: true,
					};
				}
			}
		};

		server.tool(name, description, paramsSchema, args => wrappedCb(args));
	};

	let robot: Robot | null;
	const simulatorManager = new SimctlManager();

	const requireRobot = () => {
		if (!robot) {
			throw new ActionableError("No device selected. Use the mobile_use_device tool to select a device.");
		}
	};

	tool(
		"mobile_list_available_devices",
		"List all available devices. This includes both physical devices and simulators. If there is more than one device returned, you need to let the user select one of them.",
		{
			noParams
		},
		async ({}) => {
			const iosManager = new IosManager();
			const androidManager = new AndroidDeviceManager();
			const devices = simulatorManager.listBootedSimulators();
			const simulatorNames = devices.map(d => d.name);
			const androidDevices = androidManager.getConnectedDevices();
			const iosDevices = await iosManager.listDevices();
			const iosDeviceNames = iosDevices.map(d => d.deviceId);
			const androidTvDevices = androidDevices.filter(d => d.deviceType === "tv").map(d => d.deviceId);
			const androidMobileDevices = androidDevices.filter(d => d.deviceType === "mobile").map(d => d.deviceId);

			const resp = ["Found these devices:"];
			if (simulatorNames.length > 0) {
				resp.push(`iOS simulators: [${simulatorNames.join(".")}]`);
			}

			if (iosDevices.length > 0) {
				resp.push(`iOS devices: [${iosDeviceNames.join(",")}]`);
			}

			if (androidMobileDevices.length > 0) {
				resp.push(`Android devices: [${androidMobileDevices.join(",")}]`);
			}

			if (androidTvDevices.length > 0) {
				resp.push(`Android TV devices: [${androidTvDevices.join(",")}]`);
			}

			return resp.join("\n");
		}
	);

	tool(
		"mobile_use_device",
		"Select a device to use. This can be a simulator or an Android device. Use the list_available_devices tool to get a list of available devices.",
		{
			device: z.string().describe("The name of the device to select"),
			deviceType: z.enum(["simulator", "ios", "android"]).describe("The type of device to select"),
		},
		async ({ device, deviceType }) => {
			switch (deviceType) {
				case "simulator":
					robot = simulatorManager.getSimulator(device);
					break;
				case "ios":
					robot = new IosRobot(device);
					break;
				case "android":
					robot = new AndroidRobot(device);
					break;
			}

			return `Selected device: ${device}`;
		}
	);

	tool(
		"mobile_list_apps",
		"List all the installed apps on the device",
		{
			ios_use_booted: z.boolean().optional().describe("Whether to use the booted simulator instead of the selected device UUID. Defaults to false."),
			noParams
		},
		async ({ ios_use_booted = false }) => {
			requireRobot();
			let result;
			if (ios_use_booted && robot!.listAppsBooted) {
				result = await robot!.listAppsBooted();
			} else {
				result = await robot!.listApps();
			}
			return `Found these apps on device: ${result.map(app => `${app.appName} (${app.packageName})`).join(", ")}`;
		}
	);

	tool(
		"mobile_launch_app",
		"Launch an app on mobile device. Use this to open a specific app. You can find the package name of the app by calling list_apps_on_device.",
		{
			packageName: z.string().describe("The package name of the app to launch"),
			ios_use_booted: z.boolean().optional().describe("Whether to use the booted simulator instead of the selected device UUID. Defaults to true.")
		},
		async ({ packageName, ios_use_booted = true }) => {
			requireRobot();
			if (ios_use_booted && robot!.launchAppBooted) {
				await robot!.launchAppBooted(packageName);
			} else {
				await robot!.launchApp(packageName);
			}
			return `Launched app ${packageName}`;
		}
	);

	tool(
		"mobile_terminate_app",
		"Stop and terminate an app on mobile device",
		{
			packageName: z.string().describe("The package name of the app to terminate"),
			ios_use_booted: z.boolean().optional().describe("Whether to use the booted simulator instead of the selected device UUID. Defaults to true.")
		},
		async ({ packageName, ios_use_booted = true }) => {
			requireRobot();
			if (ios_use_booted && robot!.terminateAppBooted) {
				await robot!.terminateAppBooted(packageName);
			} else {
				await robot!.terminateApp(packageName);
			}
			return `Terminated app ${packageName}`;
		}
	);

	tool(
		"mobile_get_screen_size",
		"Get the screen size of the mobile device in pixels",
		{
			noParams
		},
		async ({}) => {
			requireRobot();
			const screenSize = await robot!.getScreenSize();
			return `Screen size is ${screenSize.width}x${screenSize.height} pixels`;
		}
	);

	tool(
		"mobile_click_on_screen_at_coordinates",
		"Click on the screen at given x,y coordinates",
		{
			x: z.number().describe("The x coordinate to click on the screen, in pixels"),
			y: z.number().describe("The y coordinate to click on the screen, in pixels"),
		},
		async ({ x, y }) => {
			requireRobot();
			await robot!.tap(x, y);
			return `Clicked on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"mobile_list_elements_on_screen",
		"List elements on screen and their coordinates, with display text or accessibility label. Do not cache this result.",
		{
			noParams
		},
		async ({}) => {
			requireRobot();
			const elements = await robot!.getElementsOnScreen();

			const result = elements.map(element => {
				const out: any = {
					type: element.type,
					text: element.text,
					label: element.label,
					name: element.name,
					value: element.value,
					identifier: element.identifier,
					coordinates: {
						x: element.rect.x,
						y: element.rect.y,
						width: element.rect.width,
						height: element.rect.height,
					},
				};

				if (element.focused) {
					out.focused = true;
				}

				return out;
			});

			return `Found these elements on screen: ${JSON.stringify(result)}`;
		}
	);

	tool(
		"mobile_press_button",
		"Press a button on device",
		{
			button: z.string().describe("The button to press. Supported buttons: BACK (android only), HOME, VOLUME_UP, VOLUME_DOWN, ENTER, DPAD_CENTER (android tv only), DPAD_UP (android tv only), DPAD_DOWN (android tv only), DPAD_LEFT (android tv only), DPAD_RIGHT (android tv only)"),
		},
		async ({ button }) => {
			requireRobot();
			await robot!.pressButton(button);
			return `Pressed the button: ${button}`;
		}
	);

	tool(
		"mobile_open_url",
		"Open a URL in browser on device",
		{
			url: z.string().describe("The URL to open"),
		},
		async ({ url }) => {
			requireRobot();
			await robot!.openUrl(url);
			return `Opened URL: ${url}`;
		}
	);

	tool(
		"swipe_on_screen",
		"Swipe on the screen",
		{
			direction: z.enum(["up", "down", "left", "right"]).describe("The direction to swipe"),
			x: z.number().optional().describe("The x coordinate to start the swipe from, in pixels. If not provided, uses center of screen"),
			y: z.number().optional().describe("The y coordinate to start the swipe from, in pixels. If not provided, uses center of screen"),
			distance: z.number().optional().describe("The distance to swipe in pixels. Defaults to 400 pixels for iOS or 30% of screen dimension for Android"),
		},
		async ({ direction, x, y, distance }) => {
			requireRobot();

			if (x !== undefined && y !== undefined) {
				// Use coordinate-based swipe
				await robot!.swipeFromCoordinate(x, y, direction, distance);
				const distanceText = distance ? ` ${distance} pixels` : "";
				return `Swiped ${direction}${distanceText} from coordinates: ${x}, ${y}`;
			} else {
				// Use center-based swipe
				await robot!.swipe(direction);
				return `Swiped ${direction} on screen`;
			}
		}
	);

	tool(
		"mobile_type_keys",
		"Type text into the focused element",
		{
			text: z.string().describe("The text to type"),
			submit: z.boolean().describe("Whether to submit the text. If true, the text will be submitted as if the user pressed the enter key."),
		},
		async ({ text, submit }) => {
			requireRobot();
			await robot!.sendKeys(text);

			if (submit) {
				await robot!.pressButton("ENTER");
			}

			return `Typed text: ${text}`;
		}
	);

	server.tool(
		"mobile_take_screenshot",
		"Take a screenshot of the mobile device. Use this to understand what's on screen, if you need to press an element that is available through view hierarchy then you must list elements on screen instead. Do not cache this result.",
		{
			ios_use_booted: z.boolean().optional().describe("Whether to use the booted simulator instead of the selected device UUID. Defaults to false."),
			save: z.boolean().optional().describe("Whether to save the compressed screenshot to disk. Defaults to false.")
		},
		async ({ ios_use_booted = true, save = false }) => {
			requireRobot();

			try {
				const screenSize = await robot!.getScreenSize();

				let screenshot: Buffer;
				if (ios_use_booted && robot!.getScreenshotBooted) {
					screenshot = await robot!.getScreenshotBooted();
				} else {
					screenshot = await robot!.getScreenshot();
				}
				let mimeType = "image/png";

				// validate we received a png, will throw exception otherwise
				const image = new PNG(screenshot);
				const pngSize = image.getDimensions();
				if (pngSize.width <= 0 || pngSize.height <= 0) {
					throw new ActionableError("Screenshot is invalid. Please try again.");
				}

				let savedPath: string | undefined;

				if (isImageMagickInstalled()) {
					trace("ImageMagick is installed, resizing screenshot");
					const image = Image.fromBuffer(screenshot);
					const beforeSize = screenshot.length;
					screenshot = image.resize(Math.floor(pngSize.width / screenSize.scale))
						.jpeg({ quality: 75 })
						.toBuffer();

					const afterSize = screenshot.length;
					trace(`Screenshot resized from ${beforeSize} bytes to ${afterSize} bytes`);

					mimeType = "image/jpeg";

					if (save) {
						const tmpFilename = path.join(tmpdir(), `compressed-screenshot-${randomBytes(8).toString("hex")}.jpg`);
						writeFileSync(tmpFilename, screenshot);
						savedPath = tmpFilename;
						trace(`Compressed screenshot saved to: ${savedPath}`);
					}
				}

				const screenshot64 = screenshot.toString("base64");
				trace(`Screenshot taken: ${screenshot.length} bytes`);

				const textContent = savedPath
					? `Screenshot: ${pngSize.width}x${pngSize.height}px, ${formatBytes(screenshot.length)}, saved to: ${savedPath}`
					: `Screenshot: ${pngSize.width}x${pngSize.height}px, ${formatBytes(screenshot.length)}`;

				return {
					content: [
						{ type: "text", text: textContent },
						{ type: "image", data: screenshot64, mimeType }
					]
				};
			} catch (err: any) {
				error(`Error taking screenshot: ${err.message} ${err.stack}`);
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					isError: true,
				};
			}
		}
	);

	tool(
		"mobile_set_orientation",
		"Change the screen orientation of the device",
		{
			orientation: z.enum(["portrait", "landscape"]).describe("The desired orientation"),
		},
		async ({ orientation }) => {
			requireRobot();
			await robot!.setOrientation(orientation);
			return `Changed device orientation to ${orientation}`;
		}
	);

	tool(
		"mobile_get_orientation",
		"Get the current screen orientation of the device",
		{
			noParams
		},
		async () => {
			requireRobot();
			const orientation = await robot!.getOrientation();
			return `Current device orientation is ${orientation}`;
		}
	);

	tool(
		"mobile_tap_element",
		"Find an element on screen by query and tap it. This combines list_elements and tap functionality.",
		{
			query: z.string().describe("Search query to find the element (matches against text, label, name, value, or identifier)")
		},
		async ({ query }) => {
			requireRobot();
			const elements = await robot!.getElementsOnScreen();

			// Find all matching elements by searching text, label, name, value, and identifier
			const matchingElements = elements.filter(element => {
				const searchFields = [
					element.text,
					element.label,
					element.name,
					element.value,
					element.identifier
				].filter(field => field && field.trim() !== "");

				return searchFields.some(field =>
					field && field.toLowerCase().includes(query.toLowerCase())
				);
			});

			if (matchingElements.length === 0) {
				throw new ActionableError(`No element found matching query: "${query}". Available elements: ${elements.map(e => e.text || e.label || e.name || e.value || e.identifier).filter(t => t).join(", ")}`);
			}

			if (matchingElements.length > 1) {
				const matchingElementsJson = matchingElements.map(element => ({
					type: element.type,
					text: element.text,
					label: element.label,
					name: element.name,
					value: element.value,
					identifier: element.identifier,
					coordinates: {
						x: element.rect.x + (element.rect.width / 2),
						y: element.rect.y + (element.rect.height / 2)
					},
					rect: element.rect
				}));

				throw new ActionableError(`Multiple elements found matching query: "${query}". Found ${matchingElements.length} matches:\n${JSON.stringify(matchingElementsJson, null, 2)}`);
			}

			const matchingElement = matchingElements[0];

			// Calculate center coordinates of the element
			const centerX = matchingElement.rect.x + (matchingElement.rect.width / 2);
			const centerY = matchingElement.rect.y + (matchingElement.rect.height / 2);

			// Tap the element
			await robot!.tap(centerX, centerY);

			return `Tapped element "${matchingElement.text || matchingElement.label || matchingElement.name || matchingElement.value || matchingElement.identifier}" at coordinates: ${centerX}, ${centerY}`;
		}
	);

	tool(
		"mobile_get_log",
		"Get device logs with optional filtering. For iOS simulators, gets logs from running apps using log show command. For iOS physical devices, gets system logs. For Android devices, gets logcat output.",
		{
			timeWindow: z.string().optional().describe("Time window to look back (e.g., '5m' for 5 minutes, '1h' for 1 hour). Defaults to '1m'"),
			filter: z.string().optional().describe("Filter logs containing this query (case-insensitive). For Android: supports 'package:mine <query>' (user apps only), 'package:com.app.bundle <query>' (specific app), or '<query>' (text search). For iOS: simple text search only."),
			iosUseBooted: z.boolean().optional().describe("For iOS simulators only: whether to use the booted simulator instead of the selected device UUID. Defaults to false"),
			process: z.string().optional().describe("Filter logs to a specific process/app bundle ID (e.g., 'com.ramp.Ramp.ios'). Can be combined with 'filter' for text search within that process. If not provided, attempts to auto-detect running user apps.")
		},
		async ({ timeWindow, filter, iosUseBooted, process }) => {
			requireRobot();
			const logs = await robot!.getDeviceLogs({ timeWindow, filter, iosUseBooted, process });
			const filterText = filter ? ` (filtered by: ${filter})` : "";
			const processText = process ? ` (process: ${process})` : "";
			const timeText = timeWindow ? ` from last ${timeWindow}` : "";
			return `Device logs${timeText}${filterText}${processText}:\n${logs}`;
		}
	);

	// async check for latest agent version
	checkForLatestAgentVersion().then();

	return server;
};
