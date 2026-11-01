import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import ExpandableSection from "@cloudscape-design/components/expandable-section";

const LAYERS = [
	{
		title: "Request interceptor",
		layer: "Tool layer, primary defense",
		description:
			"Overwrites userContext of every tools/call request with the email claim of your verified access token.",
	},
	{
		title: "AgentCore Policy",
		layer: "Tool layer, secondary defense",
		description:
			"A Cedar policy denies the tool call if userContext.userId still differs from the email claim of the token.",
	},
	{
		title: "ACL awareness",
		layer: "Resource layer, primary defense",
		description:
			"The knowledge base returns only documents whose access control list allows the user in userContext.",
	},
	{
		title: "Resource-based policy",
		layer: "Resource layer, secondary defense",
		description:
			"The knowledge base denies Retrieve and GetDocumentContent to every principal except the execution role of this gateway.",
	},
];

/** Summary of the four defenses that the sample deploys. */
export function DefenseOverview() {
	return (
		<ExpandableSection
			variant="container"
			headerText="How access control works"
			defaultExpanded
		>
			<ColumnLayout columns={4} variant="text-grid">
				{LAYERS.map((item) => (
					<div key={item.title}>
						<Box variant="awsui-key-label">{item.title}</Box>
						<Box variant="small" color="text-body-secondary">
							{item.layer}
						</Box>
						<Box variant="p">{item.description}</Box>
					</div>
				))}
			</ColumnLayout>
		</ExpandableSection>
	);
}
