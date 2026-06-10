/**
 * pi-sidepanel-files unit tests
 *
 * Tests the REAL tree builders and component from ../files.ts (no
 * mirrors): tree building from flat file paths, flattening, rendering
 * with [W]/[E] tags, deduplication, eviction, and scroll behavior.
 *
 * Run: node --test test/files.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	FilesTabComponent,
	buildTree,
	connector,
	flattenTree,
	indentPrefix,
} from "../files.ts";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "./_harness/pi-tui-stub.mjs";

function makeComp(): FilesTabComponent {
	return new FilesTabComponent({ matchesKey, truncateToWidth, visibleWidth });
}

/** Content lines of a render: drop trailing padding and the footer row. */
function contentLines(comp: FilesTabComponent, width = 40, height = 12): string[] {
	const lines = comp.render(width, height);
	return lines.slice(0, -1).filter((l) => l !== "");
}

// ══════════════════════════════════════════════════════════════════════════
// Tree building
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
		const flat = flattenTree(buildTree(files), 0, []);

		assert.equal(flat.length, 2);
		assert.equal(flat[0]!.depth, 0);
		assert.equal(flat[0]!.isLast, false);
		assert.equal(flat[1]!.depth, 0);
		assert.equal(flat[1]!.isLast, true);
	});

	it("flattens nested structure with correct depths", () => {
		const files = new Map([["src/sub/deep/file.ts", "write"]]);
		const flat = flattenTree(buildTree(files), 0, []);

		assert.equal(flat.length, 4);
		assert.deepEqual(
			flat.map((e) => e.node.name),
			["src", "sub", "deep", "file.ts"],
		);
		assert.deepEqual(
			flat.map((e) => e.depth),
			[0, 1, 2, 3],
		);
		assert.deepEqual(
			flat.map((e) => e.isLast),
			[true, true, true, true],
		);
	});

	it("isLast is false for non-last siblings", () => {
		const files = new Map([
			["a-src/a.ts", "write"],
			["a-src/b.ts", "edit"],
			["z-lib/x.ts", "write"],
		]);
		const flat = flattenTree(buildTree(files), 0, []);

		const srcEntry = flat.find((e) => e.node.name === "a-src")!;
		assert.equal(srcEntry.isLast, false);
		const libEntry = flat.find((e) => e.node.name === "z-lib")!;
		assert.equal(libEntry.isLast, true);

		const aEntry = flat.find((e) => e.node.name === "a.ts")!;
		assert.equal(aEntry.isLast, false);
		const bEntry = flat.find((e) => e.node.name === "b.ts")!;
		assert.equal(bEntry.isLast, true);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// Rendering (through the real component, default theme = plain text)
// ══════════════════════════════════════════════════════════════════════════

describe("Rendering", () => {
	it("empty component shows placeholder", () => {
		const c = makeComp();
		assert.ok(c.render(40, 8)[0]!.includes("No files modified yet"));
	});

	it("single-file tree renders correctly", () => {
		const c = makeComp();
		c.addFile("src/index.ts", "write");

		assert.deepEqual(contentLines(c), [
			" └── src/",
			"     └── [W] index.ts",
		]);
	});

	it("complex tree renders correctly", () => {
		const c = makeComp();
		c.addFile("src/sub/deep/utils.ts", "edit");
		c.addFile("src/app.ts", "write");
		c.addFile("README.md", "write");

		assert.deepEqual(contentLines(c), [
			" ├── src/", // directory before file
			" │   ├── sub/",
			" │   │   └── deep/",
			" │   │       └── [E] utils.ts",
			" │   └── [W] app.ts",
			" └── [W] README.md", // file after directories
		]);
	});

	it("write files get [W] tag, edit files get [E] tag", () => {
		const c = makeComp();
		c.addFile("a.ts", "write");
		c.addFile("b.ts", "edit");
		const lines = contentLines(c);

		assert.ok(lines[0]!.includes("[W]"), `expected [W] tag, got: ${lines[0]}`);
		assert.ok(lines[1]!.includes("[E]"), `expected [E] tag, got: ${lines[1]}`);
	});

	it("re-touching a file updates its tag (last tool wins)", () => {
		const c = makeComp();
		c.addFile("file.ts", "write");
		c.addFile("file.ts", "edit");
		const lines = contentLines(c);
		assert.equal(lines.length, 1);
		assert.ok(lines[0]!.includes("[E] file.ts"));
	});

	it("pins the keymap footer to the bottom row", () => {
		const c = makeComp();
		c.addFile("a.ts", "write");
		const lines = c.render(40, 10);
		assert.equal(lines.length, 10);
		assert.ok(lines[9]!.includes("j/k scroll"));
	});

	it("connector is always 4 chars; indent multiples of 4", () => {
		assert.equal(connector(true).length, 4);
		assert.equal(connector(false).length, 4);
		assert.equal(indentPrefix([], 0).length, 0);
		assert.equal(indentPrefix([true], 1).length, 4);
		assert.equal(indentPrefix([true, false], 2).length, 8);
		assert.equal(indentPrefix([false, false], 2).length, 8);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// Component behavior
// ══════════════════════════════════════════════════════════════════════════

describe("FilesTabComponent behavior", () => {
	it("evicts the oldest file beyond the 300-file cap", () => {
		const c = makeComp();
		for (let i = 0; i < 305; i++) {
			c.addFile(`f${String(i).padStart(3, "0")}.ts`, "write");
		}
		assert.equal(c.fileCount, 300);
		const names = c.getFlatEntries().map((e) => e.node.name);
		assert.ok(!names.includes("f000.ts"), "oldest file should be evicted");
		assert.ok(names.includes("f304.ts"));
	});

	it("follows the tail as files are added, until the user scrolls up", () => {
		const c = makeComp();
		for (let i = 0; i < 30; i++) c.addFile(`f${i}.ts`, "write");

		// Tail mode: last entry visible.
		let lines = contentLines(c, 40, 11);
		assert.ok(lines.some((l) => l.includes("f9.ts")));

		// Scroll up → tail mode off; new files don't yank the viewport.
		c.handleInput("g");
		lines = contentLines(c, 40, 11);
		assert.ok(lines[0]!.includes("f0.ts"));
		c.addFile("zzz-new.ts", "write");
		lines = contentLines(c, 40, 11);
		assert.ok(lines[0]!.includes("f0.ts"), "viewport must stay at the top");

		// G → back to tail.
		c.handleInput("G");
		lines = contentLines(c, 40, 11);
		assert.ok(lines.some((l) => l.includes("zzz-new.ts")));
	});

	it("reset clears all state", () => {
		const c = makeComp();
		c.addFile("a.ts", "write");
		c.reset();
		assert.equal(c.fileCount, 0);
		assert.ok(c.render(40, 8)[0]!.includes("No files modified yet"));
	});
});

// ══════════════════════════════════════════════════════════════════════════
// Edge cases
// ══════════════════════════════════════════════════════════════════════════

describe("Edge cases", () => {
	it("single file at root level", () => {
		const flat = flattenTree(buildTree(new Map([["README.md", "write"]])), 0, []);
		assert.equal(flat.length, 1);
		assert.equal(flat[0]!.node.name, "README.md");
		assert.equal(flat[0]!.node.tool, "write");
		assert.equal(flat[0]!.depth, 0);
	});

	it("deeply nested single file", () => {
		const flat = flattenTree(
			buildTree(new Map([["a/b/c/d/e/f/file.ts", "edit"]])),
			0,
			[],
		);
		assert.equal(flat.length, 7); // a,b,c,d,e,f,file.ts
		assert.equal(flat[6]!.node.name, "file.ts");
		assert.equal(flat[6]!.depth, 6);
	});

	it("files with common prefix don't collide", () => {
		const tree = buildTree(
			new Map([
				["src-tools/a.ts", "write"],
				["src/b.ts", "edit"],
			]),
		);
		assert.equal(tree.length, 2);
		assert.equal(tree[0]!.name, "src");
		assert.equal(tree[1]!.name, "src-tools");
	});

	it("all types of file extensions work", () => {
		const files = new Map([
			["config.json", "write"],
			["data.yml", "edit"],
			["script.ts", "write"],
			["style.css", "edit"],
			["readme", "write"],
		]);
		const flat = flattenTree(buildTree(files), 0, []);
		assert.equal(flat.length, files.size);
		for (const entry of flat) {
			assert.equal(entry.depth, 0);
		}
	});
});
