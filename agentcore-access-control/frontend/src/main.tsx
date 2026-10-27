import "@cloudscape-design/global-styles/index.css";
import Alert from "@cloudscape-design/components/alert";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "react-oidc-context";
import App from "./App";
import { oidcSettings } from "./auth";
import { loadConfig } from "./config";

const root = createRoot(document.getElementById("root") as HTMLElement);

loadConfig()
	.then((config) => {
		root.render(
			<StrictMode>
				<AuthProvider {...oidcSettings(config)}>
					<App config={config} />
				</AuthProvider>
			</StrictMode>,
		);
	})
	.catch((error: unknown) => {
		root.render(
			<Alert type="error" header="Configuration error">
				{error instanceof Error ? error.message : String(error)}
			</Alert>,
		);
	});
