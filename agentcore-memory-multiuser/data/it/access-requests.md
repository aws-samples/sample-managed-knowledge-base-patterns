# AnyCompany Access Request Process

Access to internal systems is managed through SSO groups. Most access is granted automatically based on your team and role. Additional access is requested through the Access Portal.

## Requesting access

1. Open the Access Portal from your SSO dashboard.
2. Search for the application or AWS account you need.
3. Select the role and provide a business justification. Requests for production AWS accounts require your manager's approval and are time-limited to 90 days.

## AWS accounts

Engineers receive read-only access to their team's dev and staging accounts by default. Write access to prod accounts is granted only through the Access Portal with manager approval and is logged. Use `anycompany-cli aws login` to obtain temporary credentials; long-lived access keys are not permitted.

## Source code

All engineers are added to the anycompany-corp organization on the source code hosting service on day one. Write access to a repository is granted by the repository's owning team through a CODEOWNERS-based request.

## Data access

Access to customer data in the analytics warehouse requires completing the data handling training and a request approved by the data governance team. Frankfurt employees handling EU customer data must additionally complete GDPR training.

## Offboarding

All access is removed automatically when an employee's SSO account is deactivated on their last day.
