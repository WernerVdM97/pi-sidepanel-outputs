/**
 * pi-sidepanel-files — Files modified tab for pi-sidepanel
 *
 * Registers a "Files" tab that shows all files modified by the agent
 * during the current session (via write and edit tools), rendered as
 * a collapsible tree. Persists across pi restarts via session replay.
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

// ── Types ─────────────────────────────────────────────────────────────────

/** Stored flat: path → tool name ("write" | "edit"). Deduplication key. */
type ToolMap = Map<string, string>;

// ── Theme helpers ─────────────────────────────────────────────────────────

interface ThemeColors {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

const defaultTheme: ThemeColors = {
	fg: (_c, s) => s,
	bg: (_c, s) => s,
	bold: (s) => s,
};

// ── Tree types ────────────────────────────────────────────────────────────

interface TreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	children: TreeNode[];
	/** Only set for file nodes: the tool that touched it. */
	tool?: string;
}

interface FlatEntry {
	node: TreeNode;
	depth: number;
	isLast: boolean;
	ancestorLast: boolean[];
}

// ── Tree builders ─────────────────────────────────────────────────────────

/** Build a tree of TreeNode from a flat map of path → tool. */
function buildTree(files: ToolMap): TreeNode[] {
	const roots: TreeNode[] = [];
	const nodeMap = new Map<string, TreeNode>();

	// Sort paths for deterministic output
	const sortedPaths = [...files.keys()].sort();

	for (const filePath of sortedPaths) {
		const tool = files.get(filePath)!;
		const parts = filePath.split(path.sep);
		let currentList = roots;
		let builtPath = "";

		for (let i = 0; i < parts.length; i++) {
			const name = parts[i]!;
			builtPath = builtPath ? path.join(builtPath, name) : name;
			const isLast = i === parts.length - 1;
			const nodeType: "file" | "directory" = isLast ? "file" : "directory";

			let node = nodeMap.get(builtPath);
			if (!node) {
				node = {
					name,
					path: builtPath,
					type: nodeType,
					children: [],
					tool: isLast ? tool : undefined,
				};
				nodeMap.set(builtPath, node);
				currentList.push(node);

				// Sort: dirs first, then files, both alphabetically
				currentList.sort((a, b) => {
					if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
					return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
				});
			}

			currentList = node.children;
		}
	}

	return roots;
}

/** Flatten tree into a list of visible (always-expanded) entries. */
function flattenTree(
	nodes: TreeNode[],
	depth: number,
	ancestorLast: boolean[],
): FlatEntry[] {
	const result: FlatEntry[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const isLast = i === nodes.length - 1;
		const entry: FlatEntry = {
			node: nodes[i]!,
			depth,
			isLast,
			ancestorLast: [...ancestorLast],
		};
		result.push(entry);
		// Directories always expanded (no collapse toggle in files tab)
		if (nodes[i]!.type === "directory" && nodes[i]!.children.length > 0) {
			result.push(
				...flattenTree(nodes[i]!.children, depth + 1, [
					...ancestorLast,
					isLast,
				]),
			);
		}
	}
	return result;
}

// ── Tree connectors ───────────────────────────────────────────────────────

function indentPrefix(ancestorLast: boolean[], depth: number): string {
	let prefix = "";
	for (let d = 0; d < depth; d++) {
		prefix += d >= ancestorLast.length || ancestorLast[d] ? "    " : "│   ";
	}
	return prefix;
}

function connector(isLast: boolean): string {
	return isLast ? "└── " : "├── ";
}

// ── FilesTabComponent ─────────────────────────────────────────────────────

class FilesTabComponent {
	/** Max files tracked. Oldest evicted when exceeded. */
	private static readonly MAX_FILES = 300;

	private files: ToolMap = new Map();
	/** Insertion order for LRU eviction. */
	private fileOrder: string[] = [];
	private scrollOffset = 0;
	private followTail = true;
	private theme: ThemeColors | null = null;

	// cache
	private cachedWidth?: number;
	private cachedLines?: string[];
	private flatList: FlatEntry[] = [];

