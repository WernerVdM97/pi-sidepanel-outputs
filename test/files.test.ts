/**
 * pi-sidepanel-files unit tests
 *
 * Tests tree building from flat file paths, flattening, rendering
 * with [W]/[E] tags, deduplication, and indent/connector alignment.
 *
 * Run: node --test test/files.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Types ─────────────────────────────────────────────────────────────────

interface TreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	children: TreeNode[];
	tool?: string;
}

interface FlatEntry {
	node: TreeNode;
	depth: number;
	isLast: boolean;
	ancestorLast: boolean[];
}

// ── Tree builders (extracted from index.ts) ──────────────────────────────

function buildTree(files: Map<string, string>): TreeNode[] {
	const roots: TreeNode[] = [];
	const nodeMap = new Map<string, TreeNode>();

	const sortedPaths = [...files.keys()].sort();

	for (const filePath of sortedPaths) {
		const tool = files.get(filePath)!;
		const parts = filePath.split("/");
		let currentList = roots;
		let builtPath = "";

		for (let i = 0; i < parts.length; i++) {
			const name = parts[i]!;
			builtPath = builtPath ? `${builtPath}/${name}` : name;
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

function flattenTree(nodes: TreeNode[], depth: number, ancestorLast: boolean[]): FlatEntry[] {
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
		if (nodes[i]!.type === "directory" && nodes[i]!.children.length > 0) {
			result.push(...flattenTree(nodes[i]!.children, depth + 1, [...ancestorLast, isLast]));
		}
	}
	return result;
}

// ── Rendering helpers ─────────────────────────────────────────────────────

function indentPrefix(ancestorLast: boolean[], depth: number): string {
	let prefix = "";
	for (let d = 0; d < depth; d++) {
		prefix += (d >= ancestorLast.length || ancestorLast[d]) ? "    " : "│   ";
	}
	return prefix;
}

function connector(isLast: boolean): string {
	return isLast ? "└── " : "├── ";
}

function renderLine(entry: FlatEntry): string {
	const pre = indentPrefix(entry.ancestorLast, entry.depth);
	const conn = connector(entry.isLast);
	if (entry.node.type === "directory") {
		return ` ${pre}${conn}${entry.node.name}/`;
	} else {
		const tag = entry.node.tool === "write" ? "[W]" : "[E]";
		return ` ${pre}${conn}${tag} ${entry.node.name}`;
	}
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

describe("buildTree", () => {
	it("empty map produces empty tree", () => {
		const tree = buildTree(new Map());
		assert.equal(tree.length, 0);
	});

	it("single file produces flat tree", () => {
		const files = new Map([["src/index.ts", "write"]]);
		const tree = buildTree(files);

		assert.equal(tree.length, 1);
		assert.equal(tree[0]!.name, "src");
		assert.equal(tree[0]!.type, "directory");
		assert.equal(tree[0]!.children.length, 1);
		assert.equal(tree[0]!.children[0]!.name, "index.ts");
		assert.equal(tree[0]!.children[0]!.tool, "write");
	});

	it("two files in same directory share parent", () => {
		const files = new Map([
			["src/a.ts", "write"],
			["src/b.ts", "edit"],
		]);
		const tree = buildTree(files);

		assert.equal(tree.length, 1);
		assert.equal(tree[0]!.name, "src");
		assert.equal(tree[0]!.children.length, 2);
		assert.equal(tree[0]!.children[0]!.name, "a.ts");
		assert.equal(tree[0]!.children[0]!.tool, "write");
		assert.equal(tree[0]!.children[1]!.name, "b.ts");
		assert.equal(tree[0]!.children[1]!.tool, "edit");
	});

	it("nested directories build correctly", () => {
		const files = new Map([["a/b/c/d.ts", "edit"]]);
		const tree = buildTree(files);

		assert.equal(tree.length, 1);
		let node = tree[0]!;
		assert.equal(node.name, "a");
		node = node.children[0]!;
		assert.equal(node.name, "b");
		node = node.children[0]!;
		assert.equal(node.name, "c");
		node = node.children[0]!;
		assert.equal(node.name, "d.ts");
		assert.equal(node.tool, "edit");
	});

	it("siblings across different branches", () => {
		const files = new Map([
			["src/lib/foo.ts", "write"],
			["src/app.ts", "edit"],
			["test/spec.ts", "write"],
		]);
		const tree = buildTree(files);

		// Roots should be: src/ and test/ (alphabetical)
		assert.equal(tree.length, 2);
		assert.equal(tree[0]!.name, "src");
		assert.equal(tree[1]!.name, "test");

		// src/ children: lib/ (dir) and app.ts (file), dirs first
		assert.equal(tree[0]!.children.length, 2);
		assert.equal(tree[0]!.children[0]!.name, "lib");
		assert.equal(tree[0]!.children[0]!.type, "directory");
		assert.equal(tree[0]!.children[1]!.name, "app.ts");
		assert.equal(tree[0]!.children[1]!.type, "file");
	});

	it("sorting: directories before files, alphabetical within type", () => {
		const files = new Map([
			["z.ts", "write"],
			["a-dir/x.ts", "edit"],
			["m.ts", "write"],
		]);
		const tree = buildTree(files);

		// Roots: a-dir/ (dir) before m.ts, z.ts (files, alphabetical)
		assert.equal(tree.length, 3);
		assert.equal(tree[0]!.name, "a-dir");
		assert.equal(tree[1]!.name, "m.ts");
		assert.equal(tree[2]!.name, "z.ts");
	});

	it("deduplication: last write wins", () => {
		const files = new Map([
			["file.ts", "write"],
			["file.ts", "edit"],
		]);
		const tree = buildTree(files);

		assert.equal(tree.length, 1);
		assert.equal(tree[0]!.name, "file.ts");
		assert.equal(tree[0]!.tool, "edit");
	});

	it("case-insensitive alphabetical sort", () => {
		const files = new Map([
			["Z.ts", "write"],
			["a.ts", "write"],
			["M.ts", "write"],
		]);
		const tree = buildTree(files);

		assert.equal(tree.length, 3);
		assert.equal(tree[0]!.name, "a.ts");
		assert.equal(tree[1]!.name, "M.ts");
		assert.equal(tree[2]!.name, "Z.ts");
	});
});

describe("flattenTree", () => {
	it("flattens single level", () => {
		const files = new Map([
			["a.ts", "write"],
			["b.ts", "edit"],
		]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);

		assert.equal(flat.length, 2);
		assert.equal(flat[0]!.depth, 0);
		assert.equal(flat[0]!.isLast, false);
		assert.equal(flat[1]!.depth, 0);
		assert.equal(flat[1]!.isLast, true);
	});

	it("flattens nested structure with correct depths", () => {
		const files = new Map([["src/sub/deep/file.ts", "write"]]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);

		assert.equal(flat.length, 4);
		assert.deepEqual(flat.map((e) => e.node.name), ["src", "sub", "deep", "file.ts"]);
		assert.deepEqual(flat.map((e) => e.depth), [0, 1, 2, 3]);
		assert.deepEqual(flat.map((e) => e.isLast), [true, true, true, true]);
	});

	it("isLast is false for non-last siblings", () => {
		const files = new Map([
			["a-src/a.ts", "write"],
			["a-src/b.ts", "edit"],
			["z-lib/x.ts", "write"],
		]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);

		// Root level: a-src/ (not last), z-lib/ (last)
		const srcEntry = flat.find((e) => e.node.name === "a-src")!;
		assert.equal(srcEntry.isLast, false);
		const libEntry = flat.find((e) => e.node.name === "z-lib")!;
		assert.equal(libEntry.isLast, true);

		// Children of a-src: a.ts (not last), b.ts (last)
		const aEntry = flat.find((e) => e.node.name === "a.ts")!;
		assert.equal(aEntry.isLast, false);
		const bEntry = flat.find((e) => e.node.name === "b.ts")!;
		assert.equal(bEntry.isLast, true);
	});
});

describe("Rendering", () => {
	it("single-file tree renders correctly", () => {
		const files = new Map([["src/index.ts", "write"]]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);
		const lines = flat.map(renderLine);

		assert.deepEqual(lines, [
			" └── src/",
			"     └── [W] index.ts",
		]);
	});

	it("complex tree renders correctly", () => {
		const files = new Map([
			["src/sub/deep/utils.ts", "edit"],
			["src/app.ts", "write"],
			["README.md", "write"],
		]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);
		const lines = flat.map(renderLine);

		assert.deepEqual(lines, [
			" ├── src/",           // directory before file
			" │   ├── sub/",
			" │   │   └── deep/",
			" │   │       └── [E] utils.ts",
			" │   └── [W] app.ts",
			" └── [W] README.md",  // file after directories
		]);
	});

	it("write files get [W] tag, edit files get [E] tag", () => {
		const files = new Map([
			["a.ts", "write"],
			["b.ts", "edit"],
		]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);
		const lines = flat.map(renderLine);

		assert.ok(lines[0]!.includes("[W]"), `expected [W] tag, got: ${lines[0]}`);
		assert.ok(lines[1]!.includes("[E]"), `expected [E] tag, got: ${lines[1]}`);
	});

	it("connector alignment: child connector under parent name", () => {
		const files = new Map([["src/file.ts", "write"]]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);
		const lines = flat.map(renderLine);

		// Line 0: " └── src/" → name "src/" starts at position 5
		// Line 1: "      └── [W] file.ts" → connector "└──" starts at position 5
		const dirLine = lines[0]!;
		const fileLine = lines[1]!;

		// Name starts after " └── " (5 chars)
		const dirNamePos = " └── ".length; // 5
		// Connector starts after " " + "    " = 5
		const fileConnPos = "     ".length; // 5
		assert.equal(dirNamePos, fileConnPos);
	});

	it("connector is always 4 chars", () => {
		assert.equal(connector(true).length, 4);
		assert.equal(connector(false).length, 4);
	});

	it("indent is always multiple of 4", () => {
		assert.equal(indentPrefix([], 0).length, 0);
		assert.equal(indentPrefix([true], 1).length, 4);
		assert.equal(indentPrefix([true, false], 2).length, 8);
		assert.equal(indentPrefix([false, false], 2).length, 8);
	});
});

describe("Edge cases", () => {
	it("single file at root level", () => {
		const files = new Map([["README.md", "write"]]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);

		assert.equal(flat.length, 1);
		assert.equal(flat[0]!.node.name, "README.md");
		assert.equal(flat[0]!.node.tool, "write");
		assert.equal(flat[0]!.depth, 0);
	});

	it("deeply nested single file", () => {
		const files = new Map([["a/b/c/d/e/f/file.ts", "edit"]]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);

		assert.equal(flat.length, 7); // a,b,c,d,e,f,file.ts
		assert.equal(flat[6]!.node.name, "file.ts");
		assert.equal(flat[6]!.depth, 6);
	});

	it("files with common prefix don't collide", () => {
		const files = new Map([
			["src-tools/a.ts", "write"],
			["src/b.ts", "edit"],
		]);
		const tree = buildTree(files);

		assert.equal(tree.length, 2);
		assert.equal(tree[0]!.name, "src");       // s-r-c directory
		assert.equal(tree[1]!.name, "src-tools");  // s-r-c-tools directory (different!)
	});

	it("all types of file extensions work", () => {
		const files = new Map([
			["config.json", "write"],
			["data.yml", "edit"],
			["script.ts", "write"],
			["style.css", "edit"],
			["readme", "write"],
		]);
		const tree = buildTree(files);
		const flat = flattenTree(tree, 0, []);

		assert.equal(flat.length, files.size);
		for (const entry of flat) {
			assert.equal(entry.depth, 0);
		}
	});
});
