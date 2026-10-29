/** Events streamed by the agent (agent/src/kb_agent/streaming.py). */
export type AgentEvent =
	| { type: "text"; data: string }
	| { type: "tool_use"; toolUseId: string; name: string; input: unknown }
	| {
			type: "tool_result";
			toolUseId: string;
			status: "success" | "error";
			text: string;
			sources: string[];
	  }
	| { type: "error"; message: string };

const TYPES = new Set(["text", "tool_use", "tool_result", "error"]);

/**
 * Incremental parser for the server-sent events of AgentCore Runtime.
 * Each event is a `data: <json>` line; chunks can split lines anywhere.
 */
export class SseParser {
	private buffer = "";

	/** Feed a chunk of the response body and return the complete events. */
	push(chunk: string): AgentEvent[] {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		return lines.flatMap(parseLine);
	}

	/** Return the event left in the buffer when the stream ends. */
	flush(): AgentEvent[] {
		const rest = this.buffer;
		this.buffer = "";
		return parseLine(rest);
	}
}

function parseLine(line: string): AgentEvent[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) {
		return [];
	}
	try {
		const event: unknown = JSON.parse(trimmed.slice("data:".length));
		if (
			typeof event === "object" &&
			event !== null &&
			TYPES.has((event as { type?: string }).type ?? "")
		) {
			return [event as AgentEvent];
		}
	} catch {
		// Ignore keep-alive and non-JSON lines.
	}
	return [];
}