	private visibleArea = 40;

	constructor() {}

	reset(): void {
		this.files.clear();
		this.fileOrder = [];
		this.scrollOffset = 0;
		this.followTail = true;
		this.flatList = [];
		this.invalidate();
	}

	setTheme(theme: ThemeColors): void {
		this.theme = theme;
	}

	addFile(filePath: string, tool: string): void {
		// Track insertion order for new entries
		if (!this.files.has(filePath)) {
			this.fileOrder.push(filePath);
		}
		// Deduplicate: later tool overwrites earlier
		this.files.set(filePath, tool);
		// Evict oldest when over cap
		while (this.files.size > FilesTabComponent.MAX_FILES) {
			const oldest = this.fileOrder.shift();
			if (oldest) this.files.delete(oldest);
		}
		this.rebuildFlatList();
		this.invalidate();
	}

	private rebuildFlatList(): void {
		const roots = buildTree(this.files);
		this.flatList = flattenTree(roots, 0, []);
	}

	// ── Component interface ──────────────────────────────────────────

	handleInput(data: string): void {
		const maxScroll = Math.max(0, this.flatList.length - this.visibleArea);

		if (data === "j" || matchesKey(data, "down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			if (this.scrollOffset >= maxScroll) this.followTail = true;
			this.invalidate();
			return;
		}
		if (data === "k" || matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.followTail = false;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "pageup")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.visibleArea);
			this.followTail = false;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "pagedown")) {
			this.scrollOffset = Math.min(
				maxScroll,
				this.scrollOffset + this.visibleArea,
			);
			if (this.scrollOffset >= maxScroll) this.followTail = true;
			this.invalidate();
			return;
		}
		if (data === "g") {
			this.scrollOffset = 0;
			this.followTail = false;
			this.invalidate();
			return;
		}
		if (data === "G") {
			this.scrollOffset = maxScroll;
			this.followTail = true;
			this.invalidate();
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		if (this.followTail && this.flatList.length > 0) {
			this.scrollOffset = Math.max(0, this.flatList.length - this.visibleArea);
		}

		const th = this.theme ?? defaultTheme;
		const lines: string[] = [];

		if (this.flatList.length === 0) {
			lines.push(
				th.fg("dim", truncateToWidth(" No files modified yet", width, "")),
			);
		} else {
			const visible = this.flatList.slice(
				this.scrollOffset,
				this.scrollOffset + this.visibleArea,
			);

			for (const entry of visible) {
				const { node, depth, isLast, ancestorLast } = entry;
				const pre = indentPrefix(ancestorLast, depth);
				const conn = connector(isLast);

				if (node.type === "directory") {
					// Directories: orange, bold
					const dirName = th.fg("syntaxNumber", th.bold(node.name + "/"));
					const line = ` ${pre}${conn}${dirName}`;
					const vw = visibleWidth(line);
					lines.push(
						vw > width ? truncateToWidth(line, width, "…", false) : line,
					);
				} else {
					// Files: tool tag + name
					const isWrite = node.tool === "write";
					const tag = isWrite
						? th.fg("success", "[W]")
						: th.fg("warning", "[E]");
					const line = ` ${pre}${conn}${tag} ${node.name}`;
					const vw = visibleWidth(line);
					lines.push(
						vw > width ? truncateToWidth(line, width, "…", false) : line,
					);
				}
			}
		}

		// Keymap footer (pinned to bottom of 40-line viewport)
		while (lines.length < 39) lines.push("");
		lines.push(
			th.fg("dim", truncateToWidth(" j/k scroll │ g/G top/bot", width, "")),
		);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── Extension entry point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const filesComponent = new FilesTabComponent();
	let registered = false;

	function registerTab(): void {
		if (registered) return;
		registered = true;
		try {
			const themedComponent = {
				handleInput(data: string): void {
					filesComponent.handleInput(data);
				},
				render(width: number): string[] {
					return filesComponent.render(width);
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
	pi.on("session_start", (_event: any, ctx: any) => {
		registered = false;
		filesComponent.reset();

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
		} finally {
			registerTab();
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
}
