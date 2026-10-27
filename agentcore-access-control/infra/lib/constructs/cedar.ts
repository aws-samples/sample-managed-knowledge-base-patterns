/**
 * Cedar policy that permits a knowledge base tool call only when the
 * (post-interception) userContext.userId equals the email claim of the JWT
 * that the gateway authorizer verified. The expected value comes from the
 * token and the actual value from the request body, so the policy detects
 * an interceptor that did not overwrite userContext or wrote a wrong value.
 */
export function userContextMatchesEmailClaim(
	action: string,
	gatewayArn: string,
): string {
	return `permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"${action}",
  resource == AgentCore::Gateway::"${gatewayArn}"
) when {
  principal.hasTag("email") &&
  context has input && context.input has userContext &&
  context.input.userContext has userId &&
  context.input.userContext.userId == principal.getTag("email")
};`;
}
