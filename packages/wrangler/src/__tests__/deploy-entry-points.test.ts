/* eslint-disable @typescript-eslint/no-empty-object-type */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { ParseError, findWranglerConfig } from "@cloudflare/workers-utils";
import {
	normalizeString,
	writeWranglerConfig,
} from "@cloudflare/workers-utils/test-helpers";
import { sync } from "command-exists";
import * as esbuild from "esbuild";
import { http, HttpResponse } from "msw";
import dedent from "ts-dedent";
/* eslint-disable workers-sdk/no-vitest-import-expect -- large file with .each and custom matchers */
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
/* eslint-enable workers-sdk/no-vitest-import-expect */
import { getInstalledPackageVersion } from "../autoconfig/frameworks/utils/packages";
import { printBundleSize } from "../deployment-bundle/bundle-reporter";
import { clearOutputFilePath } from "../output";
import { NpmPackageManager } from "../package-manager";
import { fetchSecrets } from "../utils/fetch-secrets";
import { diagnoseScriptSizeError } from "../utils/friendly-validator-errors";
import {
	mockAUSRequest,
	mockDeploymentsListRequest,
	mockLastDeploymentRequest,
	mockPatchScriptSettings,
	mockUploadAssetsToKVRequest,
	writeAssets,
} from "./deploy-test-utils";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import { mockConsoleMethods } from "./helpers/mock-console";
import { clearDialogs, mockConfirm, mockPrompt } from "./helpers/mock-dialogs";
import { useMockIsTTY } from "./helpers/mock-istty";
import {
	mockKeyListRequest,
	mockListKVNamespacesRequest,
} from "./helpers/mock-kv";
import { mockUploadWorkerRequest } from "./helpers/mock-upload-worker";
import { mockGetSettings } from "./helpers/mock-worker-settings";
import { mockSubDomainRequest } from "./helpers/mock-workers-subdomain";
import { createFetchResult, msw } from "./helpers/msw";
import { mswListNewDeploymentsLatestFull } from "./helpers/msw/handlers/versions";
import { runInTempDir } from "./helpers/run-in-tmp";
import { runWrangler } from "./helpers/run-wrangler";
import { writeWorkerSource } from "./helpers/write-worker-source";
import type { AssetManifest } from "../assets";
import type { Mock } from "vitest";

vi.mock("command-exists");
vi.mock("../check/commands", async (importOriginal) => {
	return {
		...(await importOriginal()),
		analyseBundle() {
			return `{}`;
		},
	};
});
vi.mock("../utils/fetch-secrets");
vi.mock("../package-manager", async (importOriginal) => ({
	...(await importOriginal()),
	sniffUserAgent: () => "npm",
	getPackageManager() {
		return {
			type: "npm",
			npx: "npx",
		};
	},
}));
vi.mock("../autoconfig/details");
vi.mock("../autoconfig/run");
vi.mock("../autoconfig/frameworks");
vi.mock("../autoconfig/frameworks/utils/packages");
vi.mock("../autoconfig/c3-vendor/command");

