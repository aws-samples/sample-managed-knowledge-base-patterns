import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";

/**
 * Local files that must not end up in assets: caches and dotfiles that
 * test runs, linters, and editors create next to the sources.
 */
export const LOCAL_ARTIFACTS = [".*", "__pycache__"];

/** Return true when an executable is available on PATH. */
function hasCommand(command: string): boolean {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Bundling for an AgentCore Runtime direct code deployment package.
 *
 * Installs the locked dependencies of a uv project as manylinux aarch64
 * wheels (the runtime is arm64 only) and copies `src/` to the package root.
 * Bundles locally when uv is installed and falls back to the uv image.
 */
export function agentCodeBundling(
	projectPath: string,
	pythonVersion: string,
): cdk.BundlingOptions {
	const install = (requirements: string, output: string): string[][] => [
		[
			"export",
			"--frozen",
			"--no-dev",
			"--no-emit-project",
			"--no-hashes",
			"--format",
			"requirements-txt",
			"--output-file",
			requirements,
		],
		[
			"pip",
			"install",
			"--python-platform",
			"aarch64-manylinux2014",
			"--python-version",
			pythonVersion,
			"--only-binary=:all:",
			"--target",
			output,
			"--requirement",
			requirements,
		],
	];

	const containerScript = [
		...install("/tmp/requirements.txt", "/asset-output").map(
			(args) => `uv ${args.join(" ")}`,
		),
		"cp -R src/. /asset-output/",
	].join(" && ");

	return {
		image: cdk.DockerImage.fromRegistry(
			`ghcr.io/astral-sh/uv:python${pythonVersion}-bookworm-slim`,
		),
		command: ["bash", "-c", containerScript],
		environment: { UV_CACHE_DIR: "/tmp/uv-cache" },
		local: {
			tryBundle(outputDir: string): boolean {
				if (!hasCommand("uv")) {
					return false;
				}
				const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
				const requirements = path.join(workDir, "requirements.txt");
				for (const args of install(requirements, outputDir)) {
					execFileSync("uv", args, { cwd: projectPath, stdio: "inherit" });
				}
				fs.cpSync(path.join(projectPath, "src"), outputDir, {
					recursive: true,
					filter: (source) => !source.includes("__pycache__"),
				});
				fs.rmSync(workDir, { recursive: true, force: true });
				return true;
			},
		},
	};
}

/**
 * Bundling for the Vite single-page app. Runs `npm ci` and `npm run build`
 * locally when npm is installed and falls back to the Node.js image.
 */
export function viteAppBundling(appPath: string): cdk.BundlingOptions {
	return {
		image: cdk.DockerImage.fromRegistry(
			"public.ecr.aws/docker/library/node:22-bookworm-slim",
		),
		command: [
			"bash",
			"-c",
			"npm ci --cache /tmp/npm-cache && npm run build && cp -R dist/. /asset-output/",
		],
		local: {
			tryBundle(outputDir: string): boolean {
				if (!hasCommand("npm")) {
					return false;
				}
				execFileSync("npm", ["ci"], { cwd: appPath, stdio: "inherit" });
				execFileSync("npm", ["run", "build"], {
					cwd: appPath,
					stdio: "inherit",
				});
				fs.cpSync(path.join(appPath, "dist"), outputDir, { recursive: true });
				return true;
			},
		},
	};
}
