/**
 * pi-sidepanel-files — Files modified tab for pi-sidepanel
 *
 * Registers a "Files" tab that shows all files modified by the agent
 * during the current session (via write and edit tools), rendered as
 * a collapsible tree. Persists across pi restarts via session replay.
 *
 * Purely event wiring — tree model and rendering live in ./files.ts.
 */

import type {
	EditToolCallEvent,
	ExtensionAPI,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import * as path from "node:path";
import { FilesTabComponent, type ThemeColors } from "./files.ts";

// ── Extension entry point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const filesComponent = new FilesTabComponent({
		matchesKey,
		truncateToWidth,
		visibleWidth,
	});
	let registered = false;

	function registerTab(): void {
		if (registered) return;
		registered = true;
		try {
			const themedComponent = {
				handleInput(data: string): void {
					filesComponent.handleInput(data);
				},
				render(width: number, height?: number): string[] {
					return filesComponent.render(width, height);
				},
				invalidate(): void {
					filesComponent.invalidate();
				},
				setTheme(t: ThemeColors): void {
					filesComponent.setTheme(t);
				},
			};

			pi.events.emit("sidepanel:register", {
				id: "files",
				label: "Outputs",
				component: themedComponent,
			});
		} catch {
			// Registration failed
		}
	}

	// Register on session start — replay history to survive pi restarts
	pi.on("session_start", async (_event: any, ctx: any) => {
		registered = false;
		filesComponent.reset();

		// Register immediately, flag busy, and yield a frame so the loading
		// placeholder paints before the synchronous replay runs.
		registerTab();
		pi.events.emit("sidepanel:busy", {
			tabId: "files",
			busy: true,
			message: "replaying session…",
		});
		await new Promise((resolve) => setTimeout(resolve, 24));

		try {
			const entries = ctx.sessionManager.getEntries() as Array<{
				type: string;
				message?: {
					role: string;
					content?: Array<{
						type: string;
						name?: string;
						arguments?: { path?: string };
					}>;
				};
			}>;

			const cwd = process.cwd();
			const capped = entries.slice(-300);
			for (const e of capped) {
				if (e.type !== "message") continue;
				const m = e.message;
				if (!m || m.role !== "assistant") continue;

				const blocks = Array.isArray(m.content) ? m.content : [];
				for (const b of blocks) {
					if (b.type !== "toolCall") continue;
					if (b.name !== "write" && b.name !== "edit") continue;

					const rawPath = b.arguments?.path;
					if (rawPath) {
						const displayPath = path.isAbsolute(rawPath)
							? path.relative(cwd, rawPath)
							: rawPath;
						filesComponent.addFile(displayPath, b.name);
					}
				}
			}
		} catch {
			// Replay failed — tab already registered with empty state
		} finally {
			pi.events.emit("sidepanel:busy", { tabId: "files", busy: false });
			pi.events.emit("sidepanel:invalidate", { tabId: "files" });
		}
	});

	// Listen for write and edit tool calls
	pi.on("tool_call", (event: WriteToolCallEvent | EditToolCallEvent) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const rawPath = event.input.path;
		if (rawPath) {
			const cwd = process.cwd();
			const displayPath = path.isAbsolute(rawPath)
				? path.relative(cwd, rawPath)
				: rawPath;
			filesComponent.addFile(displayPath, event.toolName);
			pi.events.emit("sidepanel:invalidate", {
				tabId: "files",
			});
		}
	});

	// ── Fallback registration ────────────────────────────────────────
	//
	// The framework resets its registry on ITS session_start and then emits
	// "sidepanel:ready". If this extension's session_start handler ran first,
	// the registration was wiped — re-register unconditionally (a guard on
	// `registered` would skip the recovery; it's already true). Registration
	// is idempotent: the framework dedups by id.

	pi.events.on("sidepanel:ready", () => {
		registered = false;
		registerTab();
	});
}