describe("deploy", () => {
	mockAccountId();
	mockApiToken();
	runInTempDir();
	const { setIsTTY } = useMockIsTTY();
	const std = mockConsoleMethods();

	beforeEach(() => {
		vi.stubGlobal("setTimeout", (fn: () => void) => {
			setImmediate(fn);
		});
		setIsTTY(true);
		mockLastDeploymentRequest();
		mockDeploymentsListRequest();
		mockPatchScriptSettings();
		mockGetSettings();
		msw.use(...mswListNewDeploymentsLatestFull);
		msw.use(
			http.get("*/accounts/:accountId/r2/buckets/:bucketName", async () => {
				return HttpResponse.json(createFetchResult({}));
			})
		);
		vi.mocked(fetchSecrets).mockResolvedValue([]);
		vi.mocked(getInstalledPackageVersion).mockReturnValue(undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		clearDialogs();
		clearOutputFilePath();
	});

	describe("entry-points", () => {
		it("should be able to use `index` with no extension as the entry-point (esm)", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockUploadWorkerRequest({ expectedType: "esm" });
			mockSubDomainRequest();

			await runWrangler("deploy ./index");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should be able to use `index` with no extension as the entry-point (sw)", async () => {
			writeWranglerConfig();
			writeWorkerSource({ type: "sw" });
			mockUploadWorkerRequest({
				expectedType: "sw",
				useOldUploadApi: true,
			});
			mockSubDomainRequest();

			await runWrangler("deploy ./index");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should be able to use the `main` config as the entry-point for ESM sources", async () => {
			writeWranglerConfig({ main: "./index.js" });
			writeWorkerSource();
			mockUploadWorkerRequest();
			mockSubDomainRequest();

			await runWrangler("deploy");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should use `main` relative to the wrangler.toml not cwd", async () => {
			writeWranglerConfig({
				main: "./foo/index.js",
			});
			writeWorkerSource({ basePath: "foo" });
			mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
			mockSubDomainRequest();
			process.chdir("foo");
			await runWrangler("deploy");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should be able to transpile TypeScript (esm)", async () => {
			writeWranglerConfig();
			writeWorkerSource({ format: "ts" });
			mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
			mockSubDomainRequest();
			await runWrangler("deploy index.ts");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should be able to transpile TypeScript (sw)", async () => {
			writeWranglerConfig();
			writeWorkerSource({ format: "ts", type: "sw" });
			mockUploadWorkerRequest({
				expectedEntry: "var foo = 100;",
				expectedType: "sw",
				useOldUploadApi: true,
			});
			mockSubDomainRequest();
			await runWrangler("deploy index.ts");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should add referenced text modules into the form upload", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"./index.js",
				`
import txt from './textfile.txt';
export default{
  fetch(){
    return new Response(txt);
  }
}
`
			);
			fs.writeFileSync("./textfile.txt", "Hello, World!");
			mockUploadWorkerRequest({
				expectedModules: {
					"./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt":
						"Hello, World!",
				},
			});
			mockSubDomainRequest();
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should allow cloudflare module import", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"./index.js",
				`
import { EmailMessage } from "cloudflare:email";
export default{
  fetch(){
    return new Response("all done");
  }
}
`
			);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should be able to transpile entry-points in sub-directories (esm)", async () => {
			writeWranglerConfig();
			writeWorkerSource({ basePath: "./src" });
			mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
			mockSubDomainRequest();

			await runWrangler("deploy ./src/index.js");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should not trigger autoconfig on `wrangler deploy <script>` when called with `--x-autoconfig`", async () => {
			vi.mock(import("../autoconfig/details"), { spy: true });
			vi.mock(import("../autoconfig/run"), { spy: true });

			const getDetailsForAutoConfigSpy = (await import("../autoconfig/details"))
				.getDetailsForAutoConfig;

			const runAutoConfigSpy = (await import("../autoconfig/run"))
				.runAutoConfig;

			writeWranglerConfig();
			writeWorkerSource({ basePath: "./src" });
			mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
			mockSubDomainRequest();

			await runWrangler("deploy ./src/index.js --x-autoconfig");

			expect(getDetailsForAutoConfigSpy).not.toHaveBeenCalled();
			expect(runAutoConfigSpy).not.toHaveBeenCalled();
		});

		it("should preserve exports on a module format worker", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"index.js",
				`
export const abc = 123;
export const def = "show me the money";
export default {};`
			);

			await runWrangler("deploy index.js --dry-run --outdir out");

			expect(
				(
					await esbuild.build({
						entryPoints: [path.resolve("./out/index.js")],
						metafile: true,
						write: false,
					})
				).metafile?.outputs["index.js"].exports
			).toMatchInlineSnapshot(`
				[
				  "abc",
				  "def",
				  "default",
				]
			`);

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				No bindings found.
				--dry-run: exiting now.",
				  "warn": "",
				}
			`);
		});

		it("should not preserve exports on a service-worker format worker", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"index.js",
				`
export const abc = 123;
export const def = "show me the money";
addEventListener('fetch', event => {});`
			);

			await runWrangler("deploy index.js --dry-run --outdir out");

			expect(
				(
					await esbuild.build({
						entryPoints: [path.resolve("./out/index.js")],
						metafile: true,
						write: false,
					})
				).metafile?.outputs["index.js"].exports
			).toMatchInlineSnapshot(`[]`);

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				No bindings found.
				--dry-run: exiting now.",
				  "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mThe entrypoint index.js has exports like an ES Module, but hasn't defined a default export like a module worker normally would. Building the worker using "service-worker" format...[0m

				",
				}
			`);
		});

		it("should be able to transpile entry-points in sub-directories (sw)", async () => {
			writeWranglerConfig();
			writeWorkerSource({ basePath: "./src", type: "sw" });
			mockUploadWorkerRequest({
				expectedEntry: "var foo = 100;",
				expectedType: "sw",
				useOldUploadApi: true,
			});
			mockSubDomainRequest();

			await runWrangler("deploy ./src/index.js");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it('should error if a site definition doesn\'t have a "bucket" field', async () => {
			writeWranglerConfig({
				// @ts-expect-error we're intentionally setting an invalid config
				site: {},
			});
			writeWorkerSource();
			mockUploadWorkerRequest();
			mockSubDomainRequest();

			await expect(runWrangler("deploy ./index.js")).rejects
				.toThrowErrorMatchingInlineSnapshot(`
				[Error: Processing wrangler.toml configuration:
				  - "site.bucket" is a required field.]
			`);

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				"
			`);
			expect(std.err).toMatchInlineSnapshot(`
				"[31mX [41;31m[[41;97mERROR[41;31m][0m [1mProcessing wrangler.toml configuration:[0m

				    - "site.bucket" is a required field.

				"
			`);
			expect(normalizeString(std.warn)).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:[0m

				    - Because you've defined a [site] configuration, we're defaulting to "workers-site" for the
				  deprecated \`site.entry-point\`field.
				      Add the top level \`main\` field to your configuration file:
				      \`\`\`
				      main = "workers-site/index.js"
				      \`\`\`

				"
			`);
		});

		it("should warn if there is a `site.entry-point` configuration", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};

			writeWranglerConfig({
				site: {
					"entry-point": "./index.js",
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);
			await runWrangler("deploy ./index.js");

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "Fetching list of already uploaded assets...
				Building list of assets to upload...
				 + file-1.2ca234f380.txt (uploading new version of file-1.txt)
				 + file-2.5938485188.txt (uploading new version of file-2.txt)
				Uploading 2 new assets...
				Uploaded 100% [2 out of 2]",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				↗️  Done syncing assets
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:[0m

				    - [1mDeprecation[0m: "site.entry-point":
				      Delete the \`site.entry-point\` field, then add the top level \`main\` field to your configuration
				  file:
				      \`\`\`
				      main = "index.js"
				      \`\`\`

				",
				}
			`);
		});

		it("should resolve site.entry-point relative to wrangler.toml", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			fs.mkdirSync("my-site");
			process.chdir("my-site");
			writeWranglerConfig({
				site: {
					bucket: "assets",
					"entry-point": "my-entry",
				},
			});
			fs.mkdirSync("my-entry");
			fs.writeFileSync("my-entry/index.js", "export default {}");
			writeAssets(assets);
			process.chdir("..");
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);
			await runWrangler("deploy --config ./my-site/wrangler.toml");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-1.2ca234f380.txt (uploading new version of file-1.txt)
			 + file-2.5938485188.txt (uploading new version of file-2.txt)
			Uploading 2 new assets...
			Uploaded 100% [2 out of 2]"
		`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				↗️  Done syncing assets
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(normalizeString(std.warn)).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing my-site/wrangler.toml configuration:[0m

				    - [1mDeprecation[0m: "site.entry-point":
				      Delete the \`site.entry-point\` field, then add the top level \`main\` field to your configuration
				  file:
				      \`\`\`
				      main = "my-entry/index.js"
				      \`\`\`

				"
			`);
		});

		it("should error if both main and site.entry-point are specified", async () => {
			writeWranglerConfig({
				main: "some-entry",
				site: {
					bucket: "some-bucket",
					"entry-point": "./index.js",
				},
			});

			await expect(runWrangler("deploy")).rejects
				.toThrowErrorMatchingInlineSnapshot(`
				[Error: Processing wrangler.toml configuration:
				  - Don't define both the \`main\` and \`site.entry-point\` fields in your configuration.
				    They serve the same purpose: to point to the entry-point of your worker.
				    Delete the deprecated \`site.entry-point\` field from your config.]
			`);
		});

		it("should error if there is no entry-point specified", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			await expect(
				runWrangler("deploy")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`
				[Error: Missing entry-point to Worker script or to assets directory

				If there is code to deploy, you can either:
				- Specify an entry-point to your Worker script via the command line (ex: \`npx wrangler deploy src/index.ts\`)
				- Or add the following to your "wrangler.toml" file:

				\`\`\`
				main = "src/index.ts"

				\`\`\`


				If are uploading a directory of assets, you can either:
				- Specify the path to the directory of assets via the command line: (ex: \`npx wrangler deploy --assets=./dist\`)
				- Or add the following to your "wrangler.toml" file:

				\`\`\`
				[assets]
				directory = "./dist"

				\`\`\`
				]
			`
			);

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				"
			`);
			expect(std.err).toMatchInlineSnapshot(`
				"[31mX [41;31m[[41;97mERROR[41;31m][0m [1mMissing entry-point to Worker script or to assets directory[0m


				  If there is code to deploy, you can either:
				  - Specify an entry-point to your Worker script via the command line (ex: \`npx wrangler deploy
				  src/index.ts\`)
				  - Or add the following to your "wrangler.toml" file:

				  \`\`\`
				  main = "src/index.ts"

				  \`\`\`


				  If are uploading a directory of assets, you can either:
				  - Specify the path to the directory of assets via the command line: (ex: \`npx wrangler deploy
				  --assets=./dist\`)
				  - Or add the following to your "wrangler.toml" file:

				  \`\`\`
				  [assets]
				  directory = "./dist"

				  \`\`\`


				"
			`);
		});

		describe("should source map validation errors", () => {
			function mockDeployWithValidationError(message: string) {
				const handler = http.post(
					"*/accounts/:accountId/workers/scripts/:scriptName/versions",
					async () => {
						const body = createFetchResult(null, false, [
							{ code: 10021, message },
						]);
						return HttpResponse.json(body);
					}
				);
				msw.use(handler);
			}

			it("with TypeScript source file", async () => {
				writeWranglerConfig();
				fs.writeFileSync(
					`index.ts`,
					dedent`interface Env {
						THING: string;
					}
					x;
					export default {
						fetch() {
							return new Response("body");
						}
					}`
				);
				mockDeployWithValidationError(
					"Uncaught ReferenceError: x is not defined\n  at index.js:2:1\n"
				);
				mockSubDomainRequest();

				await expect(runWrangler("deploy ./index.ts")).rejects.toMatchObject({
					notes: [{ text: expect.stringContaining("index.ts:4:1") }, {}],
				});
			});

			it("with additional modules", async () => {
				writeWranglerConfig({
					no_bundle: true,
					rules: [{ type: "ESModule", globs: ["**/*.js"] }],
				});

				fs.writeFileSync(
					"dep.ts",
					dedent`interface Env {
					}
					y;
					export default "message";`
				);
				await esbuild.build({
					bundle: true,
					format: "esm",
					entryPoints: [path.resolve("dep.ts")],
					outdir: process.cwd(),
					sourcemap: true,
				});

				fs.writeFileSync(
					"index.js",
					dedent`import dep from "./dep.js";
					export default {
						fetch() {
							return new Response(dep);
						}
					}`
				);

				mockDeployWithValidationError(
					"Uncaught ReferenceError: y is not defined\n  at dep.js:2:1\n"
				);
				mockSubDomainRequest();

				await expect(runWrangler("deploy ./index.js")).rejects.toMatchObject({
					notes: [{ text: expect.stringContaining("dep.ts:3:1") }, {}],
				});
			});

			it("with inline source map", async () => {
				writeWranglerConfig({
					no_bundle: true,
				});

				fs.writeFileSync(
					"index.ts",
					dedent`interface Env {}
					z;
					export default {
						fetch() {
							return new Response("body");
						}
					}`
				);
				await esbuild.build({
					bundle: true,
					format: "esm",
					entryPoints: [path.resolve("index.ts")],
					outdir: process.cwd(),
					sourcemap: "inline",
				});

				mockDeployWithValidationError(
					"Uncaught ReferenceError: z is not defined\n  at index.js:2:1\n"
				);
				mockSubDomainRequest();

				await expect(runWrangler("deploy ./index.js")).rejects.toMatchObject({
					notes: [{ text: expect.stringContaining("index.ts:2:1") }, {}],
				});
			});
		});

		describe("should interactively handle misconfigured asset-only deployments", () => {
			beforeEach(() => {
				setIsTTY(true);

				// Mock the date to ensure consistent compatibility_date
				vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

				// so that we can test that the name prompt defaults to the directory name
				fs.mkdirSync("my-site");
				process.chdir("my-site");
				const assets = [
					{ filePath: "index.html", content: "<html>test</html>" },
				];
				writeAssets(assets);
				expect(findWranglerConfig().configPath).toBe(undefined);
				mockSubDomainRequest();
				mockUploadWorkerRequest({
					expectedAssets: {
						jwt: "<<aus-completion-token>>",
						config: {},
					},
					expectedType: "none",
				});
			});
			afterEach(() => {
				setIsTTY(false);
				vi.useRealTimers();
			});

			// TODO: remove this test once autoconfig goes GA and its experimental opt-in flag is removed
			it("should handle `wrangler deploy <directory>`", async () => {
				mockConfirm({
					text: "It looks like you are trying to deploy a directory of static assets only. Is this correct?",
					result: true,
				});
				mockPrompt({
					text: "What do you want to name your project?",
					options: { defaultValue: "my-site" },
					result: "test-name",
				});
				mockConfirm({
					text: "Do you want Wrangler to write a wrangler.json config file to store this configuration?\nThis will allow you to simply run `wrangler deploy` on future deployments.",
					result: true,
				});

				const bodies: AssetManifest[] = [];
				await mockAUSRequest(bodies);

				await runWrangler("deploy ./assets");
				expect(bodies.length).toBe(1);
				expect(bodies[0]).toEqual({
					manifest: {
						"/index.html": {
							hash: "8308ce789f3d08668ce87176838d59d0",
							size: 17,
						},
					},
				});
				expect(fs.readFileSync("wrangler.jsonc", "utf-8"))
					.toMatchInlineSnapshot(`
						"{
						  "name": "test-name",
						  "compatibility_date": "2024-01-01",
						  "assets": {
						    "directory": "./assets"
						  }
						}"
					`);
				expect(std.out).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────



					No compatibility date found Defaulting to today: 2024-01-01

					Wrote
					{
					  "name": "test-name",
					  "compatibility_date": "2024-01-01",
					  "assets": {
					    "directory": "./assets"
					  }
					}
					 to <cwd>/wrangler.jsonc.
					Please run \`wrangler deploy\` instead of \`wrangler deploy ./assets\` next time. Wrangler will automatically use the configuration saved to wrangler.jsonc.

					Proceeding with deployment...

					Total Upload: xx KiB / gzip: xx KiB
					Worker Startup Time: 100 ms
					Uploaded test-name (TIMINGS)
					Deployed test-name triggers (TIMINGS)
					  https://test-name.test-sub-domain.workers.dev
					Current Version ID: Galaxy-Class"
				`);
			});

			it("should handle interactive `wrangler deploy <directory>` flows without triggering autoconfig when called with `--x-autoconfig`", async () => {
				vi.mock(import("../autoconfig/details"), { spy: true });
				vi.mock(import("../autoconfig/run"), { spy: true });

				const getDetailsForAutoConfigSpy = (
					await import("../autoconfig/details")
				).getDetailsForAutoConfig;

				const runAutoConfigSpy = (await import("../autoconfig/run"))
					.runAutoConfig;

				mockConfirm({
					text: "It looks like you are trying to deploy a directory of static assets only. Is this correct?",
					result: true,
				});
				mockPrompt({
					text: "What do you want to name your project?",
					options: { defaultValue: "my-site" },
					result: "test-name",
				});
				mockConfirm({
					text: "Do you want Wrangler to write a wrangler.json config file to store this configuration?\nThis will allow you to simply run `wrangler deploy` on future deployments.",
					result: true,
				});

				const bodies: AssetManifest[] = [];
				await mockAUSRequest(bodies);

				await runWrangler("deploy ./assets --x-autoconfig");
				expect(bodies.length).toBe(1);
				expect(bodies[0]).toEqual({
					manifest: {
						"/index.html": {
							hash: "8308ce789f3d08668ce87176838d59d0",
							size: 17,
						},
					},
				});
				expect(fs.readFileSync("wrangler.jsonc", "utf-8"))
					.toMatchInlineSnapshot(`
						"{
						  "name": "test-name",
						  "compatibility_date": "2024-01-01",
						  "assets": {
						    "directory": "./assets"
						  }
						}"
					`);
				expect(std.out).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────



					No compatibility date found Defaulting to today: 2024-01-01

					Wrote
					{
					  "name": "test-name",
					  "compatibility_date": "2024-01-01",
					  "assets": {
					    "directory": "./assets"
					  }
					}
					 to <cwd>/wrangler.jsonc.
					Please run \`wrangler deploy\` instead of \`wrangler deploy ./assets\` next time. Wrangler will automatically use the configuration saved to wrangler.jsonc.

					Proceeding with deployment...

					Total Upload: xx KiB / gzip: xx KiB
					Worker Startup Time: 100 ms
					Uploaded test-name (TIMINGS)
					Deployed test-name triggers (TIMINGS)
					  https://test-name.test-sub-domain.workers.dev
					Current Version ID: Galaxy-Class"
				`);
				expect(getDetailsForAutoConfigSpy).not.toHaveBeenCalled();
				expect(runAutoConfigSpy).not.toHaveBeenCalled();
			});

			// TODO: remove this test once autoconfig goes GA and its experimental opt-in flag is removed
			it("should handle `wrangler deploy --assets` without name or compat date", async () => {
				// if the user has used --assets flag and args.script is not set, we just need to prompt for the name and add compat date
				mockPrompt({
					text: "What do you want to name your project?",
					options: { defaultValue: "my-site" },
					result: "test-name",
				});
				mockConfirm({
					text: "Do you want Wrangler to write a wrangler.json config file to store this configuration?\nThis will allow you to simply run `wrangler deploy` on future deployments.",
					result: true,
				});

				const bodies: AssetManifest[] = [];
				await mockAUSRequest(bodies);

				await runWrangler("deploy --assets ./assets");
				expect(bodies.length).toBe(1);
				expect(bodies[0]).toEqual({
					manifest: {
						"/index.html": {
							hash: "8308ce789f3d08668ce87176838d59d0",
							size: 17,
						},
					},
				});
				expect(fs.readFileSync("wrangler.jsonc", "utf-8"))
					.toMatchInlineSnapshot(`
						"{
						  "name": "test-name",
						  "compatibility_date": "2024-01-01",
						  "assets": {
						    "directory": "./assets"
						  }
						}"
					`);
				expect(std.out).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────


					No compatibility date found Defaulting to today: 2024-01-01

					Wrote
					{
					  "name": "test-name",
					  "compatibility_date": "2024-01-01",
					  "assets": {
					    "directory": "./assets"
					  }
					}
					 to <cwd>/wrangler.jsonc.
					Please run \`wrangler deploy\` instead of \`wrangler deploy ./assets\` next time. Wrangler will automatically use the configuration saved to wrangler.jsonc.

					Proceeding with deployment...

					Total Upload: xx KiB / gzip: xx KiB
					Worker Startup Time: 100 ms
					Uploaded test-name (TIMINGS)
					Deployed test-name triggers (TIMINGS)
					  https://test-name.test-sub-domain.workers.dev
					Current Version ID: Galaxy-Class"
				`);
			});

			it("should handle `wrangler deploy --assets` without name or compat date without triggering autoconfig when called with `--x-autoconfig`", async () => {
				vi.mock(import("../autoconfig/details"), { spy: true });
				vi.mock(import("../autoconfig/run"), { spy: true });

				const getDetailsForAutoConfigSpy = (
					await import("../autoconfig/details")
				).getDetailsForAutoConfig;

				const runAutoConfigSpy = (await import("../autoconfig/run"))
					.runAutoConfig;

				// if the user has used --assets flag and args.script is not set, we just need to prompt for the name and add compat date
				mockPrompt({
					text: "What do you want to name your project?",
					options: { defaultValue: "my-site" },
					result: "test-name",
				});
				mockConfirm({
					text: "Do you want Wrangler to write a wrangler.json config file to store this configuration?\nThis will allow you to simply run `wrangler deploy` on future deployments.",
					result: true,
				});

				const bodies: AssetManifest[] = [];
				await mockAUSRequest(bodies);

				await runWrangler("deploy --assets ./assets --x-autoconfig");
				expect(bodies.length).toBe(1);
				expect(bodies[0]).toEqual({
					manifest: {
						"/index.html": {
							hash: "8308ce789f3d08668ce87176838d59d0",
							size: 17,
						},
					},
				});
				expect(fs.readFileSync("wrangler.jsonc", "utf-8"))
					.toMatchInlineSnapshot(`
						"{
						  "name": "test-name",
						  "compatibility_date": "2024-01-01",
						  "assets": {
						    "directory": "./assets"
						  }
						}"
					`);
				expect(std.out).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────


					No compatibility date found Defaulting to today: 2024-01-01

					Wrote
					{
					  "name": "test-name",
					  "compatibility_date": "2024-01-01",
					  "assets": {
					    "directory": "./assets"
					  }
					}
					 to <cwd>/wrangler.jsonc.
					Please run \`wrangler deploy\` instead of \`wrangler deploy ./assets\` next time. Wrangler will automatically use the configuration saved to wrangler.jsonc.

					Proceeding with deployment...

					Total Upload: xx KiB / gzip: xx KiB
					Worker Startup Time: 100 ms
					Uploaded test-name (TIMINGS)
					Deployed test-name triggers (TIMINGS)
					  https://test-name.test-sub-domain.workers.dev
					Current Version ID: Galaxy-Class"
				`);
				expect(getDetailsForAutoConfigSpy).not.toHaveBeenCalled();
				expect(runAutoConfigSpy).not.toHaveBeenCalled();
			});

			it("should not trigger autoconfig on `wrangler deploy <script>` when called with `--x-autoconfig`", async () => {
				vi.mock(import("../autoconfig/details"), { spy: true });
				vi.mock(import("../autoconfig/run"), { spy: true });

				const getDetailsForAutoConfigSpy = (
					await import("../autoconfig/details")
				).getDetailsForAutoConfig;

				const runAutoConfigSpy = (await import("../autoconfig/run"))
					.runAutoConfig;

				mockConfirm({
					text: "It looks like you are trying to deploy a directory of static assets only. Is this correct?",
					result: true,
				});
				mockPrompt({
					text: "What do you want to name your project?",
					options: { defaultValue: "my-site" },
					result: "test-name",
				});
				mockConfirm({
					text: "Do you want Wrangler to write a wrangler.json config file to store this configuration?\nThis will allow you to simply run `wrangler deploy` on future deployments.",
					result: true,
				});

				const bodies: AssetManifest[] = [];
				await mockAUSRequest(bodies);

				await runWrangler("deploy ./assets --x-autoconfig");
				expect(bodies.length).toBe(1);
				expect(bodies[0]).toEqual({
					manifest: {
						"/index.html": {
							hash: "8308ce789f3d08668ce87176838d59d0",
							size: 17,
						},
					},
				});
				expect(fs.readFileSync("wrangler.jsonc", "utf-8"))
					.toMatchInlineSnapshot(`
						"{
						  "name": "test-name",
						  "compatibility_date": "2024-01-01",
						  "assets": {
						    "directory": "./assets"
						  }
						}"
					`);
				expect(std.out).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────



					No compatibility date found Defaulting to today: 2024-01-01

					Wrote
					{
					  "name": "test-name",
					  "compatibility_date": "2024-01-01",
					  "assets": {
					    "directory": "./assets"
					  }
					}
					 to <cwd>/wrangler.jsonc.
					Please run \`wrangler deploy\` instead of \`wrangler deploy ./assets\` next time. Wrangler will automatically use the configuration saved to wrangler.jsonc.

					Proceeding with deployment...

					Total Upload: xx KiB / gzip: xx KiB
					Worker Startup Time: 100 ms
					Uploaded test-name (TIMINGS)
					Deployed test-name triggers (TIMINGS)
					  https://test-name.test-sub-domain.workers.dev
					Current Version ID: Galaxy-Class"
				`);
				expect(getDetailsForAutoConfigSpy).not.toHaveBeenCalled();
				expect(runAutoConfigSpy).not.toHaveBeenCalled();
			});

			it("should suggest 'my-project' if the default name from the cwd is invalid", async () => {
				process.chdir("../");
				fs.renameSync("my-site", "[blah]");
				process.chdir("[blah]");
				// if the user has used --assets flag and args.script is not set, we just need to prompt for the name and add compat date
				mockPrompt({
					text: "What do you want to name your project?",
					// not [blah] because it is an invalid worker name
					options: { defaultValue: "my-project" },
					result: "test-name",
				});
				mockConfirm({
					text: "Do you want Wrangler to write a wrangler.json config file to store this configuration?\nThis will allow you to simply run `wrangler deploy` on future deployments.",
					result: true,
				});

				const bodies: AssetManifest[] = [];
				await mockAUSRequest(bodies);

				await runWrangler("deploy --assets ./assets");
				expect(bodies.length).toBe(1);
				expect(bodies[0]).toEqual({
					manifest: {
						"/index.html": {
							hash: "8308ce789f3d08668ce87176838d59d0",
							size: 17,
						},
					},
				});
				expect(fs.readFileSync("wrangler.jsonc", "utf-8"))
					.toMatchInlineSnapshot(`
						"{
						  "name": "test-name",
						  "compatibility_date": "2024-01-01",
						  "assets": {
						    "directory": "./assets"
						  }
						}"
					`);
			});

			it("should bail if the user denies that they are trying to deploy a directory", async () => {
				mockConfirm({
					text: "It looks like you are trying to deploy a directory of static assets only. Is this correct?",
					result: false,
				});

				await expect(runWrangler("deploy ./assets")).rejects
					.toThrowErrorMatchingInlineSnapshot(`
					[Error: The provided entry-point path, "assets", points to a directory, rather than a file.

					 If you want to deploy a directory of static assets, you can do so by using the \`--assets\` flag. For example:

					wrangler deploy --assets=./assets
					]
				`);
			});

			it("does not write out a wrangler config file if the user says no", async () => {
				mockPrompt({
					text: "What do you want to name your project?",
					options: { defaultValue: "my-site" },
					result: "test-name",
				});
				mockConfirm({
					text: "Do you want Wrangler to write a wrangler.json config file to store this configuration?\nThis will allow you to simply run `wrangler deploy` on future deployments.",
					result: false,
				});

				const bodies: AssetManifest[] = [];
				await mockAUSRequest(bodies);

				await runWrangler("deploy --assets ./assets");
				expect(bodies.length).toBe(1);
				expect(bodies[0]).toEqual({
					manifest: {
						"/index.html": {
							hash: "8308ce789f3d08668ce87176838d59d0",
							size: 17,
						},
					},
				});
				expect(fs.existsSync("wrangler.jsonc")).toBe(false);
				expect(std.out).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────


					No compatibility date found Defaulting to today: 2024-01-01

					You should run wrangler deploy --name test-name --compatibility-date 2024-01-01 --assets ./assets next time to deploy this Worker without going through this flow again.

					Proceeding with deployment...

					Total Upload: xx KiB / gzip: xx KiB
					Worker Startup Time: 100 ms
					Uploaded test-name (TIMINGS)
					Deployed test-name triggers (TIMINGS)
					  https://test-name.test-sub-domain.workers.dev
					Current Version ID: Galaxy-Class"
				`);
			});
		});
	});

	describe("custom builds", () => {
		beforeEach(() => {
			vi.unstubAllGlobals();
		});
		it("should run a custom build before publishing", async () => {
			writeWranglerConfig({
				build: {
					command: `node -e "4+4; require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')"`,
				},
			});

			mockUploadWorkerRequest({
				expectedEntry: "return new Response(123)",
			});
			mockSubDomainRequest();

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				[custom build] Running: node -e "4+4; require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')"
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		if (process.platform !== "win32") {
			it("should run a custom build of multiple steps combined by && before publishing", async () => {
				writeWranglerConfig({
					build: {
						command: `echo "export default { fetch(){ return new Response(123) } }" > index.js`,
					},
				});

				mockUploadWorkerRequest({
					expectedEntry: "return new Response(123)",
				});
				mockSubDomainRequest();

				await runWrangler("deploy index.js");
				expect(std.out).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					[custom build] Running: echo "export default { fetch(){ return new Response(123) } }" > index.js
					Total Upload: xx KiB / gzip: xx KiB
					Worker Startup Time: 100 ms
					Uploaded test-name (TIMINGS)
					Deployed test-name triggers (TIMINGS)
					  https://test-name.test-sub-domain.workers.dev
					Current Version ID: Galaxy-Class"
				`);
				expect(std.err).toMatchInlineSnapshot(`""`);
				expect(std.warn).toMatchInlineSnapshot(`""`);
			});
		}

		it("should throw an error if the entry doesn't exist after the build finishes", async () => {
			writeWranglerConfig({
				main: "index.js",
				build: {
					command: `node -e "4+4;"`,
				},
			});

			await expect(runWrangler("deploy index.js")).rejects
				.toThrowErrorMatchingInlineSnapshot(`
				[Error: The expected output file at "index.js" was not found after running custom build: node -e "4+4;".
				The \`main\` property in your wrangler.toml file should point to the file generated by the custom build.]
			`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				[custom build] Running: node -e "4+4;"
				"
			`);
			expect(std.err).toMatchInlineSnapshot(`
				"[31mX [41;31m[[41;97mERROR[41;31m][0m [1mThe expected output file at "index.js" was not found after running custom build: node -e "4+4;".[0m

				  The \`main\` property in your wrangler.toml file should point to the file generated by the custom
				  build.

				"
			`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should throw an error if the entry is a directory after the build finishes", async () => {
			writeWranglerConfig({
				main: "./",
				build: {
					command: `node -e "4+4;"`,
				},
			});

			fs.writeFileSync("./worker.js", "some content", "utf-8");
			fs.mkdirSync("./dist");
			fs.writeFileSync("./dist/index.ts", "some content", "utf-8");

			await expect(runWrangler("deploy")).rejects
				.toThrowErrorMatchingInlineSnapshot(`
				[Error: The provided entry-point path, ".", points to a directory, rather than a file.

				Did you mean to set the main field to one of:
				\`\`\`
				main = "./worker.js"
				main = "./dist/index.ts"
				\`\`\`]
			`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				[custom build] Running: node -e "4+4;"
				"
			`);
			expect(std.err).toMatchInlineSnapshot(`
				"[31mX [41;31m[[41;97mERROR[41;31m][0m [1mThe provided entry-point path, ".", points to a directory, rather than a file.[0m


				  Did you mean to set the main field to one of:
				  \`\`\`
				  main = "./worker.js"
				  main = "./dist/index.ts"
				  \`\`\`

				"
			`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should minify the script when `--minify` is true (sw)", async () => {
			writeWranglerConfig({
				main: "./index.js",
			});
			fs.writeFileSync(
				"./index.js",
				`export
        default {
          fetch() {
            return new Response(     "hello Cpt Picard"     )
                  }
            }
        `
			);

			mockUploadWorkerRequest({
				expectedEntry: 'fetch(){return new Response("hello Cpt Picard")',
			});

			mockSubDomainRequest();
			await runWrangler("deploy index.js --minify");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should minify the script when `minify` in config is true (esm)", async () => {
			writeWranglerConfig({
				main: "./index.js",
				legacy_env: false,
				env: {
					testEnv: {
						minify: true,
					},
				},
			});
			fs.writeFileSync(
				"./index.js",
				`export
        default {
          fetch() {
            return new Response(     "hello Cpt Picard"     )
                  }
            }
        `
			);

			mockUploadWorkerRequest({
				env: "testEnv",
				expectedType: "esm",
				useServiceEnvironments: true,
				expectedEntry: `fetch(){return new Response("hello Cpt Picard")`,
			});

			mockSubDomainRequest();
			await runWrangler("deploy -e testEnv index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (testEnv) (TIMINGS)
				Deployed test-name (testEnv) triggers (TIMINGS)
				  https://testEnv.test-name.test-sub-domain.workers.dev
				Current Version ID: undefined"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should apply esbuild's keep-names functionality by default", async () => {
			writeWranglerConfig({
				main: "./index.js",
				legacy_env: false,
				env: {
					testEnv: {},
				},
			});
			fs.writeFileSync(
				"./index.js",
				`
				export
					default {
						fetch() {
							function sayHello() {
								return "Hello World with keep_names";
							}
							return new Response(sayHello());
					}
				}
				`
			);

			const underscoreUnderscoreNameRegex = /__name\(.*?\)/;

			mockUploadWorkerRequest({
				env: "testEnv",
				expectedType: "esm",
				useServiceEnvironments: true,
				expectedEntry: (str) => {
					expect(str).toMatch(underscoreUnderscoreNameRegex);
				},
			});

			mockSubDomainRequest();
			await runWrangler("deploy -e testEnv index.js");
		});

		it("should apply esbuild's keep-names functionality unless keep_names is set to false", async () => {
			writeWranglerConfig({
				main: "./index.js",
				legacy_env: false,
				env: {
					testEnv: {
						keep_names: false,
					},
				},
			});
			fs.writeFileSync(
				"./index.js",
				`
				export
					default {
						fetch() {
							function sayHello() {
								return "Hello World without keep_names";
							}
							return new Response(sayHello());
					}
				}
				`
			);

			const underscoreUnderscoreNameRegex = /__name\(.*?\)/;

			mockUploadWorkerRequest({
				env: "testEnv",
				expectedType: "esm",
				useServiceEnvironments: true,
				expectedEntry: (str) => {
					expect(str).not.toMatch(underscoreUnderscoreNameRegex);
				},
			});

			mockSubDomainRequest();
			await runWrangler("deploy -e testEnv index.js");
		});
	});

	describe("upload rules", () => {
		it("should be able to define rules for uploading non-js modules (sw)", async () => {
			writeWranglerConfig({
				rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: true }],
			});
			fs.writeFileSync("./index.js", `import TEXT from './text.file';`);
			fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedType: "sw",
				expectedBindings: [
					{
						name: "__2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0_text_file",
						part: "__2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0_text_file",
						type: "text_blob",
					},
				],
				expectedModules: {
					__2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0_text_file:
						"SOME TEXT CONTENT",
				},
				useOldUploadApi: true,
			});
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should be able to define rules for uploading non-js modules (esm)", async () => {
			writeWranglerConfig({
				rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: true }],
			});
			fs.writeFileSync(
				"./index.js",
				`import TEXT from './text.file'; export default {};`
			);
			fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedType: "esm",
				expectedBindings: [],
				expectedModules: {
					"./2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0-text.file":
						"SOME TEXT CONTENT",
				},
			});
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should be able to use fallthrough:true for multiple rules", async () => {
			writeWranglerConfig({
				rules: [
					{ type: "Text", globs: ["**/*.file"], fallthrough: true },
					{ type: "Text", globs: ["**/*.other"], fallthrough: true },
				],
			});
			fs.writeFileSync(
				"./index.js",
				`import TEXT from './text.file'; import OTHER from './other.other'; export default {};`
			);
			fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
			fs.writeFileSync("./other.other", "SOME OTHER TEXT CONTENT");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedType: "esm",
				expectedBindings: [],
				expectedModules: {
					"./2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0-text.file":
						"SOME TEXT CONTENT",
					"./16347a01366873ed80fe45115119de3c92ab8db0-other.other":
						"SOME OTHER TEXT CONTENT",
				},
			});
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should be able to use fallthrough:false for multiple rules", async () => {
			writeWranglerConfig({
				rules: [
					{ type: "Text", globs: ["**/*.file"], fallthrough: false },
					{ type: "Text", globs: ["**/*.other"] },
				],
			});
			fs.writeFileSync(
				"./index.js",
				`import TEXT from './text.file'; import OTHER from './other.other'; export default {};`
			);
			fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
			fs.writeFileSync("./other.other", "SOME OTHER TEXT CONTENT");

			// We throw an error when we come across a file that matched a rule
			// but was skipped because of fallthrough = false
			let err: Error | undefined;
			try {
				await runWrangler("deploy index.js");
			} catch (e) {
				err = e as Error;
			}
			expect(err?.message).toMatch(
				`The file ./other.other matched a module rule in your configuration ({"type":"Text","globs":["**/*.other"]}), but was ignored because a previous rule with the same type was not marked as \`fallthrough = true\`.`
			);
		});

		it("should warn when multiple rules for the same type do not have fallback defined", async () => {
			writeWranglerConfig({
				rules: [
					{ type: "Text", globs: ["**/*.file"] },
					{ type: "Text", globs: ["**/*.other"] },
				],
			});
			fs.writeFileSync(
				"./index.js",
				`import TEXT from './text.file'; import OTHER from './other.other'; export default {};`
			);
			fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
			fs.writeFileSync("./other.other", "SOME OTHER TEXT CONTENT");

			// We throw an error when we come across a file that matched a rule
			// but was skipped because of fallthrough = false
			let err: Error | undefined;
			try {
				await runWrangler("deploy index.js");
			} catch (e) {
				err = e as Error;
			}
			expect(err?.message).toMatch(
				`The file ./other.other matched a module rule in your configuration ({"type":"Text","globs":["**/*.other"]}), but was ignored because a previous rule with the same type was not marked as \`fallthrough = true\`.`
			);
			// and the warnings because fallthrough was not explicitly set
			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mThe module rule {"type":"Text","globs":["**/*.file"]} does not have a fallback, the following rules will be ignored:[0m

				   {"type":"Text","globs":["**/*.other"]}
				   {"type":"Text","globs":["**/*.txt","**/*.html","**/*.sql"]} (DEFAULT)

				  Add \`fallthrough = true\` to rule to allow next rule to be used or \`fallthrough = false\` to silence
				  this warning

				"
			`);
		});

		it("should be able to preserve file names when defining rules for uploading non-js modules (sw)", async () => {
			writeWranglerConfig({
				rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: true }],
				preserve_file_names: true,
			});
			fs.writeFileSync("./index.js", `import TEXT from './text.file';`);
			fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedType: "sw",
				expectedBindings: [
					{
						name: "__text_file",
						part: "__text_file",
						type: "text_blob",
					},
				],
				expectedModules: {
					__text_file: "SOME TEXT CONTENT",
				},
				useOldUploadApi: true,
			});
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should be able to preserve file names when defining rules for uploading non-js modules (esm)", async () => {
			writeWranglerConfig({
				rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: true }],
				preserve_file_names: true,
			});
			fs.writeFileSync(
				"./index.js",
				`import TEXT from './text.file'; export default {};`
			);
			fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedType: "esm",
				expectedBindings: [],
				expectedModules: {
					"./text.file": "SOME TEXT CONTENT",
				},
			});
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		describe("inject process.env.NODE_ENV", () => {
			beforeEach(() => {
				vi.stubEnv("NODE_ENV", "some-node-env");
			});

			it("should replace `process.env.NODE_ENV` in scripts", async () => {
				writeWranglerConfig();
				fs.writeFileSync(
					"./index.js",
					`export default {
            fetch(){
              return new Response(process.env.NODE_ENV);
            }
          }`
				);
				mockSubDomainRequest();
				mockUploadWorkerRequest({
					expectedEntry: `return new Response("some-node-env");`,
				});
				await runWrangler("deploy index.js");
				expect(std.out).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Total Upload: xx KiB / gzip: xx KiB
					Worker Startup Time: 100 ms
					Uploaded test-name (TIMINGS)
					Deployed test-name triggers (TIMINGS)
					  https://test-name.test-sub-domain.workers.dev
					Current Version ID: Galaxy-Class"
				`);
				expect(std.err).toMatchInlineSnapshot(`""`);
				expect(std.warn).toMatchInlineSnapshot(`""`);
			});
		});
	});

	describe("service worker format", () => {
		it("should error if trying to import a cloudflare prefixed external when in service worker format", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"dep-1.js",
				dedent`
					import sockets from 'cloudflare:sockets';
					export const external = sockets;
				`
			);
			fs.writeFileSync(
				"dep-2.js",
				dedent`
					export const internal = 100;
				`
			);
			fs.writeFileSync(
				"index.js",
				dedent`
					import {external} from "./dep-1"; // will the external import check be transitive?
					import {internal} from "./dep-2"; // ensure that we can still have a non-external import
					let x = [external, internal]; // to ensure that esbuild doesn't tree shake the imports
					// no default export making this a service worker format
					addEventListener('fetch', (event) => {
						event.respondWith(new Response(''));
					});
			`
			);

			await expect(
				runWrangler("deploy index.js --dry-run").catch((e) =>
					normalizeString(
						esbuild
							.formatMessagesSync(e?.errors ?? [], { kind: "error" })
							.join()
							.trim()
					)
				)
			).resolves.toMatchInlineSnapshot(`
				"X [ERROR] Unexpected external import of "cloudflare:sockets".
				Your worker has no default export, which means it is assumed to be a Service Worker format Worker.
				Did you mean to create a ES Module format Worker?
				If so, try adding \`export default { ... }\` in your entry-point.
				See https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/. [plugin cloudflare-internal-imports]"
			`);
		});

		it("should error if importing a node.js library when in service worker format", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"index.js",
				dedent`
					import stream from "node:stream";
					let temp = stream;
					addEventListener('fetch', (event) => {
						event.respondWith(new Response(''));
					});
			`
			);

			await expect(
				runWrangler("deploy index.js --dry-run").catch((e) =>
					normalizeString(
						esbuild
							.formatMessagesSync(e?.errors ?? [], { kind: "error" })
							.join()
							.trim()
					)
				)
			).resolves.toMatchInlineSnapshot(`
				"X [ERROR] Unexpected external import of "node:stream".
				Your worker has no default export, which means it is assumed to be a Service Worker format Worker.
				Did you mean to create a ES Module format Worker?
				If so, try adding \`export default { ... }\` in your entry-point.
				See https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/. [plugin nodejs_compat-imports]"
			`);
		});

		it("should error if nodejs_compat (v2) is turned on when in service worker format", async () => {
			writeWranglerConfig({
				compatibility_date: "2024-09-23", // Sept 23 to turn on nodejs compat v2 mode
				compatibility_flags: ["nodejs_compat"],
			});
			fs.writeFileSync(
				"index.js",
				dedent`
					addEventListener('fetch', (event) => {
						event.respondWith(new Response(''));
					});
			`
			);

			await expect(
				runWrangler("deploy index.js --dry-run").catch((e) =>
					normalizeString(
						esbuild
							.formatMessagesSync(e?.errors ?? [], { kind: "error" })
							.join()
							.trim()
					)
				)
			).resolves.toMatchInlineSnapshot(`
				"X [ERROR] Unexpected external import of "node:events", "node:perf_hooks", "node:stream", and "node:tty".
				Your worker has no default export, which means it is assumed to be a Service Worker format Worker.
				Did you mean to create a ES Module format Worker?
				If so, try adding \`export default { ... }\` in your entry-point.
				See https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/. [plugin hybrid-nodejs_compat]"
			`);
		});
	});

	describe("legacy module specifiers", () => {
		it("should work with legacy module specifiers, with a deprecation warning (1)", async () => {
			writeWranglerConfig({
				rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: false }],
			});
			fs.writeFileSync(
				"./index.js",
				`import TEXT from 'text.file'; export default {};`
			);
			fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedModules: {
					"./2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0-text.file":
						"SOME TEXT CONTENT",
				},
			});
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mDeprecation: detected a legacy module import in "./index.js". This will stop working in the future. Replace references to "text.file" with "./text.file";[0m

				"
			`);
		});

		it("should work with legacy module specifiers, with a deprecation warning (2)", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"./index.js",
				`import WASM from 'index.wasm'; export default {};`
			);
			fs.writeFileSync("./index.wasm", "SOME WASM CONTENT");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedModules: {
					"./94b240d0d692281e6467aa42043986e5c7eea034-index.wasm":
						"SOME WASM CONTENT",
				},
			});
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mDeprecation: detected a legacy module import in "./index.js". This will stop working in the future. Replace references to "index.wasm" with "./index.wasm";[0m

				"
			`);
		});

		it("should work with legacy module specifiers, with a deprecation warning (3)", async () => {
			writeWranglerConfig({
				rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: false }],
			});
			fs.writeFileSync(
				"./index.js",
				`import TEXT from 'text+name.file'; export default {};`
			);
			fs.writeFileSync("./text+name.file", "SOME TEXT CONTENT");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedModules: {
					"./2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0-text+name.file":
						"SOME TEXT CONTENT",
				},
			});
			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mDeprecation: detected a legacy module import in "./index.js". This will stop working in the future. Replace references to "text+name.file" with "./text+name.file";[0m

				"
			`);
		});

		it("should not match regular module specifiers when there aren't any possible legacy module matches", async () => {
			// see https://github.com/cloudflare/workers-sdk/issues/655 for bug details

			fs.writeFileSync(
				"./index.js",
				`import inner from './inner/index.js'; export default {};`
			);
			fs.mkdirSync("./inner", { recursive: true });
			fs.writeFileSync("./inner/index.js", `export default 123`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();

			await runWrangler(
				"deploy index.js --compatibility-date 2022-03-17 --name test-name"
			);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});
	});

	describe("tsconfig", () => {
		it("should use compilerOptions.paths to resolve modules", async () => {
			writeWranglerConfig({
				main: "index.ts",
			});
			fs.writeFileSync(
				"index.ts",
				`import { foo } from '~lib/foo'; export default { fetch() { return new Response(foo)} }`
			);
			fs.mkdirSync("lib", { recursive: true });
			fs.writeFileSync("lib/foo.ts", `export const foo = 123;`);
			fs.writeFileSync(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						baseUrl: ".",
						paths: {
							"~lib/*": ["lib/*"],
						},
					},
				})
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedEntry: "var foo = 123;", // make sure it imported the module correctly
			});
			await runWrangler("deploy index.ts");
			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "",
				}
			`);
		});

		it("should use compilerOptions.paths to resolve non-js modules with module rules", async () => {
			writeWranglerConfig({
				main: "index.ts",
				rules: [{ type: "Text", globs: ["**/*.graphql"], fallthrough: true }],
			});
			fs.writeFileSync(
				"index.ts",
				`import schema from '~lib/schema.graphql'; export default { fetch() { return new Response(schema)} }`
			);
			fs.mkdirSync("lib", { recursive: true });
			fs.writeFileSync("lib/schema.graphql", `type Query { hello: String }`);
			fs.writeFileSync(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						baseUrl: ".",
						paths: {
							"~lib/*": ["lib/*"],
						},
					},
				})
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedModules: {
					"./bc4a21e10be4cae586632dfe5c3f049299c06466-schema.graphql":
						"type Query { hello: String }",
				},
			});
			await runWrangler("deploy index.ts");
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should output to target es2022 even if tsconfig says otherwise", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			fs.writeFileSync(
				"./index.js",
				`
			import { foo } from "./another";
			const topLevelAwait = await new Promise((resolve) => setTimeout(resolve, 0));

			export default {
  			async fetch(request) {

    			return new Response("Hello world!");
  			},
			};`
			);
			fs.writeFileSync(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						target: "es5",
						module: "commonjs",
					},
				})
			);
			mockSubDomainRequest();
			/**
			 * When we compile with es2022, we should preserve the export statement and top level await
			 * If you attempt to target es2020 top level await will cause a build error
			 * @error Build failed with 1 error:
			 * index.js:3:25: ERROR: Top-level await is not available in the configured target environment ("es2020")
			 */
			mockUploadWorkerRequest({
				expectedEntry: "export {", // check that the export is preserved
			});
			await runWrangler("deploy index.js"); // this would throw if we tried to compile with es5
			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "",
				}
			`);
		});
	});

	describe("--outdir", () => {
		it("should generate built assets at --outdir if specified", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			await runWrangler("deploy index.js --outdir some-dir");
			expect(fs.existsSync("some-dir/index.js")).toBe(true);
			expect(fs.existsSync("some-dir/index.js.map")).toBe(true);
			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "",
				}
			`);
		});

		it("should copy any module imports related assets to --outdir if specified", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"./index.js",
				`
import txt from './textfile.txt';
import hello from './hello.wasm';
export default{
  async fetch(){
		const module = await WebAssembly.instantiate(hello);
    return new Response(txt + module.exports.hello);
  }
}
`
			);
			fs.writeFileSync("./textfile.txt", "Hello, World!");
			fs.writeFileSync("./hello.wasm", "Hello wasm World!");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedModules: {
					"./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt":
						"Hello, World!",
					"./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm":
						"Hello wasm World!",
				},
			});
			await runWrangler("deploy index.js --outdir some-dir");

			expect(fs.existsSync("some-dir/index.js")).toBe(true);
			expect(fs.existsSync("some-dir/index.js.map")).toBe(true);
			expect(fs.existsSync("some-dir/README.md")).toBe(true);
			expect(
				fs.existsSync(
					"some-dir/0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt"
				)
			).toBe(true);
			expect(
				fs.existsSync(
					"some-dir/d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm"
				)
			).toBe(true);
			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "",
				}
			`);
		});
	});

	describe("--outfile", () => {
		it("should generate worker bundle at --outfile if specified", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			await runWrangler("deploy index.js --outfile some-dir/worker.bundle");
			expect(fs.existsSync("some-dir/worker.bundle")).toBe(true);
			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "",
				}
			`);
		});

		it("should include any module imports related assets in the worker bundle", async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"./index.js",
				`
import txt from './textfile.txt';
import hello from './hello.wasm';
export default{
  async fetch(){
		const module = await WebAssembly.instantiate(hello);
    return new Response(txt + module.exports.hello);
  }
}
`
			);
			fs.writeFileSync("./textfile.txt", "Hello, World!");
			fs.writeFileSync("./hello.wasm", "Hello wasm World!");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedModules: {
					"./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt":
						"Hello, World!",
					"./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm":
						"Hello wasm World!",
				},
			});
			await runWrangler("deploy index.js --outfile some-dir/worker.bundle");

			expect(fs.existsSync("some-dir/worker.bundle")).toBe(true);
			expect(
				fs
					.readFileSync("some-dir/worker.bundle", "utf8")
					.replace(
						/------formdata-undici-0.[0-9]*/g,
						"------formdata-undici-0.test"
					)
					.replace(/wrangler_(.+?)_default/g, "wrangler_default")
			).toMatchInlineSnapshot(`
				"------formdata-undici-0.test
				Content-Disposition: form-data; name="metadata"

				{"main_module":"index.js","bindings":[],"compatibility_date":"2022-01-12","compatibility_flags":[]}
				------formdata-undici-0.test
				Content-Disposition: form-data; name="index.js"; filename="index.js"
				Content-Type: application/javascript+module

				// index.js
				import txt from "./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt";
				import hello from "./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm";
				var index_default = {
				  async fetch() {
				    const module = await WebAssembly.instantiate(hello);
				    return new Response(txt + module.exports.hello);
				  }
				};
				export {
				  index_default as default
				};
				//# sourceMappingURL=index.js.map

				------formdata-undici-0.test
				Content-Disposition: form-data; name="./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt"; filename="./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt"
				Content-Type: text/plain

				Hello, World!
				------formdata-undici-0.test
				Content-Disposition: form-data; name="./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm"; filename="./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm"
				Content-Type: application/wasm

				Hello wasm World!
				------formdata-undici-0.test--
				"
			`);

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "",
				}
			`);
		});

		it("should include bindings in the worker bundle", async () => {
			writeWranglerConfig({
				kv_namespaces: [{ binding: "KV", id: "kv-namespace-id" }],
			});
			fs.writeFileSync(
				"./index.js",
				`
