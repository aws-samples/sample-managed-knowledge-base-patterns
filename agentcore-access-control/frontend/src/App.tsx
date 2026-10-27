import Alert from "@cloudscape-design/components/alert";
import AppLayout from "@cloudscape-design/components/app-layout";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import { useAuth } from "react-oidc-context";
import { logoutUrl } from "./auth";
import { ChatView } from "./components/ChatView";
import { DefenseOverview } from "./components/DefenseOverview";
import type { AppConfig } from "./config";

const TITLE = "AnyCompany internal assistant";

export default function App({ config }: { config: AppConfig }) {
	const auth = useAuth();
	const email = auth.user?.profile.email;

	async function signOut() {
		await auth.removeUser();
		window.location.assign(logoutUrl(config));
	}

	let content;
	if (auth.isLoading) {
		content = (
			<Box textAlign="center" padding="xxl">
				<Spinner size="large" />
			</Box>
		);
	} else if (auth.error) {
		content = (
			<Alert
				type="error"
				header="Sign-in failed"
				action={
					<Button onClick={() => void auth.signinRedirect()}>Try again</Button>
				}
			>
				{auth.error.message}
			</Alert>
		);
	} else if (!auth.isAuthenticated || !email) {
		content = (
			<Container header={<Header variant="h2">Sign in</Header>}>
				<SpaceBetween size="m">
					<Box>
						Sign in as user-a@example.com or user-b@example.com. Both demo users
						share the password stored in the AWS Secrets Manager secret named in
						the DemoUserPasswordSecretArn stack output.
					</Box>
					<Button variant="primary" onClick={() => void auth.signinRedirect()}>
						Sign in
					</Button>
				</SpaceBetween>
			</Container>
		);
	} else {
		content = (
			<SpaceBetween size="l">
				<DefenseOverview />
				<ChatView config={config} email={email} />
			</SpaceBetween>
		);
	}

	return (
		<>
			<TopNavigation
				identity={{ href: "/", title: TITLE }}
				utilities={
					email
						? [
								{
									type: "menu-dropdown",
									text: email,
									iconName: "user-profile",
									items: [{ id: "sign-out", text: "Sign out" }],
									onItemClick: () => void signOut(),
								},
							]
						: []
				}
			/>
			<AppLayout
				navigationHide
				toolsHide
				content={
					<ContentLayout
						header={
							<Header
								variant="h1"
								description="Every search runs as the signed-in user, whatever arguments the agent generates."
							>
								Internal document search
							</Header>
						}
					>
						{content}
					</ContentLayout>
				}
			/>
		</>
	);
}
