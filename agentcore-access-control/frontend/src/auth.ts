import { WebStorageStateStore } from "oidc-client-ts";
import type { AuthProviderProps } from "react-oidc-context";
import type { AppConfig } from "./config";

/** Authorization code flow with PKCE against the Cognito user pool. */
export function oidcSettings(config: AppConfig): AuthProviderProps {
	return {
		authority: `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`,
		client_id: config.userPoolClientId,
		redirect_uri: window.location.origin,
		response_type: "code",
		scope: "openid email profile",
		automaticSilentRenew: true,
		userStore: new WebStorageStateStore({ store: window.sessionStorage }),
		onSigninCallback: () => {
			window.history.replaceState({}, document.title, window.location.pathname);
		},
	};
}

/** Cognito does not publish end_session_endpoint, so build the logout URL. */
export function logoutUrl(config: AppConfig): string {
	const params = new URLSearchParams({
		client_id: config.userPoolClientId,
		logout_uri: window.location.origin,
	});
	return `${config.cognitoDomain}/logout?${params.toString()}`;
}
