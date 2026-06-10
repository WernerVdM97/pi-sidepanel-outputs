/**
 * pi-sidepanel-outputs — Files-modified data model and rendering (no pi imports)
 *
 * Pure logic: the pi-tui utilities it needs are injected by the entry
 * point (index.ts), so this module is directly importable in unit tests
 * under plain `node --test`.
 */

import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

/** Stored flat: path → tool name ("write" | "edit"). Deduplication key. */
export type ToolMap = Map<string, string>;

export interface ThemeColors {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

const defaultTheme: ThemeColors = {
	fg: (_c, s) => s,
	bg: (_c, s) => s,
	bold: (s) => s,
};

/** Injected pi-tui utilities. */
export interface TuiUtils {
	matchesKey: (data: string, key: string) => boolean;
	truncateToWidth: (
		s: string,
		width: number,
		ellipsis?: string,
		pad?: boolean,
	) => string;
	visibleWidth: (s: string) => number;
}

// ── Tree types ────────────────────────────────────────────────────────────

export interface TreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	children: TreeNode[];
	/** Only set for file nodes: the tool that touched it. */
	tool?: string;
}

export interface FlatEntry {
	node: TreeNode;
	depth: number;
	isLast: boolean;
	ancestorLast: boolean[];
}

// ── Tree builders ─────────────────────────────────────────────────────────

/** Build a tree of TreeNode from a flat map of path → tool. */
export function buildTree(files: ToolMap): TreeNode[] {
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
export function flattenTree(
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

export function indentPrefix(ancestorLast: boolean[], depth: number): string {
	let prefix = "";
	for (let d = 0; d < depth; d++) {
		prefix += d >= ancestorLast.length || ancestorLast[d] ? "    " : "│   ";
	}
	return prefix;
}

export function connector(isLast: boolean): string {
	return isLast ? "└── " : "├── ";
}

// ── FilesTabComponent ─────────────────────────────────────────────────────

export class FilesTabComponent {
	/** Max files tracked. Oldest evicted when exceeded. */
	private static readonly MAX_FILES = 300;

	private files: ToolMap = new Map();
	/** Insertion order for LRU eviction. */
	private fileOrder: string[] = [];
	private scrollOffset = 0;
	private followTail = true;
	private theme: ThemeColors | null = null;
	private utils: TuiUtils;

	// cache (keyed by width AND height so a vertical resize re-renders)
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];
	private flatList: FlatEntry[] = [];

	/** Rows of tree content (excludes the footer row); set each render from
	 *  the height the framework passes. */
	private visibleArea = 39;

	constructor(utils: TuiUtils) {
		this.utils = utils;
	}

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

	/** Number of tracked files (read-only inspection). */
	get fileCount(): number {
		return this.files.size;
	}

	/** Current flattened entries (read-only inspection). */
	getFlatEntries(): FlatEntry[] {
		return this.flatList;
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
		const { matchesKey } = this.utils;
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

	render(width: number, height = 40): string[] {
		const { truncateToWidth, visibleWidth } = this.utils;
		const H = Math.max(3, Math.floor(height));
		this.visibleArea = H - 1; // reserve the last row for the footer
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedHeight === H
		) {
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

		// Keymap footer (pinned to the bottom of the viewport)
		while (lines.length < H - 1) lines.push("");
		lines.push(
			th.fg("dim", truncateToWidth(" j/k scroll │ g/G top/bot", width, "")),
		);

		this.cachedWidth = width;
		this.cachedHeight = H;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
	}
}
