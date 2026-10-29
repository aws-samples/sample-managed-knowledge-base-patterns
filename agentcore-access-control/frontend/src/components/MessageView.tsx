import Avatar from "@cloudscape-design/chat-components/avatar";
import ChatBubble from "@cloudscape-design/chat-components/chat-bubble";
import Alert from "@cloudscape-design/components/alert";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../agent/conversation";
import { ToolCallView } from "./ToolCallView";

interface MessageViewProps {
	message: ChatMessage;
	email: string;
}

export function MessageView({ message, email }: MessageViewProps) {
	if (message.role === "user") {
		return (
			<ChatBubble
				type="outgoing"
				ariaLabel={`${email} message`}
				avatar={
					<Avatar
						ariaLabel={email}
						tooltipText={email}
						initials={email.slice(0, 1).toUpperCase()}
					/>
				}
			>
				{message.text}
			</ChatBubble>
		);
	}

	const waiting =
		message.pending && !message.text && message.toolCalls.length === 0;
	return (
		<ChatBubble
			type="incoming"
			ariaLabel="Assistant message"
			showLoadingBar={message.pending}
			avatar={
				<Avatar
					ariaLabel="Assistant"
					tooltipText="Assistant"
					color="gen-ai"
					iconName="gen-ai"
					loading={message.pending}
				/>
			}
		>
			<SpaceBetween size="s">
				{waiting && "Thinking..."}
				{message.toolCalls.map((call) => (
					<ToolCallView key={call.toolUseId} call={call} email={email} />
				))}
				{message.text && (
					<Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
				)}
				{message.error && <Alert type="error">{message.error}</Alert>}
			</SpaceBetween>
		</ChatBubble>
	);
}
