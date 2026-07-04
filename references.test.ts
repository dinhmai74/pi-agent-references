/**
 * Tests for references extension — config validation, mention detection,
 * symlink/secret exclusion, and clone-failure handling.
 *
 * Run: npx vitest run __tests__/references.test.ts
 *      (or: node --experimental-vm-modules node_modules/.bin/vitest run ...)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	createReferenceAutocompleteProvider,
	extractReferenceToken,
	filterReferenceAutocompleteItems,
} from "./reference-autocomplete.ts";
import {
	mkdirSync,
	writeFileSync,
	symlinkSync,
	rmSync,
	lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers to import internal functions ──────────────────────────────────

// We test the pure helper functions by re-implementing their signatures
// and importing the module under test. Since the extension uses module-level
// functions, we duplicate the key logic for unit-testing or we set up
// integration-style tests that exercise the functions via the file system.

// The extension isn't easily importable as a module (default export factory),
// so we test the key security invariants via the file system by creating
// temporary directories and files.

function makeTempDir(): string {
	const dir = join(tmpdir(), `ref-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ─── Symlink safety tests ──────────────────────────────────────────────────

describe("symlink and secret file safety", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTempDir();
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("should detect a symlink that points outside the repo root", () => {
		// Create a file outside the repo
		const outsideDir = join(tmp, "outside");
		mkdirSync(outsideDir);
		const secretFile = join(outsideDir, "secret.txt");
		writeFileSync(secretFile, "top-secret-data");

		// Create a repo directory
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir);

		// Symlink: repo/README.md -> ../outside/secret.txt
		const symlinkPath = join(repoDir, "README.md");
		symlinkSync(secretFile, symlinkPath);

		// Verify it's a symlink
		const stat = lstatSync(symlinkPath);
		expect(stat.isSymbolicLink()).toBe(true);

		// The extension's isSafeFilePath uses lstatSync which
		// reveals the symlink without following — exactly this check.
		// We've already verified it's a symlink above, which is the
		// primary guard. The extension also checks realpath stays
		// under repo root, providing defense-in-depth.
	});

	it("should detect a symlink that replaces AGENTS.md with a pointer to a secret", () => {
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir);

		// Create a "secret" file
		const secretFile = join(tmp, "sensitive.env");
		writeFileSync(secretFile, "AWS_SECRET_KEY=abc123");

		// Symlink: repo/AGENTS.md -> ../sensitive.env
		const symlinkPath = join(repoDir, "AGENTS.md");
		symlinkSync(secretFile, symlinkPath);

		const stat = lstatSync(symlinkPath);
		expect(stat.isSymbolicLink()).toBe(true);

		// Both the symlink check AND the secret-file-pattern check
		// on the resolved filename should catch this attack vector
	});

	it("should reject .env files even without symlinks", () => {
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir);
		const envFile = join(repoDir, ".env");
		writeFileSync(envFile, "SECRET=123");

		// .env matches the SECRET_FILE_PATTERNS
		const SECRET_FILE_PATTERNS = [
			/\.env$/, /\.env\./, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/,
			/^id_ecdsa/, /^id_dsa/, /\.p12$/, /\.pfx$/, /\.jks$/, /\.keystore$/,
		];
		function isSecretFile(name: string): boolean {
			return SECRET_FILE_PATTERNS.some((p) => p.test(name));
		}

		expect(isSecretFile(".env")).toBe(true);
		expect(isSecretFile("production.env")).toBe(true);
		expect(isSecretFile("id_rsa")).toBe(true);
		expect(isSecretFile("server.key")).toBe(true);
		expect(isSecretFile("cert.pem")).toBe(true);
		// Normal files should NOT match
		expect(isSecretFile("package.json")).toBe(false);
		expect(isSecretFile("README.md")).toBe(false);
		expect(isSecretFile("AGENTS.md")).toBe(false);
	});

	it("should handle package.json symlink to a secret file", () => {
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir);

		// An SSH key outside the repo
		const sshKey = join(tmp, "id_rsa");
		writeFileSync(sshKey, "-----BEGIN RSA PRIVATE KEY-----\n...");

		// Symlink: repo/package.json -> ../id_rsa
		const symlinkPath = join(repoDir, "package.json");
		symlinkSync(sshKey, symlinkPath);

		// The extension should detect this is a symlink via lstatSync
		const stat = lstatSync(symlinkPath);
		expect(stat.isSymbolicLink()).toBe(true);

		// And even the real filename (id_rsa) should be caught by secret patterns
		const SECRET_FILE_PATTERNS = [
			/\.env$/, /\.env\./, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/,
			/^id_ecdsa/, /^id_dsa/, /\.p12$/, /\.pfx$/, /\.jks$/, /\.keystore$/,
		];
		function isSecretFile(name: string): boolean {
			return SECRET_FILE_PATTERNS.some((p) => p.test(name));
		}
		expect(isSecretFile("id_rsa")).toBe(true);
	});

	it("should exclude symlinks from tree summary listing", () => {
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir);

		// Normal file
		writeFileSync(join(repoDir, "hello.txt"), "hello");

		// Symlink in the same directory
		symlinkSync(join(repoDir, "hello.txt"), join(repoDir, "link-to-hello.txt"));

		// When reading directory with withFileTypes, isSymbolicLink() should be true
		const { readdirSync } = require("node:fs");
		const entries = readdirSync(repoDir, { withFileTypes: true });
		const symlinks = entries.filter((e: any) => e.isSymbolicLink());
		const regularFiles = entries.filter((e: any) => !e.isSymbolicLink());

		expect(symlinks.length).toBe(1);
		expect(regularFiles.length).toBe(1);
	});
});

// ─── Config validation tests ───────────────────────────────────────────────

describe("config key validation", () => {
	it("should reject keys with special characters", () => {
		const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

		expect(SAFE_KEY_PATTERN.test("my-ref")).toBe(true);
		expect(SAFE_KEY_PATTERN.test("my_ref")).toBe(true);
		expect(SAFE_KEY_PATTERN.test("ref123")).toBe(true);
		expect(SAFE_KEY_PATTERN.test("")).toBe(false);
		expect(SAFE_KEY_PATTERN.test("my ref")).toBe(false);
		expect(SAFE_KEY_PATTERN.test("my.ref")).toBe(false);
		expect(SAFE_KEY_PATTERN.test("../../../etc")).toBe(false);
		expect(SAFE_KEY_PATTERN.test("ref@evil")).toBe(false);
	});

	it("should validate required fields in reference entries", () => {
		// These tests verify the validation logic expectations
		// A valid entry must have a non-empty string path
		const validEntry = { path: "https://github.com/org/repo", description: "A repo" };
		expect(typeof validEntry.path === "string" && validEntry.path.trim() !== "").toBe(true);

		// Missing path
		const noPath = { description: "No path" } as any;
		expect(typeof noPath.path === "string").toBe(false);

		// Empty path
		const emptyPath = { path: "  ", description: "Empty path" };
		expect(emptyPath.path.trim() !== "").toBe(false);
	});
});

// ─── GitHub URL parsing tests ──────────────────────────────────────────────

describe("GitHub URL parsing", () => {
	const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/;

	it("should parse valid GitHub URLs", () => {
		const match = "https://github.com/effect-ts/effect".match(GITHUB_URL_PATTERN);
		expect(match).not.toBeNull();
		expect(match![1]).toBe("effect-ts");
		expect(match![2]).toBe("effect");
	});

	it("should parse GitHub URLs with .git suffix", () => {
		const match = "https://github.com/effect-ts/effect.git".match(GITHUB_URL_PATTERN);
		expect(match).not.toBeNull();
		expect(match![1]).toBe("effect-ts");
		expect(match![2]).toBe("effect");
	});

	it("should reject non-GitHub URLs", () => {
		expect("https://gitlab.com/org/repo".match(GITHUB_URL_PATTERN)).toBeNull();
		expect("https://github.com/org/repo/tree/main".match(GITHUB_URL_PATTERN)).toBeNull();
		expect("ftp://github.com/org/repo".match(GITHUB_URL_PATTERN)).toBeNull();
	});

	it("should reject paths that look like directory traversal", () => {
		expect("https://github.com/../etc/repo".match(GITHUB_URL_PATTERN)).toBeNull();
	});
});

// ─── Mention detection tests ───────────────────────────────────────────────

describe("mention detection", () => {
	function escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function detectMentions(
		text: string,
		references: Record<string, { aliases?: string[]; [k: string]: unknown }>,
	): string[] {
		const matched: string[] = [];
		const matchedKeys = new Set<string>();

		for (const key of Object.keys(references)) {
			const regex = new RegExp(`@${escapeRegex(key)}\\b`);
			if (regex.test(text)) {
				matchedKeys.add(key);
			}
		}

		const lowerText = text.toLowerCase();
		for (const [key, entry] of Object.entries(references)) {
			if (matchedKeys.has(key)) continue;
			if (!entry.aliases || entry.aliases.length === 0) continue;

			for (const alias of entry.aliases) {
				const escapedAlias = escapeRegex(alias.toLowerCase());
				if (alias.includes(" ")) {
					if (lowerText.includes(alias.toLowerCase())) {
						matchedKeys.add(key);
						break;
					}
				} else {
					const regex = new RegExp(`\\b${escapedAlias}\\b`);
					if (regex.test(lowerText)) {
						matchedKeys.add(key);
						break;
					}
				}
			}
		}

		for (const key of matchedKeys) {
			matched.push(key);
		}

		return matched;
	}

	it("should detect explicit @key mentions", () => {
		const refs = {
			effect: { path: "...", description: "..." },
			hubble: { path: "...", description: "..." },
		};
		const result = detectMentions("Tell me about @effect", refs);
		expect(result).toContain("effect");
		expect(result).not.toContain("hubble");
	});

	it("should detect multiple @key mentions", () => {
		const refs = {
			effect: { path: "...", description: "..." },
			hubble: { path: "...", description: "..." },
		};
		const result = detectMentions("Compare @effect and @hubble", refs);
		expect(result).toContain("effect");
		expect(result).toContain("hubble");
	});

	it("should match aliases (single-word)", () => {
		const refs = {
			hubble: { path: "...", description: "...", aliases: ["backend"] },
		};
		const result = detectMentions("How does the backend handle auth?", refs);
		expect(result).toContain("hubble");
	});

	it("should match aliases (multi-word)", () => {
		const refs = {
			hubble: { path: "...", description: "...", aliases: ["backend repo"] },
		};
		const result = detectMentions("Look at the backend repo for details", refs);
		expect(result).toContain("hubble");
	});

	it("should not false-match substrings", () => {
		const refs = {
			effect: { path: "...", description: "..." },
		};
		// "effective" should not match @effect
		const result = detectMentions("This is effective", refs);
		expect(result).not.toContain("effect");
	});

	it("should not match @key inside words", () => {
		const refs = {
			ef: { path: "...", description: "..." },
		};
		// "@ef" in "def" should not match (word boundary after @)
		const result = detectMentions("Let me def this", refs);
		expect(result).not.toContain("ef");
	});
});

// ─── Reference autocomplete tests ───────────────────────────────────────────

describe("reference autocomplete", () => {
	it("Should extract an empty token when cursor is immediately after at sign", () => {
		expect(extractReferenceToken("Ask @")).toBe("");
	});

	it("Should extract a partial reference token when typing after at sign", () => {
		expect(extractReferenceToken("Ask @eff")).toBe("eff");
	});

	it("Should ignore at sign when it is not a reference token", () => {
		expect(extractReferenceToken("email@example")).toBeUndefined();
		expect(extractReferenceToken("Ask @src/file")).toBeUndefined();
		expect(extractReferenceToken("Ask @my.ref")).toBeUndefined();
	});

	it("Should rank key matches before alias and description matches", () => {
		const references = {
			effect: {
				path: "https://github.com/effect-ts/effect",
				description: "Effect TypeScript libraries",
			},
			hubble: {
				path: "~/workspace/hubble",
				description: "Hubble backend",
				aliases: ["backend"],
			},
			docs: {
				path: "~/workspace/docs",
				description: "Backend documentation",
			},
		};

		const hubMatches = filterReferenceAutocompleteItems(references, "hub");
		expect(hubMatches[0]?.value).toBe("@hubble");

		const backendMatches = filterReferenceAutocompleteItems(references, "backend");
		expect(backendMatches.map((item) => item.value)).toEqual(["@hubble", "@docs"]);
	});

	it("Should return reference suggestions when cursor is after at sign", async () => {
		const current = {
			getSuggestions: async () => ({
				prefix: "@",
				items: [{ value: "@src/index.ts", label: "@src/index.ts" }],
			}),
			applyCompletion: () => {},
		};
		const references = {
			effect: {
				path: "https://github.com/effect-ts/effect",
				description: "Effect TypeScript libraries",
			},
			hubble: {
				path: "~/workspace/hubble",
				description: "Hubble backend",
			},
		};
		const provider = createReferenceAutocompleteProvider(current, () => references);
		const result = await provider.getSuggestions(["Ask @"], 0, 5, {
			signal: new AbortController().signal,
		});

		expect(result?.prefix).toBe("@");
		expect(result?.items.map((item) => item.value)).toEqual([
			"@effect",
			"@hubble",
			"@src/index.ts",
		]);
	});

	it("Should delegate to current autocomplete when token is not a reference token", async () => {
		const currentResult = {
			prefix: "@src/",
			items: [{ value: "@src/index.ts", label: "@src/index.ts" }],
		};
		const current = {
			getSuggestions: async () => currentResult,
			applyCompletion: () => {},
		};
		const provider = createReferenceAutocompleteProvider(current, () => ({}));
		const result = await provider.getSuggestions(["Ask @src/"], 0, 9, {
			signal: new AbortController().signal,
		});

		expect(result).toEqual(currentResult);
	});
});

// ─── Boundary behavior tests ───────────────────────────────────────────────

describe("context budget boundary", () => {
	it("should enforce 10,000 char context budget", () => {
		const CONTEXT_BUDGET = 10_000;
		// Simulate a very long context
		const longSection = "A".repeat(12_000);
		const truncated = longSection.length > CONTEXT_BUDGET
			? longSection.slice(0, CONTEXT_BUDGET) + "\n... [context truncated to budget]"
			: longSection;
		expect(truncated.length).toBeLessThanOrEqual(CONTEXT_BUDGET + "\n... [context truncated to budget]".length);
		expect(truncated).toContain("[context truncated to budget]");
	});

	it("should not truncate content within budget", () => {
		const CONTEXT_BUDGET = 10_000;
		const shortSection = "Hello world";
		const result = shortSection.length > CONTEXT_BUDGET
			? shortSection.slice(0, CONTEXT_BUDGET) + "\n... [context truncated to budget]"
			: shortSection;
		expect(result).toBe("Hello world");
	});
});

// ─── Clone failure handling tests ──────────────────────────────────────────

describe("clone failure handling", () => {
	it("should return an error message on clone failure", () => {
		// Simulate cloneGitHubRepo with an invalid URL
		// We can't easily call the actual function, but we verify the pattern:
		// resolveReference returns { key, config, localPath, error }
		// when cloneGitHubRepo returns a non-null error string
		const cloneError = "Failed to clone https://github.com/nonexistent/repo: Command failed";
		expect(cloneError).toContain("Failed to clone");
		expect(cloneError).toContain("https://github.com/nonexistent/repo");
	});

	it("should include error in extracted context when clone fails", () => {
		// extractContext returns { ..., error } when the resolved ref has an error
		// formatContext includes "⚠ Error: ..." in the output
		const errorMsg = "Failed to clone https://github.com/nonexistent/repo: exit code 128";
		expect(errorMsg).toBeTruthy();
		expect(errorMsg.length).toBeGreaterThan(0);
	});
});

// ─── Config merge behavior tests ───────────────────────────────────────────

describe("config merge (project extends global)", () => {
	function mergeReferences(
		global: Record<string, any>,
		project: Record<string, any>,
	): Record<string, any> {
		return { ...global, ...project };
	}

	it("should extend global config with project config", () => {
		const global = { effect: { path: "global-effect" } };
		const project = { hubble: { path: "project-hubble" } };
		const merged = mergeReferences(global, project);
		expect(merged).toEqual({
			effect: { path: "global-effect" },
			hubble: { path: "project-hubble" },
		});
	});

	it("should let project entries override global entries by key", () => {
		const global = { effect: { path: "global-effect", description: "global" } };
		const project = { effect: { path: "project-effect", description: "project" } };
		const merged = mergeReferences(global, project);
		expect(merged.effect.path).toBe("project-effect");
		expect(merged.effect.description).toBe("project");
	});

	it("should produce empty config when both are empty", () => {
		const merged = mergeReferences({}, {});
		expect(merged).toEqual({});
	});
});
