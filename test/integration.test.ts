/**
 * pi-sidepanel-outputs integration tests
 *
 * Loads the REAL extension entry point (index.ts) against the FakePi
 * harness, covering registration, the sidepanel:ready recovery handshake
 * (the fallback this plugin was originally missing entirely), session
 * replay, and live tool events.
 *
 * Run: node --test test/integration.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
	FakePi,
	captureBusy,
	captureRegistrations,
	sessionCtx,
} from "./_harness/fake-pi.ts";

register("./_harness/stub-hooks.mjs", import.meta.url);
const extension = (await import("../index.ts")).default;

function writeCall(name: "write" | "edit", filePath: string) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name, arguments: { path: filePath } }],
		},
	};
}

describe("registration", () => {
	it("registers the files tab on session_start", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);

		await pi.fire("session_start", {}, sessionCtx());
		assert.equal(regs.length, 1);
		assert.equal(regs[0].id, "files");
		assert.equal(regs[0].label, "Outputs");
	});

	it("re-registers on sidepanel:ready (regression: the fallback was missing entirely)", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);

		await pi.fire("session_start", {}, sessionCtx());
		pi.events.emit("sidepanel:ready", {});
		assert.equal(regs.length, 2);
		assert.equal(regs[1].id, "files");
	});

	it("flags busy with a message during replay, then clears", async () => {
		const pi = new FakePi();
		const busy = captureBusy(pi);
		extension(pi as any);

		await pi.fire("session_start", {}, sessionCtx());
		assert.equal(busy.length, 2);
		assert.equal(busy[0].busy, true);
		assert.equal(busy[0].message, "replaying session…");
		assert.equal(busy[1].busy, false);
	});
});

describe("session replay", () => {
	it("rebuilds the modified-files tree from write/edit calls", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);

		const ctx = sessionCtx([
			writeCall("write", "src/new.ts"),
			writeCall("edit", "src/old.ts"),
		]);
		await pi.fire("session_start", {}, ctx);

		const lines: string[] = regs[0].component.render(50, 12);
		assert.ok(lines.some((l) => l.includes("[W] new.ts")));
		assert.ok(lines.some((l) => l.includes("[E] old.ts")));
		assert.ok(lines.some((l) => l.includes("src/")));
	});

	it("converts absolute paths to cwd-relative for display", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);

		const ctx = sessionCtx([
			writeCall("write", `${process.cwd()}/deep/abs.ts`),
		]);
		await pi.fire("session_start", {}, ctx);

		const lines: string[] = regs[0].component.render(50, 12);
		assert.ok(lines.some((l) => l.includes("deep/")));
		assert.ok(lines.some((l) => l.includes("[W] abs.ts")));
	});
});

describe("live events", () => {
	it("adds files from live write/edit tool calls; ignores other tools", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);
		await pi.fire("session_start", {}, sessionCtx());
		const comp = regs[0].component;

		await pi.fire("tool_call", { toolName: "write", input: { path: "x.ts" } });
		await pi.fire("tool_call", { toolName: "read", input: { path: "y.ts" } });

		const lines: string[] = comp.render(50, 12);
		assert.ok(lines.some((l) => l.includes("[W] x.ts")));
		assert.ok(!lines.some((l) => l.includes("y.ts")));
	});
});