import txt from './textfile.txt';
import hello from './hello.wasm';
export default{
  async fetch(){
		const module = await WebAssembly.instantiate(hello);
    return new Response(txt + module.exports.hello);
  }
}
`
			);
			fs.writeFileSync("./textfile.txt", "Hello, World!");
			fs.writeFileSync("./hello.wasm", "Hello wasm World!");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedModules: {
					"./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt":
						"Hello, World!",
					"./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm":
						"Hello wasm World!",
				},
			});
			await runWrangler("deploy index.js --outfile some-dir/worker.bundle");

			expect(fs.existsSync("some-dir/worker.bundle")).toBe(true);
			expect(
				fs
					.readFileSync("some-dir/worker.bundle", "utf8")
					.replace(
						/------formdata-undici-0.[0-9]*/g,
						"------formdata-undici-0.test"
					)
					.replace(/wrangler_(.+?)_default/g, "wrangler_default")
			).toMatchInlineSnapshot(`
				"------formdata-undici-0.test
				Content-Disposition: form-data; name="metadata"

				{"main_module":"index.js","bindings":[{"name":"KV","type":"kv_namespace","namespace_id":"kv-namespace-id"}],"compatibility_date":"2022-01-12","compatibility_flags":[]}
				------formdata-undici-0.test
				Content-Disposition: form-data; name="index.js"; filename="index.js"
				Content-Type: application/javascript+module

				// index.js
				import txt from "./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt";
				import hello from "./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm";
				var index_default = {
				  async fetch() {
				    const module = await WebAssembly.instantiate(hello);
				    return new Response(txt + module.exports.hello);
				  }
				};
				export {
				  index_default as default
				};
				//# sourceMappingURL=index.js.map

				------formdata-undici-0.test
				Content-Disposition: form-data; name="./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt"; filename="./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt"
				Content-Type: text/plain

				Hello, World!
				------formdata-undici-0.test
				Content-Disposition: form-data; name="./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm"; filename="./d025a03cd31e98e96fb5bd5bce87f9bca4e8ce2c-hello.wasm"
				Content-Type: application/wasm

				Hello wasm World!
				------formdata-undici-0.test--
				"
			`);

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                       Resource
				env.KV (kv-namespace-id)      KV Namespace

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "",
				}
			`);
		});
	});

	describe("--dry-run", () => {
		it("should not deploy the worker if --dry-run is specified", async () => {
			writeWranglerConfig({
				// add a durable object with migrations
				// to make sure we _don't_ fetch migration status
				durable_objects: {
					bindings: [{ name: "NAME", class_name: "SomeClass" }],
				},
				migrations: [{ tag: "v1", new_classes: ["SomeClass"] }],
			});
			fs.writeFileSync(
				"index.js",
				`export default {
        	async fetch(request) {
          	return new Response('Hello' + foo);
        	},
      	};
				export class SomeClass {};`
			);
			vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
			await runWrangler("deploy index.js --dry-run");
			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Your Worker has access to the following bindings:
				Binding                   Resource
				env.NAME (SomeClass)      Durable Object

				--dry-run: exiting now.",
				  "warn": "",
				}
			`);
		});
	});

	describe("--node-compat", () => {
		it("should error when using node compatibility mode", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			await expect(
				runWrangler("deploy index.js --node-compat --dry-run")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`[Error: The --node-compat flag is no longer supported as of Wrangler v4. Instead, use the \`nodejs_compat\` compatibility flag. This includes the functionality from legacy \`node_compat\` polyfills and natively implemented Node.js APIs. See https://developers.cloudflare.com/workers/runtime-apis/nodejs for more information.]`
			);
		});

		it("should recommend node compatibility flag when using node builtins and no node compat is enabled", async () => {
			writeWranglerConfig();
			fs.writeFileSync("index.js", "import path from 'path';");

			await expect(
				runWrangler("deploy index.js --dry-run").catch((e) =>
					normalizeString(
						esbuild
							.formatMessagesSync(e?.errors ?? [], { kind: "error" })
							.join()
							.trim()
					)
				)
			).resolves.toMatchInlineSnapshot(`
				"X [ERROR] Could not resolve "path"

				    index.js:1:17:
				      1 │ import path from 'path';
				        ╵                  ~~~~~~

				  The package "path" wasn't found on the file system but is built into node.
				  - Add the "nodejs_compat" compatibility flag to your project."
			`);
		});

		it("should recommend node compatibility flag when using node builtins and node compat is set only to nodejs_als", async () => {
			writeWranglerConfig({
				compatibility_flags: ["nodejs_als"],
			});
			fs.writeFileSync("index.js", "import path from 'path';");

			await expect(
				runWrangler("deploy index.js --dry-run").catch((e) =>
					normalizeString(
						esbuild
							.formatMessagesSync(e?.errors ?? [], { kind: "error" })
							.join()
							.trim()
					)
				)
			).resolves.toMatchInlineSnapshot(`
				"X [ERROR] Could not resolve "path"

				    index.js:1:17:
				      1 │ import path from 'path';
				        ╵                  ~~~~~~

				  The package "path" wasn't found on the file system but is built into node.
				  - Add the "nodejs_compat" compatibility flag to your project."
			`);
		});

		it("should recommend updating the compatibility date when using node builtins and the `nodejs_compat` flag", async () => {
			writeWranglerConfig({
				compatibility_date: "2024-09-01", // older than Sept 23rd, 2024
				compatibility_flags: ["nodejs_compat"],
			});
			fs.writeFileSync("index.js", "import fs from 'path';");

			await expect(
				runWrangler("deploy index.js --dry-run").catch((e) =>
					normalizeString(
						esbuild
							.formatMessagesSync(e?.errors ?? [], { kind: "error" })
							.join()
							.trim()
					)
				)
			).resolves.toMatchInlineSnapshot(`
				"X [ERROR] Could not resolve "path"

				    index.js:1:15:
				      1 │ import fs from 'path';
				        ╵                ~~~~~~

				  The package "path" wasn't found on the file system but is built into node.
				  - Make sure to prefix the module name with "node:" or update your compatibility_date to 2024-09-23 or later."
			`);
		});

		it("should recommend updating the compatibility date flag when using no_nodejs_compat and non-prefixed node builtins", async () => {
			writeWranglerConfig({
				compatibility_date: "2024-09-23",
				compatibility_flags: ["nodejs_compat", "no_nodejs_compat_v2"],
			});
			fs.writeFileSync("index.js", "import fs from 'path';");

			await expect(
				runWrangler("deploy index.js --dry-run").catch((e) =>
					normalizeString(
						esbuild
							.formatMessagesSync(e?.errors ?? [], { kind: "error" })
							.join()
							.trim()
					)
				)
			).resolves.toMatchInlineSnapshot(`
				"X [ERROR] Could not resolve "path"

				    index.js:1:15:
				      1 │ import fs from 'path';
				        ╵                ~~~~~~

				  The package "path" wasn't found on the file system but is built into node.
				  - Make sure to prefix the module name with "node:" or update your compatibility_date to 2024-09-23 or later."
			`);
		});
	});

	describe("`nodejs_compat` compatibility flag", () => {
		it('when absent, should warn on any "external" `node:*` imports', async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"index.js",
				`
      import AsyncHooks from 'node:async_hooks';
      console.log(AsyncHooks);
      export default {}
      `
			);
			await runWrangler("deploy index.js --dry-run");

			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mThe package "node:async_hooks" wasn't found on the file system but is built into node.[0m

				  Your Worker may throw errors at runtime unless you enable the "nodejs_compat" compatibility flag.
				  Refer to [4mhttps://developers.cloudflare.com/workers/runtime-apis/nodejs/[0m for more details. Imported
				  from:
				   - index.js

				"
			`);
		});

		it('when present, should support "external" `node:*` imports', async () => {
			writeWranglerConfig();
			fs.writeFileSync(
				"index.js",
				`
      import path from 'node:path';
      console.log(path);
      export default {}
      `
			);

			await runWrangler(
				"deploy index.js --dry-run --outdir=dist --compatibility-flag=nodejs_compat"
			);

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				No bindings found.
				--dry-run: exiting now.",
				  "warn": "",
				}
			`);
			expect(fs.readFileSync("dist/index.js", { encoding: "utf-8" })).toContain(
				`import path from "node:path";`
			);
		});

		it(`when present, and compat date is on or after 2024-09-23, should support "external" non-prefixed node imports`, async () => {
			writeWranglerConfig({
				compatibility_date: "2024-09-23",
			});
			fs.writeFileSync(
				"index.js",
				`
      import path from 'node:path';
      console.log(path);
      export default {}
      `
			);

			await runWrangler(
				"deploy index.js --dry-run --outdir=dist --compatibility-flag=nodejs_compat"
			);

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				No bindings found.
				--dry-run: exiting now.",
				  "warn": "",
				}
			`);
			expect(fs.readFileSync("dist/index.js", { encoding: "utf-8" })).toContain(
				`import path from "node:path";`
			);
		});
	});

	describe("bundle reporter", () => {
		it("should print the bundle size", async () => {
			fs.writeFileSync(
				"./text.txt",
				`${new Array(100)
					.fill("Try not. Do or do not. There is no try.")
					.join("")}`
			);

			fs.writeFileSync(
				"./hello.html",
				`<!DOCTYPE html>
      <html>
        <body>
            <h2>Hello World!</h2>
        </body>
      </html>
      `
			);

			fs.writeFileSync(
				"index.js",
				`import hello from "./hello.html";
         import text from "./text.txt";
        export default {
          async fetch(request) {
            return new Response(json.stringify({ hello, text }));
        },
      };`
			);
			writeWranglerConfig({
				main: "index.js",
			});
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			await runWrangler("deploy");

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class",
				  "warn": "",
				}
			`);
		});

		it("should print the bundle size, with API errors", async () => {
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			// Override PUT call to error out from previous helper functions
			msw.use(
				http.post(
					"*/accounts/:accountId/workers/scripts/:scriptName/versions",
					() => {
						return HttpResponse.json(
							createFetchResult(null, false, [
								{
									code: 11337,
									message:
										"Worker Startup Timed out. This could be due to script exceeding size limits or expensive code in the global scope.",
								},
							])
						);
					}
				)
			);

			fs.writeFileSync(
				"./hello.html",
				`<!DOCTYPE html>
      <html>
        <body>
            <h2>Hello World!</h2>
        </body>
      </html>
      `
			);

			fs.writeFileSync(
				"index.js",
				`import hello from "./hello.html";
        export default {
          async fetch(request) {
            return new Response(json.stringify({ hello }));
        },
      };`
			);

			writeWranglerConfig({
				main: "index.js",
			});

			await expect(runWrangler("deploy")).rejects.toMatchInlineSnapshot(
				`[APIError: A request to the Cloudflare API (/accounts/some-account-id/workers/scripts/test-name/versions) failed.]`
			);
			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mA request to the Cloudflare API (/accounts/some-account-id/workers/scripts/test-name/versions) failed.[0m

				  Worker Startup Timed out. This could be due to script exceeding size limits or expensive code in
				  the global scope. [code: 11337]

				  If you think this is a bug, please open an issue at:
				  [4mhttps://github.com/cloudflare/workers-sdk/issues/new/choose[0m

				",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				",
				  "warn": "",
				}
			`);
		});

		test("should check biggest dependencies when upload fails with script size error", async () => {
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			// Override POST call to error out from previous helper functions
			msw.use(
				http.post(
					"*/accounts/:accountId/workers/scripts/:scriptName/versions",
					() => {
						return HttpResponse.json(
							createFetchResult({}, false, [
								{
									code: 10027,
									message: "workers.api.error.script_too_large",
								},
							])
						);
					}
				)
			);

			fs.writeFileSync(
				"add.wasm",
				"AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABagsACgRuYW1lAgMBAAA=",
				"base64"
			);
			fs.writeFileSync("message.txt", "👋");
			fs.writeFileSync("dependency.js", `export const thing = "a string dep";`);

			fs.writeFileSync(
				"index.js",
				`
				import addModule from "./add.wasm";
				import message from "./message.txt";
				import { thing } from "./dependency";

        export default {
          async fetch() {
          	const instance = new WebAssembly.Instance(addModule);
          	return Response.json({ add: instance.exports.add(1, 2), message, thing });
          }
        }`
			);

			writeWranglerConfig({
				main: "index.js",
			});

			await expect(runWrangler("deploy")).rejects.toMatchInlineSnapshot(
				`[APIError: A request to the Cloudflare API (/accounts/some-account-id/workers/scripts/test-name/versions) failed.]`
			);

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mYour Worker failed validation because it exceeded size limits.[0m


				  A request to the Cloudflare API (/accounts/some-account-id/workers/scripts/test-name/versions)
				  failed.
				   - workers.api.error.script_too_large [code: 10027]
				  Here are the 4 largest dependencies included in your script:

				  - index.js - xx KiB
				  - add.wasm - xx KiB
				  - dependency.js - xx KiB
				  - message.txt - xx KiB

				  If these are unnecessary, consider removing them



				[31mX [41;31m[[41;97mERROR[41;31m][0m [1mA request to the Cloudflare API (/accounts/some-account-id/workers/scripts/test-name/versions) failed.[0m

				  workers.api.error.script_too_large [code: 10027]

				  If you think this is a bug, please open an issue at:
				  [4mhttps://github.com/cloudflare/workers-sdk/issues/new/choose[0m

				",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				",
				  "warn": "",
				}
			`);
		});

		test("should offer some helpful advice when upload fails with script startup error", async () => {
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			// Override POST call to error out from previous helper functions
			msw.use(
				http.post(
					"*/accounts/:accountId/workers/scripts/:scriptName/versions",
					() => {
						return HttpResponse.json(
							createFetchResult({}, false, [
								{
									code: 10021,
									message: "Error: Script startup exceeded CPU time limit.",
								},
							])
						);
					}
				)
			);
			fs.writeFileSync("dependency.js", `export const thing = "a string dep";`);

			fs.writeFileSync(
				"index.js",
				`import { thing } from "./dependency";

        export default {
          async fetch() {
            return new Response('response plus ' + thing);
          }
        }`
			);

			writeWranglerConfig({
				main: "index.js",
			});

			await expect(runWrangler("deploy")).rejects.toThrowError();
			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mYour Worker failed validation because it exceeded startup limits.[0m


				  A request to the Cloudflare API (/accounts/some-account-id/workers/scripts/test-name/versions)
				  failed.
				   - Error: Script startup exceeded CPU time limit. [code: 10021]

				  To ensure fast responses, there are constraints on Worker startup, such as how much CPU it can
				  use, or how long it can take. Your Worker has hit one of these startup limits. Try reducing the
				  amount of work done during startup (outside the event handler), either by removing code or
				  relocating it inside the event handler.

				  Refer to [4mhttps://developers.cloudflare.com/workers/platform/limits/#worker-startup-time[0m for more
				  details
				  A CPU Profile of your Worker's startup phase has been written to
				  .wrangler/tmp/startup-profile-<HASH>/worker.cpuprofile - load it into the Chrome DevTools profiler
				  (or directly in VSCode) to view a flamegraph.


				[31mX [41;31m[[41;97mERROR[41;31m][0m [1mA request to the Cloudflare API (/accounts/some-account-id/workers/scripts/test-name/versions) failed.[0m

				  Error: Script startup exceeded CPU time limit. [code: 10021]

				  If you think this is a bug, please open an issue at:
				  [4mhttps://github.com/cloudflare/workers-sdk/issues/new/choose[0m

				",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				",
				  "warn": "",
				}
			`);
		});

		describe("unit tests", () => {
			// keeping these as unit tests to try and keep them snappy, as they often deal with
			// big files that would take a while to deal with in a full wrangler test

			test("should print the bundle size", async () => {
				const bigModule = Buffer.alloc(10_000_000);
				randomFillSync(bigModule);
				await printBundleSize({ name: "index.js", content: "" }, [
					{
						name: "index.js",
						filePath: undefined,
						content: bigModule,
						type: "buffer",
					},
				]);

				expect(std).toMatchInlineSnapshot(`
					{
					  "debug": "",
					  "err": "",
					  "info": "",
					  "out": "Total Upload: xx KiB / gzip: xx KiB",
					  "warn": "",
					}
				`);
			});

			test("should print the top biggest dependencies in the bundle when upload fails", () => {
				const deps = {
					"node_modules/a-mod/module.js": { bytesInOutput: 450 },
					"node_modules/b-mod/module.js": { bytesInOutput: 10 },
					"node_modules/c-mod/module.js": { bytesInOutput: 200 },
					"node_modules/d-mod/module.js": { bytesInOutput: 2111200 }, // 1
					"node_modules/e-mod/module.js": { bytesInOutput: 8209 }, // 3
					"node_modules/f-mod/module.js": { bytesInOutput: 770 },
					"node_modules/g-mod/module.js": { bytesInOutput: 78902 }, // 2
					"node_modules/h-mod/module.js": { bytesInOutput: 899 },
					"node_modules/i-mod/module.js": { bytesInOutput: 2001 }, // 4
					"node_modules/j-mod/module.js": { bytesInOutput: 900 }, // 5
					"node_modules/k-mod/module.js": { bytesInOutput: 79 },
				};

				const message = diagnoseScriptSizeError(
					new ParseError({ text: "too big" }),
					deps
				);
				expect(message).toMatchInlineSnapshot(`
					"Your Worker failed validation because it exceeded size limits.

					too big

					Here are the 5 largest dependencies included in your script:

					- node_modules/d-mod/module.js - 2061.72 KiB
					- node_modules/g-mod/module.js - 77.05 KiB
					- node_modules/e-mod/module.js - 8.02 KiB
					- node_modules/i-mod/module.js - 1.95 KiB
					- node_modules/j-mod/module.js - 0.88 KiB

					If these are unnecessary, consider removing them
					"
				`);
			});
		});
	});

	describe("--no-bundle", () => {
		it("(cli) should not transform the source code before publishing it", async () => {
			writeWranglerConfig();
			const scriptContent = `
      import X from '@cloudflare/no-such-package'; // let's add an import that doesn't exist
      const xyz = 123; // a statement that would otherwise be compiled out
    `;
			fs.writeFileSync("index.js", scriptContent);
			await runWrangler("deploy index.js --no-bundle --dry-run --outdir dist");
			expect(fs.readFileSync("dist/index.js", "utf-8")).toMatch(scriptContent);
		});

		it("(config) should not transform the source code before publishing it", async () => {
			writeWranglerConfig({
				no_bundle: true,
			});
			const scriptContent = `
			import X from '@cloudflare/no-such-package'; // let's add an import that doesn't exist
			const xyz = 123; // a statement that would otherwise be compiled out
		`;
			fs.writeFileSync("index.js", scriptContent);
			await runWrangler("deploy index.js --dry-run --outdir dist");
			expect(fs.readFileSync("dist/index.js", "utf-8")).toMatch(scriptContent);
		});
	});

	describe("--no-bundle --minify", () => {
		it("should warn that no-bundle and minify can't be used together", async () => {
			writeWranglerConfig();
			const scriptContent = `
			const xyz = 123; // a statement that would otherwise be compiled out
		`;
			fs.writeFileSync("index.js", scriptContent);
			await runWrangler(
				"deploy index.js --no-bundle --minify --dry-run --outdir dist"
			);
			expect(std.warn).toMatchInlineSnapshot(`
			"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1m\`--minify\` and \`--no-bundle\` can't be used together. If you want to minify your Worker and disable Wrangler's bundling, please minify as part of your own bundling process.[0m

			"
		`);
		});

		it("should warn that no-bundle and minify can't be used together", async () => {
			writeWranglerConfig({
				no_bundle: true,
				minify: true,
			});
			const scriptContent = `
			const xyz = 123; // a statement that would otherwise be compiled out
		`;
			fs.writeFileSync("index.js", scriptContent);
			await runWrangler("deploy index.js --dry-run --outdir dist");
			expect(std.warn).toMatchInlineSnapshot(`
			"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1m\`--minify\` and \`--no-bundle\` can't be used together. If you want to minify your Worker and disable Wrangler's bundling, please minify as part of your own bundling process.[0m

			"
		`);
		});
	});

	describe("source maps", () => {
		it("should include source map with bundle when upload_source_maps = true", async () => {
			writeWranglerConfig({
				main: "index.ts",
				upload_source_maps: true,
			});
			writeWorkerSource({ format: "ts" });
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedMainModule: "index.js",
				expectedModules: {
					"index.js.map": expect.stringMatching(
						/"sources":\["another.ts","index.ts"\],"sourceRoot":"".*"file":"index.js"/
					),
				},
			});

			await runWrangler("deploy");
		});

		it("should not include source map with bundle when upload_source_maps = false", async () => {
			writeWranglerConfig({
				main: "index.ts",
				upload_source_maps: false,
			});
			writeWorkerSource({ format: "ts" });

			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedMainModule: "index.js",
				expectedModules: {
					"index.js.map": null,
				},
			});

			await runWrangler("deploy");
		});

		it("should include source maps emitted by custom build when upload_source_maps = true", async () => {
			writeWranglerConfig({
				no_bundle: true,
				main: "index.js",
				upload_source_maps: true,
				build: {
					command: `echo "custom build script"`,
				},
			});
			fs.writeFileSync(
				"index.js",
				`export default { fetch() { return new Response("Hello World"); } }\n` +
					"//# sourceMappingURL=index.js.map"
			);
			fs.writeFileSync(
				"index.js.map",
				JSON.stringify({
					version: 3,
					sources: ["index.ts"],
					sourceRoot: "",
					file: "index.js",
				})
			);

			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedMainModule: "index.js",
				expectedModules: {
					"index.js.map": expect.stringMatching(
						/"sources":\["index.ts"\],"sourceRoot":"".*"file":"index.js"/
					),
				},
			});

			await runWrangler("deploy");
		});

		it("should not include source maps emitted by custom build when upload_source_maps = false", async () => {
			writeWranglerConfig({
				no_bundle: true,
				main: "index.js",
				upload_source_maps: false,
				build: {
					command: `echo "custom build script"`,
				},
			});
			fs.writeFileSync(
				"index.js",
				`export default { fetch() { return new Response("Hello World"); } }\n` +
					"//# sourceMappingURL=index.js.map"
			);
			fs.writeFileSync(
				"index.js.map",
				JSON.stringify({
					version: 3,
					file: "index.js",
					sources: ["index.ts"],
					sourceRoot: "",
				})
			);

			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedMainModule: "index.js",
				expectedModules: {
					"index.js.map": null,
				},
			});

			await runWrangler("deploy");
		});
		it("should correctly read sourcemaps with custom wrangler.toml location", async () => {
			fs.mkdirSync("some/dir", { recursive: true });
			writeWranglerConfig(
				{
					main: "../../index.ts",
					upload_source_maps: true,
				},
				"some/dir/wrangler.toml"
			);
			writeWorkerSource({ format: "ts" });

			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedMainModule: "index.js",
				expectedModules: {
					"index.js.map": expect.stringMatching(
						/"sources":\[".*?another\.ts",".*?index\.ts"\],"sourceRoot":"".*"file":"index.js"/
					),
				},
			});

			await runWrangler("deploy -c some/dir/wrangler.toml");
		});
	});

});
