import { describe, expect, it } from "vitest";
import { SseParser } from "./events";

describe("SseParser", () => {
	it("parses data lines split across chunks", () => {
		const parser = new SseParser();

		expect(parser.push('data: {"type":"text","da')).toEqual([]);
		expect(
			parser.push('ta":"Hello"}\n\ndata: {"type":"text","data":" world"}\n'),
		).toEqual([
			{ type: "text", data: "Hello" },
			{ type: "text", data: " world" },
		]);
	});

	it("returns the last event on flush", () => {
		const parser = new SseParser();
		parser.push('data: {"type":"error","message":"failed"}');

		expect(parser.flush()).toEqual([{ type: "error", message: "failed" }]);
		expect(parser.flush()).toEqual([]);
	});

	it("ignores comments, unknown events, and invalid JSON", () => {
		const parser = new SseParser();

		expect(
			parser.push(
				': keep-alive\ndata: {"type":"other"}\ndata: not json\ndata: "text"\n',
			),
		).toEqual([]);
	});
});
