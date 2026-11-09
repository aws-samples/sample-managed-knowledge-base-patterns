import * as fs from "node:fs";
import * as path from "node:path";

/** The IAM policies that the README documents. The stack deploys these files as written. */
export const IAM_DIR = path.join(__dirname, "..", "..", "iam");

/**
 * Read a policy from iam/ and fill in its <PLACEHOLDER> values.
 *
 * Values can be CDK tokens, such as a bucket name, which CloudFormation
 * resolves at deploy time. Fails if a placeholder is left, so a policy file
 * that gains a new placeholder can't deploy half filled in.
 */
export function renderPolicy(
	fileName: string,
	values: Record<string, string>,
): Record<string, unknown> {
	let text = fs.readFileSync(path.join(IAM_DIR, fileName), "utf8");
	for (const [key, value] of Object.entries(values)) {
		text = text.split(`<${key}>`).join(value);
	}
	const left = text.match(/<[A-Z_]+>/g);
	if (left) {
		throw new Error(`${fileName} still has ${[...new Set(left)].join(", ")}`);
	}
	return JSON.parse(text) as Record<string, unknown>;
}
