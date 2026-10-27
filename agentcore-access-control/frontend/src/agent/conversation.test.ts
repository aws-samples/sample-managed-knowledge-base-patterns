import { describe, expect, it } from "vitest";
import {
	applyEvent,
	type ChatMessage,
	documentName,
	requestedUserId,
} from "./conversation";

const user: ChatMessage = { id: "1", role: "user", text: "Hi", toolCalls: [] };
const assistant: ChatMessage = {
	id: "2",
	role: "assistant",
	text: "",
	toolCalls: [],
};

describe("applyEvent", () => {
	it("appends text deltas to the assistant message", () => {
		let messages = [user, assistant];
		messages = applyEvent(messages, { type: "text", data: "Hello" });
		messages = applyEvent(messages, { type: "text", data: " there" });

		expect(messages[1].text).toBe("Hello there");
		expect(messages[0]).toBe(user);
	});

	it("tracks a tool call from use to result", () => {
		let messages = [user, assistant];
		messages = applyEvent(messages, {
			type: "tool_use",
			toolUseId: "t1",
			name: "kb___Retrieve",
			input: { userContext: { userId: "user-b@example.com" } },
		});
		expect(messages[1].toolCalls[0].status).toBe("running");

		messages = applyEvent(messages, {
			type: "tool_result",
			toolUseId: "t1",
			status: "success",
			text: "{}",
			sources: ["s3://amzn-s3-demo-bucket/documents/dept-a-plan.txt"],
		});

		expect(messages[1].toolCalls).toEqual([
			{
				toolUseId: "t1",
				name: "kb___Retrieve",
				input: { userContext: { userId: "user-b@example.com" } },
				status: "success",
				resultText: "{}",
				sources: ["s3://amzn-s3-demo-bucket/documents/dept-a-plan.txt"],
			},
		]);
	});

	it("records errors", () => {
		const messages = applyEvent([user, assistant], {
			type: "error",
			message: "failed",
		});

		expect(messages[1].error).toBe("failed");
	});

	it("ignores events when the last message is not from the assistant", () => {
		const messages = [user];

		expect(applyEvent(messages, { type: "text", data: "x" })).toBe(messages);
	});
});

describe("requestedUserId", () => {
	it("returns the userId the LLM generated", () => {
		expect(
			requestedUserId({ userContext: { userId: "user-b@example.com" } }),
		).toBe("user-b@example.com");
	});

	it.each([
		undefined,
		null,
		"x",
		{},
		{ userContext: "x" },
		{ userContext: { userId: 1 } },
	])("returns undefined for %j", (input) => {
		expect(requestedUserId(input)).toBeUndefined();
	});
});

describe("documentName", () => {
	it("returns the file name of an S3 URI", () => {
		expect(documentName("s3://amzn-s3-demo-bucket/documents/shared-notice.txt")).toBe(
			"shared-notice.txt",
		);
	});
});
