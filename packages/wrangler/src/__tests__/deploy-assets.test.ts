/* eslint-disable @typescript-eslint/no-empty-object-type */
import * as fs from "node:fs";
import { writeWranglerConfig } from "@cloudflare/workers-utils/test-helpers";
import { http, HttpResponse } from "msw";
import dedent from "ts-dedent";
/* eslint-disable workers-sdk/no-vitest-import-expect -- large file with .each and custom matchers */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/* eslint-enable workers-sdk/no-vitest-import-expect */
import { getInstalledPackageVersion } from "../autoconfig/frameworks/utils/packages";
import { clearOutputFilePath } from "../output";
import { fetchSecrets } from "../utils/fetch-secrets";
import {
	checkAssetUpload,
	mockDeploymentsListRequest,
	mockLastDeploymentRequest,
	mockPatchScriptSettings,
	writeAssets,
	mockUploadAssetsToKVRequest,
	mockDeleteUnusedAssetsRequest,
	mockAUSRequest,
	mockAssetUploadRequest,
} from "./deploy-test-utils";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import { mockConsoleMethods } from "./helpers/mock-console";
import { clearDialogs } from "./helpers/mock-dialogs";
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
import type { FormData } from "undici";

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

	describe("(legacy) asset upload", () => {
		it("should upload all the files in the directory specified by `config.site.bucket`", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
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
			await runWrangler("deploy");

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
		});

		it("should not contain backslash for assets with nested directories", async () => {
			const assets = [
				{ filePath: "subdir/file-1.txt", content: "Content of file-1" },
				{ filePath: "subdir/file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						name: "__STATIC_CONTENT",
						namespace_id: "__test-name-workers_sites_assets-id",
						type: "kv_namespace",
					},
				],
				expectedModules: {
					__STATIC_CONTENT_MANIFEST:
						'{"subdir/file-1.txt":"subdir/file-1.2ca234f380.txt","subdir/file-2.txt":"subdir/file-2.5938485188.txt"}',
				},
			});
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);

			await runWrangler("deploy");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + subdir/file-1.2ca234f380.txt (uploading new version of subdir/file-1.txt)
			 + subdir/file-2.5938485188.txt (uploading new version of subdir/file-2.txt)
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
		});

		it("when using a service-worker type, it should add an asset manifest as a text_blob, and bind to a namespace", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource({ type: "sw" });
			writeAssets(assets);
			mockUploadWorkerRequest({
				expectedType: "sw",
				expectedModules: {
					__STATIC_CONTENT_MANIFEST:
						'{"file-1.txt":"file-1.2ca234f380.txt","file-2.txt":"file-2.5938485188.txt"}',
				},
				expectedBindings: [
					{
						name: "__STATIC_CONTENT",
						namespace_id: "__test-name-workers_sites_assets-id",
						type: "kv_namespace",
					},
					{
						name: "__STATIC_CONTENT_MANIFEST",
						part: "__STATIC_CONTENT_MANIFEST",
						type: "text_blob",
					},
				],
				useOldUploadApi: true,
			});
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);

			await runWrangler("deploy");

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
		});

		it("when using a module worker type, it should add an asset manifest module, and bind to a namespace", async () => {
			const assets = [
				// Using `.text` extension instead of `.txt` means files won't be
				// treated as additional modules
				{ filePath: "file-1.text", content: "Content of file-1" },
				{ filePath: "file-2.text", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
				find_additional_modules: true,
				rules: [{ type: "ESModule", globs: ["**/*.mjs"] }],
			});
			// Create a Worker that imports a CommonJS module to trigger esbuild to add
			// extra boilerplate to convert to ESM imports.
			fs.writeFileSync(`another.cjs`, `module.exports.foo = 100;`);
			fs.writeFileSync(
				`index.js`,
				`import { foo } from "./another.cjs";
					export default {
						async fetch(request) {
							return new Response('Hello' + foo);
						},
					};`
			);
			fs.mkdirSync("a/b/c", { recursive: true });
			fs.writeFileSync(
				"a/1.mjs",
				'export { default } from "__STATIC_CONTENT_MANIFEST";'
			);
			fs.writeFileSync(
				"a/b/2.mjs",
				'export { default } from "__STATIC_CONTENT_MANIFEST";'
			);
			fs.writeFileSync(
				"a/b/3.mjs",
				'export { default } from "__STATIC_CONTENT_MANIFEST";'
			);
			fs.writeFileSync(
				"a/b/c/4.mjs",
				'export { default } from "__STATIC_CONTENT_MANIFEST";'
			);
			writeAssets(assets);
			mockUploadWorkerRequest({
				expectedEntry(entry) {
					// Ensure that we have not included the watch stub in production code.
					// This is only needed in `wrangler dev`.
					expect(entry).not.toMatch(/modules-watch-stub\.js/);
				},
				expectedBindings: [
					{
						name: "__STATIC_CONTENT",
						namespace_id: "__test-name-workers_sites_assets-id",
						type: "kv_namespace",
					},
				],
				expectedModules: {
					__STATIC_CONTENT_MANIFEST:
						'{"file-1.text":"file-1.2ca234f380.text","file-2.text":"file-2.5938485188.text"}',
					"a/__STATIC_CONTENT_MANIFEST":
						'export { default } from "../__STATIC_CONTENT_MANIFEST";',
					"a/b/__STATIC_CONTENT_MANIFEST":
						'export { default } from "../../__STATIC_CONTENT_MANIFEST";',
					"a/b/c/__STATIC_CONTENT_MANIFEST":
						'export { default } from "../../../__STATIC_CONTENT_MANIFEST";',
				},
			});
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);

			await runWrangler("deploy");

			expect(std.info).toMatchInlineSnapshot(`
			"Attaching additional modules:
			Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-1.2ca234f380.text (uploading new version of file-1.text)
			 + file-2.5938485188.text (uploading new version of file-2.text)
			Uploading 2 new assets...
			Uploaded 100% [2 out of 2]"
		`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				┌─┬─┬─┐
				│ Name │ Type │ Size │
				├─┼─┼─┤
				│ a/1.mjs │ esm │ xx KiB │
				├─┼─┼─┤
				│ a/b/2.mjs │ esm │ xx KiB │
				├─┼─┼─┤
				│ a/b/3.mjs │ esm │ xx KiB │
				├─┼─┼─┤
				│ a/b/c/4.mjs │ esm │ xx KiB │
				├─┼─┼─┤
				│ Total (4 modules) │ │ xx KiB │
				└─┴─┴─┘
				↗️  Done syncing assets
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should make environment specific kv namespace for assets, even for service envs", async () => {
			// This is the same test as the one before this, but with an env arg
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-some-env-workers_sites_assets",
				id: "__test-name-some-env-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
				env: { "some-env": {} },
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest({
				env: "some-env",
				expectedBindings: [
					{
						name: "__STATIC_CONTENT",
						namespace_id: "__test-name-some-env-workers_sites_assets-id",
						type: "kv_namespace",
					},
				],
				useOldUploadApi: true,
			});
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);
			await runWrangler("deploy --env some-env --legacy-env false");

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
				Uploaded test-name (some-env) (TIMINGS)
				Deployed test-name (some-env) triggers (TIMINGS)
				  https://some-env.test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should make environment specific kv namespace for assets, even for wrangler environments", async () => {
			// And this is the same test as the one before this, but with useServiceEnvironments:false
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-some-env-workers_sites_assets",
				id: "__test-name-some-env-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
				env: { "some-env": {} },
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest({
				useServiceEnvironments: false,
				env: "some-env",
				expectedBindings: [
					{
						name: "__STATIC_CONTENT",
						namespace_id: "__test-name-some-env-workers_sites_assets-id",
						type: "kv_namespace",
					},
				],
			});
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);
			await runWrangler("deploy --env some-env --legacy-env true");

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
				Uploaded test-name-some-env (TIMINGS)
				Deployed test-name-some-env triggers (TIMINGS)
				  https://test-name-some-env.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		it("should only upload files that are not already in the KV namespace", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			// Put file-1 in the KV namespace
			mockKeyListRequest(kvNamespace.id, [{ name: "file-1.2ca234f380.txt" }]);
			// Check we do not upload file-1
			mockUploadAssetsToKVRequest(
				kvNamespace.id,
				assets.filter((a) => a.filePath !== "file-1.txt")
			);
			await runWrangler("deploy");

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
		});

		it("should only upload files that match the `site-include` arg", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			// Check we only upload file-1
			mockUploadAssetsToKVRequest(
				kvNamespace.id,
				assets.filter((a) => a.filePath === "file-1.txt")
			);
			await runWrangler("deploy --site-include file-1.txt");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-1.2ca234f380.txt (uploading new version of file-1.txt)
			Uploading 1 new asset...
			Uploaded 100% [1 out of 1]"
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
		});

		it("should not upload files that match the `site-exclude` arg", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			// Check we only upload file-1
			mockUploadAssetsToKVRequest(
				kvNamespace.id,
				assets.filter((a) => a.filePath === "file-1.txt")
			);
			await runWrangler("deploy --site-exclude file-2.txt");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-1.2ca234f380.txt (uploading new version of file-1.txt)
			Uploading 1 new asset...
			Uploaded 100% [1 out of 1]"
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
		});

		it("should only upload files that match the `site.include` config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
					include: ["file-1.txt"],
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			// Check we only upload file-1
			mockUploadAssetsToKVRequest(
				kvNamespace.id,
				assets.filter((a) => a.filePath === "file-1.txt")
			);
			await runWrangler("deploy");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-1.2ca234f380.txt (uploading new version of file-1.txt)
			Uploading 1 new asset...
			Uploaded 100% [1 out of 1]"
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
		});

		it("should not upload files that match the `site.exclude` config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
					exclude: ["file-2.txt"],
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			// Check we only upload file-1
			mockUploadAssetsToKVRequest(
				kvNamespace.id,
				assets.filter((a) => a.filePath === "file-1.txt")
			);
			await runWrangler("deploy");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-1.2ca234f380.txt (uploading new version of file-1.txt)
			Uploading 1 new asset...
			Uploaded 100% [1 out of 1]"
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
		});

		it("should use `site-include` arg over `site.include` config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
					include: ["file-2.txt"],
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			// Check we only upload file-1
			mockUploadAssetsToKVRequest(
				kvNamespace.id,
				assets.filter((a) => a.filePath === "file-1.txt")
			);
			await runWrangler("deploy --site-include file-1.txt");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-1.2ca234f380.txt (uploading new version of file-1.txt)
			Uploading 1 new asset...
			Uploaded 100% [1 out of 1]"
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
		});

		it("should use `site-exclude` arg over `site.exclude` config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
					exclude: ["file-1.txt"],
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			// Check we only upload file-1
			mockUploadAssetsToKVRequest(
				kvNamespace.id,
				assets.filter((a) => a.filePath.endsWith("file-1.txt"))
			);
			await runWrangler("deploy --site-exclude file-2.txt");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-1.2ca234f380.txt (uploading new version of file-1.txt)
			Uploading 1 new asset...
			Uploaded 100% [1 out of 1]"
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
		});

		it("should walk directories except node_modules", async () => {
			const assets = [
				{
					filePath: "directory-1/file-1.txt",
					content: "Content of file-1",
				},
				{
					filePath: "node_modules/file-2.txt",
					content: "Content of file-2",
				},
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			// Only expect file-1 to be uploaded
			mockUploadAssetsToKVRequest(kvNamespace.id, assets.slice(0, 1));
			await runWrangler("deploy");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + directory-1/file-1.2ca234f380.txt (uploading new version of directory-1/file-1.txt)
			Uploading 1 new asset...
			Uploaded 100% [1 out of 1]"
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
		});

		it("should skip hidden files and directories except `.well-known`", async () => {
			const assets = [
				{
					filePath: ".hidden-file.txt",
					content: "Content of hidden-file",
				},
				{
					filePath: ".hidden/file-1.txt",
					content: "Content of file-1",
				},
				{
					filePath: ".well-known/file-2.txt",
					content: "Content of file-2",
				},
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			// Only expect file-2 to be uploaded
			mockUploadAssetsToKVRequest(kvNamespace.id, assets.slice(2));
			await runWrangler("deploy");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + .well-known/file-2.5938485188.txt (uploading new version of .well-known/file-2.txt)
			Uploading 1 new asset...
			Uploaded 100% [1 out of 1]"
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
		});

		it("should error if the asset is over 25Mb", async () => {
			const assets = [
				{
					filePath: "large-file.txt",
					// This file is greater than 25MiB when base64 encoded but small enough to be uploaded.
					content: "X".repeat(25 * 1024 * 1024 * 0.8 + 1),
				},
				{
					filePath: "too-large-file.txt",
					content: "X".repeat(25 * 1024 * 1024 + 1),
				},
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
					exclude: ["file-1.txt"],
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);

			await expect(
				runWrangler("deploy")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`[Error: File too-large-file.txt is too big, it should be under 25 MiB. See https://developers.cloudflare.com/workers/platform/limits#kv-limits]`
			);

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + large-file.0ea0637a45.txt (uploading new version of large-file.txt)"
		`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				"
			`);
			expect(std.err).toMatchInlineSnapshot(`
			        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mFile too-large-file.txt is too big, it should be under 25 MiB. See https://developers.cloudflare.com/workers/platform/limits#kv-limits[0m

			        "
		      `);
		});

		it("should batch assets in groups <100 mb", async () => {
			// Let's have 20 files, from size 1 - 20 mb
			const assets = Array.from({ length: 20 }, (_, index) => ({
				filePath: `file-${`${index}`.padStart(2, "0")}.txt`,
				content: "X".repeat(1024 * 1024 * (index + 1)),
			}));

			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			const requests = mockUploadAssetsToKVRequest(kvNamespace.id);

			await runWrangler("deploy");

			// We expect this to be uploaded in 4 batches
			expect(requests.length).toEqual(4);
			// Buckets may be uploaded in any order, so sort them before we assert
			requests.sort((a, b) => a.uploads[0].key.localeCompare(b.uploads[0].key));
			// The first batch has 11 files
			expect(requests[0].uploads.length).toEqual(11);
			// The next batch has 5 files
			expect(requests[1].uploads.length).toEqual(5);
			// And the next one has 3 files
			expect(requests[2].uploads.length).toEqual(3);
			// And just 1 in the last batch
			expect(requests[3].uploads.length).toEqual(1);

			let assetIndex = 0;
			for (const request of requests) {
				for (const upload of request.uploads) {
					checkAssetUpload(assets[assetIndex], upload);
					assetIndex++;
				}
			}

			expect(std.debug).toMatchInlineSnapshot(`""`);
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
			// Mask all but last upload progress message as upload order unknown
			// (regexp replaces all single/double-digit percentages, i.e. not 100%)
			expect(std.info.replace(/Uploaded \d\d?% \[\d+/g, "Uploaded X% [X"))
				.toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-00.be5be5dd26.txt (uploading new version of file-00.txt)
			 + file-01.4842d35994.txt (uploading new version of file-01.txt)
			 + file-02.990572ec63.txt (uploading new version of file-02.txt)
			 + file-03.9d7dda9045.txt (uploading new version of file-03.txt)
			 + file-04.2b6fac6382.txt (uploading new version of file-04.txt)
			 + file-05.55762dc758.txt (uploading new version of file-05.txt)
			 + file-06.f408a6b020.txt (uploading new version of file-06.txt)
			 + file-07.64c051715b.txt (uploading new version of file-07.txt)
			 + file-08.d286789adb.txt (uploading new version of file-08.txt)
			 + file-09.6838c183a8.txt (uploading new version of file-09.txt)
			 + file-10.6e03221d2a.txt (uploading new version of file-10.txt)
			 + file-11.37d3fb2eff.txt (uploading new version of file-11.txt)
			 + file-12.b3556942f8.txt (uploading new version of file-12.txt)
			 + file-13.680caf51b1.txt (uploading new version of file-13.txt)
			 + file-14.51e88468f0.txt (uploading new version of file-14.txt)
			 + file-15.8e3fedb394.txt (uploading new version of file-15.txt)
			 + file-16.c81c5e426f.txt (uploading new version of file-16.txt)
			 + file-17.4b2ae3c47b.txt (uploading new version of file-17.txt)
			 + file-18.07f245e02b.txt (uploading new version of file-18.txt)
			 + file-19.f0d69f705d.txt (uploading new version of file-19.txt)
			Uploading 20 new assets...
			Uploaded X% [X out of 20]
			Uploaded X% [X out of 20]
			Uploaded X% [X out of 20]
			Uploaded 100% [20 out of 20]"
		`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		}, 30_000);

		it("should error if the asset key is over 512 characters", async () => {
			const longFilePathAsset = {
				filePath: "folder/".repeat(100) + "file.txt",
				content: "content of file",
			};
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets([longFilePathAsset]);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);

			await expect(
				runWrangler("deploy")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`[Error: The asset path key "folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/file.3da0d0cd12.txt" exceeds the maximum key size limit of 512. See https://developers.cloudflare.com/workers/platform/limits#kv-limits",]`
			);

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload..."
		`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				"
			`);
			expect(std.err).toMatchInlineSnapshot(`
				"[31mX [41;31m[[41;97mERROR[41;31m][0m [1mThe asset path key "folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/file.3da0d0cd12.txt" exceeds the maximum key size limit of 512. See https://developers.cloudflare.com/workers/platform/limits#kv-limits",[0m

				"
			`);
		});

		it("should delete uploaded assets that aren't included anymore", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, [
				// Put file-1 in the KV namespace
				{ name: "file-1.2ca234f380.txt" },
				// As well as a couple from a previous upload
				{ name: "file-3.somehash.txt" },
				{ name: "file-4.anotherhash.txt" },
			]);

			// we upload only file-1.txt
			mockUploadAssetsToKVRequest(
				kvNamespace.id,
				assets.filter((a) => a.filePath !== "file-1.txt")
			);

			// and mark file-3 and file-4 for deletion
			mockDeleteUnusedAssetsRequest(kvNamespace.id, [
				"file-3.somehash.txt",
				"file-4.anotherhash.txt",
			]);

			await runWrangler("deploy");

			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 = file-1.2ca234f380.txt (already uploaded file-1.txt)
			 + file-2.5938485188.txt (uploading new version of file-2.txt)
			 - file-3.somehash.txt (removing as stale)
			 - file-4.anotherhash.txt (removing as stale)
			Uploading 1 new asset...
			Skipped uploading 1 existing asset.
			Uploaded 100% [1 out of 1]
			Removing 2 stale assets..."
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
		});

		it("should generate an asset manifest with keys relative to site.bucket", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};

			writeWranglerConfig({
				main: "./src/index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource({ basePath: "src", type: "esm" });
			writeAssets(assets);
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						name: "__STATIC_CONTENT",
						namespace_id: "__test-name-workers_sites_assets-id",
						type: "kv_namespace",
					},
				],
				expectedModules: {
					__STATIC_CONTENT_MANIFEST:
						'{"file-1.txt":"file-1.2ca234f380.txt","file-2.txt":"file-2.5938485188.txt"}',
				},
			});
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);

			process.chdir("./src");
			await runWrangler("deploy");
			process.chdir("../");

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
		});

		it("should use the relative path from current working directory to Worker directory when using `--site`", async () => {
			writeWranglerConfig({
				main: "./index.js",
			});
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets, "my-assets");

			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};

			mockSubDomainRequest();
			writeWorkerSource();
			mockUploadWorkerRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);
			mockUploadAssetsToKVRequest(kvNamespace.id, assets);
			process.chdir("./my-assets");
			await runWrangler("deploy --site .");

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
				  "warn": "",
				}
			`);
		});

		it("should abort other bucket uploads if one bucket upload fails", async () => {
			// Write 9 20MiB files, should end up with 3 buckets
			const content = "X".repeat(20 * 1024 * 1024);
			const assets = Array.from({ length: 9 }, (_, index) => ({
				filePath: `file-${index}.txt`,
				content,
			}));

			const kvNamespace = {
				title: "__test-name-workers_sites_assets",
				id: "__test-name-workers_sites_assets-id",
			};
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "assets",
				},
			});
			writeWorkerSource();
			writeAssets(assets);
			mockUploadWorkerRequest();
			mockSubDomainRequest();
			mockListKVNamespacesRequest(kvNamespace);
			mockKeyListRequest(kvNamespace.id, []);

			let requestCount = 0;
			const bulkUrl =
				"*/accounts/:accountId/storage/kv/namespaces/:namespaceId/bulk";
			msw.use(
				http.put(bulkUrl, async ({ params }) => {
					expect(params.accountId).toEqual("some-account-id");
					expect(params.namespaceId).toEqual(kvNamespace.id);
					requestCount++;
					return HttpResponse.json(
						createFetchResult([], false, [
							{ code: 1000, message: "Whoops! Something went wrong!" },
						]),
						{ status: 500 }
					);
				})
			);

			await expect(
				runWrangler("deploy")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`[APIError: A request to the Cloudflare API (/accounts/some-account-id/storage/kv/namespaces/__test-name-workers_sites_assets-id/bulk) failed.]`
			);

			expect(requestCount).toBeLessThan(3);
			expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			 + file-0.f0d69f705d.txt (uploading new version of file-0.txt)
			 + file-1.f0d69f705d.txt (uploading new version of file-1.txt)
			 + file-2.f0d69f705d.txt (uploading new version of file-2.txt)
			 + file-3.f0d69f705d.txt (uploading new version of file-3.txt)
			 + file-4.f0d69f705d.txt (uploading new version of file-4.txt)
			 + file-5.f0d69f705d.txt (uploading new version of file-5.txt)
			 + file-6.f0d69f705d.txt (uploading new version of file-6.txt)
			 + file-7.f0d69f705d.txt (uploading new version of file-7.txt)
			 + file-8.f0d69f705d.txt (uploading new version of file-8.txt)
			Uploading 9 new assets...
			Upload failed, aborting..."
		`);
		});

		describe("should truncate diff with over 100 assets unless debug log level set", () => {
			beforeEach(() => {
				const assets = Array.from({ length: 110 }, (_, index) => ({
					filePath: `file-${`${index}`.padStart(3, "0")}.txt`,
					content: "X",
				}));

				const kvNamespace = {
					title: "__test-name-workers_sites_assets",
					id: "__test-name-workers_sites_assets-id",
				};
				writeWranglerConfig({
					main: "./index.js",
					site: {
						bucket: "assets",
					},
				});
				writeWorkerSource();
				writeAssets(assets);
				mockUploadWorkerRequest();
				mockSubDomainRequest();
				mockListKVNamespacesRequest(kvNamespace);
				mockKeyListRequest(kvNamespace.id, []);
				mockUploadAssetsToKVRequest(kvNamespace.id);
			});

			it("default log level", async () => {
				await runWrangler("deploy");
				expect(std).toMatchInlineSnapshot(`
					{
					  "debug": "",
					  "err": "",
					  "info": "Fetching list of already uploaded assets...
					Building list of assets to upload...
					 + file-000.010257e8bb.txt (uploading new version of file-000.txt)
					 + file-001.010257e8bb.txt (uploading new version of file-001.txt)
					 + file-002.010257e8bb.txt (uploading new version of file-002.txt)
					 + file-003.010257e8bb.txt (uploading new version of file-003.txt)
					 + file-004.010257e8bb.txt (uploading new version of file-004.txt)
					 + file-005.010257e8bb.txt (uploading new version of file-005.txt)
					 + file-006.010257e8bb.txt (uploading new version of file-006.txt)
					 + file-007.010257e8bb.txt (uploading new version of file-007.txt)
					 + file-008.010257e8bb.txt (uploading new version of file-008.txt)
					 + file-009.010257e8bb.txt (uploading new version of file-009.txt)
					 + file-010.010257e8bb.txt (uploading new version of file-010.txt)
					 + file-011.010257e8bb.txt (uploading new version of file-011.txt)
					 + file-012.010257e8bb.txt (uploading new version of file-012.txt)
					 + file-013.010257e8bb.txt (uploading new version of file-013.txt)
					 + file-014.010257e8bb.txt (uploading new version of file-014.txt)
					 + file-015.010257e8bb.txt (uploading new version of file-015.txt)
					 + file-016.010257e8bb.txt (uploading new version of file-016.txt)
					 + file-017.010257e8bb.txt (uploading new version of file-017.txt)
					 + file-018.010257e8bb.txt (uploading new version of file-018.txt)
					 + file-019.010257e8bb.txt (uploading new version of file-019.txt)
					 + file-020.010257e8bb.txt (uploading new version of file-020.txt)
					 + file-021.010257e8bb.txt (uploading new version of file-021.txt)
					 + file-022.010257e8bb.txt (uploading new version of file-022.txt)
					 + file-023.010257e8bb.txt (uploading new version of file-023.txt)
					 + file-024.010257e8bb.txt (uploading new version of file-024.txt)
					 + file-025.010257e8bb.txt (uploading new version of file-025.txt)
					 + file-026.010257e8bb.txt (uploading new version of file-026.txt)
					 + file-027.010257e8bb.txt (uploading new version of file-027.txt)
					 + file-028.010257e8bb.txt (uploading new version of file-028.txt)
					 + file-029.010257e8bb.txt (uploading new version of file-029.txt)
					 + file-030.010257e8bb.txt (uploading new version of file-030.txt)
					 + file-031.010257e8bb.txt (uploading new version of file-031.txt)
					 + file-032.010257e8bb.txt (uploading new version of file-032.txt)
					 + file-033.010257e8bb.txt (uploading new version of file-033.txt)
					 + file-034.010257e8bb.txt (uploading new version of file-034.txt)
					 + file-035.010257e8bb.txt (uploading new version of file-035.txt)
					 + file-036.010257e8bb.txt (uploading new version of file-036.txt)
					 + file-037.010257e8bb.txt (uploading new version of file-037.txt)
					 + file-038.010257e8bb.txt (uploading new version of file-038.txt)
					 + file-039.010257e8bb.txt (uploading new version of file-039.txt)
					 + file-040.010257e8bb.txt (uploading new version of file-040.txt)
					 + file-041.010257e8bb.txt (uploading new version of file-041.txt)
					 + file-042.010257e8bb.txt (uploading new version of file-042.txt)
					 + file-043.010257e8bb.txt (uploading new version of file-043.txt)
					 + file-044.010257e8bb.txt (uploading new version of file-044.txt)
					 + file-045.010257e8bb.txt (uploading new version of file-045.txt)
					 + file-046.010257e8bb.txt (uploading new version of file-046.txt)
					 + file-047.010257e8bb.txt (uploading new version of file-047.txt)
					 + file-048.010257e8bb.txt (uploading new version of file-048.txt)
					 + file-049.010257e8bb.txt (uploading new version of file-049.txt)
					 + file-050.010257e8bb.txt (uploading new version of file-050.txt)
					 + file-051.010257e8bb.txt (uploading new version of file-051.txt)
					 + file-052.010257e8bb.txt (uploading new version of file-052.txt)
					 + file-053.010257e8bb.txt (uploading new version of file-053.txt)
					 + file-054.010257e8bb.txt (uploading new version of file-054.txt)
					 + file-055.010257e8bb.txt (uploading new version of file-055.txt)
					 + file-056.010257e8bb.txt (uploading new version of file-056.txt)
					 + file-057.010257e8bb.txt (uploading new version of file-057.txt)
					 + file-058.010257e8bb.txt (uploading new version of file-058.txt)
					 + file-059.010257e8bb.txt (uploading new version of file-059.txt)
					 + file-060.010257e8bb.txt (uploading new version of file-060.txt)
					 + file-061.010257e8bb.txt (uploading new version of file-061.txt)
					 + file-062.010257e8bb.txt (uploading new version of file-062.txt)
					 + file-063.010257e8bb.txt (uploading new version of file-063.txt)
					 + file-064.010257e8bb.txt (uploading new version of file-064.txt)
					 + file-065.010257e8bb.txt (uploading new version of file-065.txt)
					 + file-066.010257e8bb.txt (uploading new version of file-066.txt)
					 + file-067.010257e8bb.txt (uploading new version of file-067.txt)
					 + file-068.010257e8bb.txt (uploading new version of file-068.txt)
					 + file-069.010257e8bb.txt (uploading new version of file-069.txt)
					 + file-070.010257e8bb.txt (uploading new version of file-070.txt)
					 + file-071.010257e8bb.txt (uploading new version of file-071.txt)
					 + file-072.010257e8bb.txt (uploading new version of file-072.txt)
					 + file-073.010257e8bb.txt (uploading new version of file-073.txt)
					 + file-074.010257e8bb.txt (uploading new version of file-074.txt)
					 + file-075.010257e8bb.txt (uploading new version of file-075.txt)
					 + file-076.010257e8bb.txt (uploading new version of file-076.txt)
					 + file-077.010257e8bb.txt (uploading new version of file-077.txt)
					 + file-078.010257e8bb.txt (uploading new version of file-078.txt)
					 + file-079.010257e8bb.txt (uploading new version of file-079.txt)
					 + file-080.010257e8bb.txt (uploading new version of file-080.txt)
					 + file-081.010257e8bb.txt (uploading new version of file-081.txt)
					 + file-082.010257e8bb.txt (uploading new version of file-082.txt)
					 + file-083.010257e8bb.txt (uploading new version of file-083.txt)
					 + file-084.010257e8bb.txt (uploading new version of file-084.txt)
					 + file-085.010257e8bb.txt (uploading new version of file-085.txt)
					 + file-086.010257e8bb.txt (uploading new version of file-086.txt)
					 + file-087.010257e8bb.txt (uploading new version of file-087.txt)
					 + file-088.010257e8bb.txt (uploading new version of file-088.txt)
					 + file-089.010257e8bb.txt (uploading new version of file-089.txt)
					 + file-090.010257e8bb.txt (uploading new version of file-090.txt)
					 + file-091.010257e8bb.txt (uploading new version of file-091.txt)
					 + file-092.010257e8bb.txt (uploading new version of file-092.txt)
					 + file-093.010257e8bb.txt (uploading new version of file-093.txt)
					 + file-094.010257e8bb.txt (uploading new version of file-094.txt)
					 + file-095.010257e8bb.txt (uploading new version of file-095.txt)
					 + file-096.010257e8bb.txt (uploading new version of file-096.txt)
					 + file-097.010257e8bb.txt (uploading new version of file-097.txt)
					 + file-098.010257e8bb.txt (uploading new version of file-098.txt)
					 + file-099.010257e8bb.txt (uploading new version of file-099.txt)
					   (truncating changed assets log, set \`WRANGLER_LOG=debug\` environment variable to see full diff)
					Uploading 110 new assets...
					Uploaded 100% [110 out of 110]",
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
					  "warn": "",
					}
				`);
			});

			it("debug log level", async () => {
				vi.stubEnv("WRANGLER_LOG", "debug");
				vi.stubEnv("WRANGLER_LOG_SANITIZE", "false");

				await runWrangler("deploy");

				const diffRegexp = /^ [+=-]/;
				const diff = std.debug
					.split("\n")
					.filter((line) => diffRegexp.test(line))
					.join("\n");
				expect(diff).toMatchInlineSnapshot(`
			" + file-000.010257e8bb.txt (uploading new version of file-000.txt)
			 + file-001.010257e8bb.txt (uploading new version of file-001.txt)
			 + file-002.010257e8bb.txt (uploading new version of file-002.txt)
			 + file-003.010257e8bb.txt (uploading new version of file-003.txt)
			 + file-004.010257e8bb.txt (uploading new version of file-004.txt)
			 + file-005.010257e8bb.txt (uploading new version of file-005.txt)
			 + file-006.010257e8bb.txt (uploading new version of file-006.txt)
			 + file-007.010257e8bb.txt (uploading new version of file-007.txt)
			 + file-008.010257e8bb.txt (uploading new version of file-008.txt)
			 + file-009.010257e8bb.txt (uploading new version of file-009.txt)
			 + file-010.010257e8bb.txt (uploading new version of file-010.txt)
			 + file-011.010257e8bb.txt (uploading new version of file-011.txt)
			 + file-012.010257e8bb.txt (uploading new version of file-012.txt)
			 + file-013.010257e8bb.txt (uploading new version of file-013.txt)
			 + file-014.010257e8bb.txt (uploading new version of file-014.txt)
			 + file-015.010257e8bb.txt (uploading new version of file-015.txt)
			 + file-016.010257e8bb.txt (uploading new version of file-016.txt)
			 + file-017.010257e8bb.txt (uploading new version of file-017.txt)
			 + file-018.010257e8bb.txt (uploading new version of file-018.txt)
			 + file-019.010257e8bb.txt (uploading new version of file-019.txt)
			 + file-020.010257e8bb.txt (uploading new version of file-020.txt)
			 + file-021.010257e8bb.txt (uploading new version of file-021.txt)
			 + file-022.010257e8bb.txt (uploading new version of file-022.txt)
			 + file-023.010257e8bb.txt (uploading new version of file-023.txt)
			 + file-024.010257e8bb.txt (uploading new version of file-024.txt)
			 + file-025.010257e8bb.txt (uploading new version of file-025.txt)
			 + file-026.010257e8bb.txt (uploading new version of file-026.txt)
			 + file-027.010257e8bb.txt (uploading new version of file-027.txt)
			 + file-028.010257e8bb.txt (uploading new version of file-028.txt)
			 + file-029.010257e8bb.txt (uploading new version of file-029.txt)
			 + file-030.010257e8bb.txt (uploading new version of file-030.txt)
			 + file-031.010257e8bb.txt (uploading new version of file-031.txt)
			 + file-032.010257e8bb.txt (uploading new version of file-032.txt)
			 + file-033.010257e8bb.txt (uploading new version of file-033.txt)
			 + file-034.010257e8bb.txt (uploading new version of file-034.txt)
			 + file-035.010257e8bb.txt (uploading new version of file-035.txt)
			 + file-036.010257e8bb.txt (uploading new version of file-036.txt)
			 + file-037.010257e8bb.txt (uploading new version of file-037.txt)
			 + file-038.010257e8bb.txt (uploading new version of file-038.txt)
			 + file-039.010257e8bb.txt (uploading new version of file-039.txt)
			 + file-040.010257e8bb.txt (uploading new version of file-040.txt)
			 + file-041.010257e8bb.txt (uploading new version of file-041.txt)
			 + file-042.010257e8bb.txt (uploading new version of file-042.txt)
			 + file-043.010257e8bb.txt (uploading new version of file-043.txt)
			 + file-044.010257e8bb.txt (uploading new version of file-044.txt)
			 + file-045.010257e8bb.txt (uploading new version of file-045.txt)
			 + file-046.010257e8bb.txt (uploading new version of file-046.txt)
			 + file-047.010257e8bb.txt (uploading new version of file-047.txt)
			 + file-048.010257e8bb.txt (uploading new version of file-048.txt)
			 + file-049.010257e8bb.txt (uploading new version of file-049.txt)
			 + file-050.010257e8bb.txt (uploading new version of file-050.txt)
			 + file-051.010257e8bb.txt (uploading new version of file-051.txt)
			 + file-052.010257e8bb.txt (uploading new version of file-052.txt)
			 + file-053.010257e8bb.txt (uploading new version of file-053.txt)
			 + file-054.010257e8bb.txt (uploading new version of file-054.txt)
			 + file-055.010257e8bb.txt (uploading new version of file-055.txt)
			 + file-056.010257e8bb.txt (uploading new version of file-056.txt)
			 + file-057.010257e8bb.txt (uploading new version of file-057.txt)
			 + file-058.010257e8bb.txt (uploading new version of file-058.txt)
			 + file-059.010257e8bb.txt (uploading new version of file-059.txt)
			 + file-060.010257e8bb.txt (uploading new version of file-060.txt)
			 + file-061.010257e8bb.txt (uploading new version of file-061.txt)
			 + file-062.010257e8bb.txt (uploading new version of file-062.txt)
			 + file-063.010257e8bb.txt (uploading new version of file-063.txt)
			 + file-064.010257e8bb.txt (uploading new version of file-064.txt)
			 + file-065.010257e8bb.txt (uploading new version of file-065.txt)
			 + file-066.010257e8bb.txt (uploading new version of file-066.txt)
			 + file-067.010257e8bb.txt (uploading new version of file-067.txt)
			 + file-068.010257e8bb.txt (uploading new version of file-068.txt)
			 + file-069.010257e8bb.txt (uploading new version of file-069.txt)
			 + file-070.010257e8bb.txt (uploading new version of file-070.txt)
			 + file-071.010257e8bb.txt (uploading new version of file-071.txt)
			 + file-072.010257e8bb.txt (uploading new version of file-072.txt)
			 + file-073.010257e8bb.txt (uploading new version of file-073.txt)
			 + file-074.010257e8bb.txt (uploading new version of file-074.txt)
			 + file-075.010257e8bb.txt (uploading new version of file-075.txt)
			 + file-076.010257e8bb.txt (uploading new version of file-076.txt)
			 + file-077.010257e8bb.txt (uploading new version of file-077.txt)
			 + file-078.010257e8bb.txt (uploading new version of file-078.txt)
			 + file-079.010257e8bb.txt (uploading new version of file-079.txt)
			 + file-080.010257e8bb.txt (uploading new version of file-080.txt)
			 + file-081.010257e8bb.txt (uploading new version of file-081.txt)
			 + file-082.010257e8bb.txt (uploading new version of file-082.txt)
			 + file-083.010257e8bb.txt (uploading new version of file-083.txt)
			 + file-084.010257e8bb.txt (uploading new version of file-084.txt)
			 + file-085.010257e8bb.txt (uploading new version of file-085.txt)
			 + file-086.010257e8bb.txt (uploading new version of file-086.txt)
			 + file-087.010257e8bb.txt (uploading new version of file-087.txt)
			 + file-088.010257e8bb.txt (uploading new version of file-088.txt)
			 + file-089.010257e8bb.txt (uploading new version of file-089.txt)
			 + file-090.010257e8bb.txt (uploading new version of file-090.txt)
			 + file-091.010257e8bb.txt (uploading new version of file-091.txt)
			 + file-092.010257e8bb.txt (uploading new version of file-092.txt)
			 + file-093.010257e8bb.txt (uploading new version of file-093.txt)
			 + file-094.010257e8bb.txt (uploading new version of file-094.txt)
			 + file-095.010257e8bb.txt (uploading new version of file-095.txt)
			 + file-096.010257e8bb.txt (uploading new version of file-096.txt)
			 + file-097.010257e8bb.txt (uploading new version of file-097.txt)
			 + file-098.010257e8bb.txt (uploading new version of file-098.txt)
			 + file-099.010257e8bb.txt (uploading new version of file-099.txt)
			 + file-100.010257e8bb.txt (uploading new version of file-100.txt)
			 + file-101.010257e8bb.txt (uploading new version of file-101.txt)
			 + file-102.010257e8bb.txt (uploading new version of file-102.txt)
			 + file-103.010257e8bb.txt (uploading new version of file-103.txt)
			 + file-104.010257e8bb.txt (uploading new version of file-104.txt)
			 + file-105.010257e8bb.txt (uploading new version of file-105.txt)
			 + file-106.010257e8bb.txt (uploading new version of file-106.txt)
			 + file-107.010257e8bb.txt (uploading new version of file-107.txt)
			 + file-108.010257e8bb.txt (uploading new version of file-108.txt)
			 + file-109.010257e8bb.txt (uploading new version of file-109.txt)"
		`);
				expect(std.info).toMatchInlineSnapshot(`
			"Fetching list of already uploaded assets...
			Building list of assets to upload...
			Uploading 110 new assets...
			Uploaded 100% [110 out of 110]"
		`);
			});
		});
	});

	describe("assets", () => {
		it("should use the directory specified in the CLI over wrangler.toml", async () => {
			const cliAssets = [
				{ filePath: "cliAsset.txt", content: "Content of file-1" },
			];
			writeAssets(cliAssets, "cli-assets");
			const configAssets = [
				{ filePath: "configAsset.txt", content: "Content of file-2" },
			];
			writeAssets(configAssets, "config-assets");
			writeWranglerConfig({
				assets: { directory: "config-assets" },
			});
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy --assets cli-assets");
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toEqual({
				manifest: {
					"/cliAsset.txt": {
						hash: "0de3dd5df907418e9730fd2bd747bd5e",
						size: 17,
					},
				},
			});
		});

		it("should use the directory specified in the CLI and allow the directory to be missing in the configuration", async () => {
			const cliAssets = [
				{ filePath: "cliAsset.txt", content: "Content of file-1" },
			];
			writeAssets(cliAssets, "cli-assets");
			writeWranglerConfig({
				assets: {},
			});
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy --assets cli-assets");
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toEqual({
				manifest: {
					"/cliAsset.txt": {
						hash: "0de3dd5df907418e9730fd2bd747bd5e",
						size: 17,
					},
				},
			});
		});

		it("should error if config.site and config.assets are used together", async () => {
			writeWranglerConfig({
				main: "./index.js",
				assets: { directory: "abd" },
				site: {
					bucket: "xyz",
				},
			});
			writeWorkerSource();
			await expect(
				runWrangler("deploy")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				dedent`[Error: Cannot use assets and Workers Sites in the same Worker.
				Please remove either the \`site\` or \`assets\` field from your configuration file.]`
			);
		});

		it("should error if --assets and config.site are used together", async () => {
			writeWranglerConfig({
				main: "./index.js",
				site: {
					bucket: "xyz",
				},
			});
			writeWorkerSource();
			await expect(
				runWrangler("deploy --assets abc")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				dedent`[Error: Cannot use assets and Workers Sites in the same Worker.
				Please remove either the \`site\` or \`assets\` field from your configuration file.]`
			);
		});

		it("should error if directory specified by flag --assets does not exist in non-interactive mode", async () => {
			setIsTTY(false);
			await expect(runWrangler("deploy --assets abc")).rejects.toThrow(
				new RegExp(
					'^The directory specified by the "--assets" command line argument does not exist:[Ss]*'
				)
			);
		});

		it("should error if the directory path specified by the assets config is undefined", async () => {
			writeWranglerConfig({
				assets: {},
			});
			await expect(
				runWrangler("deploy")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`[Error: The \`assets\` property in your configuration is missing the required \`directory\` property.]`
			);
		});

		it("should error if the directory path specified by the assets config is an empty string", async () => {
			writeWranglerConfig({
				assets: { directory: "" },
			});
			await expect(
				runWrangler("deploy")
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`[Error: \`The assets directory cannot be an empty string.]`
			);
		});

		it("should error if directory specified by config assets does not exist", async () => {
			writeWranglerConfig({
				assets: { directory: "abc" },
			});
			await expect(runWrangler("deploy")).rejects.toThrow(
				new RegExp(
					'^The directory specified by the "assets.directory" field in your configuration file does not exist:[Ss]*'
				)
			);
		});

		it("should error if an ASSET binding is provided without a user Worker", async () => {
			writeWranglerConfig({
				assets: {
					directory: "xyz",
					binding: "ASSET",
				},
			});
			await expect(runWrangler("deploy")).rejects
				.toThrowErrorMatchingInlineSnapshot(`
				[Error: Cannot use assets with a binding in an assets-only Worker.
				Please remove the asset binding from your configuration file, or provide a Worker script in your configuration file (\`main\`).]
			`);
		});

		it("should warn when using smart placement with Worker first", async () => {
			const assets = [
				{ filePath: ".assetsignore", content: "*.bak\nsub-dir" },
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.bak", content: "Content of file-2" },
				{ filePath: "file-3.txt", content: "Content of file-3" },
				{ filePath: "sub-dir/file-4.bak", content: "Content of file-4" },
				{ filePath: "sub-dir/file-5.txt", content: "Content of file-5" },
			];
			writeAssets(assets, "assets");
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				main: "index.js",
				assets: {
					directory: "assets",
					run_worker_first: true,
					binding: "ASSETS",
				},
				placement: {
					mode: "smart",
				},
			});
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {
						run_worker_first: true,
					},
				},
				expectedMainModule: "index.js",
				expectedBindings: [{ name: "ASSETS", type: "assets" }],
			});

			await runWrangler("deploy");

			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mTurning on Smart Placement in a Worker that is using assets and run_worker_first set to true means that your entire Worker could be moved to run closer to your data source, and all requests will go to that Worker before serving assets.[0m

				  This could result in poor performance as round trip times could increase when serving assets.

				  Read more: [4mhttps://developers.cloudflare.com/workers/static-assets/binding/#smart-placement[0m

				"
			`);
		});

		it("should warn if run_worker_first=true but no binding is provided", async () => {
			const assets = [
				{ filePath: ".assetsignore", content: "*.bak\nsub-dir" },
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.bak", content: "Content of file-2" },
				{ filePath: "file-3.txt", content: "Content of file-3" },
				{ filePath: "sub-dir/file-4.bak", content: "Content of file-4" },
				{ filePath: "sub-dir/file-5.txt", content: "Content of file-5" },
			];
			writeAssets(assets, "assets");
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				main: "index.js",
				assets: {
					directory: "assets",
					run_worker_first: true,
				},
			});
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {
						run_worker_first: true,
					},
				},
				expectedMainModule: "index.js",
			});

			await runWrangler("deploy");

			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mrun_worker_first=true set without an assets binding[0m

				  Setting run_worker_first to true will always invoke your Worker script.
				  To fetch your assets from your Worker, please set the [assets.binding] key in your configuration
				  file.

				  Read more: [4mhttps://developers.cloudflare.com/workers/static-assets/binding/#binding[0m

				"
			`);
		});

		it("should error if run_worker_first is true and no user Worker is provided", async () => {
			const assets = [
				{ filePath: ".assetsignore", content: "*.bak\nsub-dir" },
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.bak", content: "Content of file-2" },
				{ filePath: "file-3.txt", content: "Content of file-3" },
				{ filePath: "sub-dir/file-4.bak", content: "Content of file-4" },
				{ filePath: "sub-dir/file-5.txt", content: "Content of file-5" },
			];
			writeAssets(assets, "assets");
			writeWranglerConfig({
				assets: {
					directory: "assets",
					run_worker_first: true,
				},
			});

			await expect(runWrangler("deploy")).rejects
				.toThrowErrorMatchingInlineSnapshot(`
				[Error: Cannot set run_worker_first without a Worker script.
				Please remove run_worker_first from your configuration file, or provide a Worker script in your configuration file (\`main\`).]
			`);
		});

		it("should attach an 'application/null' content-type header when uploading files with an unknown extension", async () => {
			const assets = [{ filePath: "foobar.greg", content: "something-binary" }];
			writeAssets(assets);
			writeWranglerConfig({
				assets: { directory: "assets" },
			});

			const manifestBodies: AssetManifest[] = [];
			const mockBuckets = [["80e40c1f2422528cb2fba3f9389ce315"]];
			await mockAUSRequest(manifestBodies, mockBuckets, "<<aus-token>>");
			const uploadBodies: FormData[] = [];
			const uploadAuthHeaders: (string | null)[] = [];
			const uploadContentTypeHeaders: (string | null)[] = [];
			await mockAssetUploadRequest(
				mockBuckets.length,
				uploadBodies,
				uploadAuthHeaders,
				uploadContentTypeHeaders
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy");
			expect(manifestBodies.length).toBe(1);
			expect(manifestBodies[0]).toEqual({
				manifest: {
					"/foobar.greg": {
						hash: "80e40c1f2422528cb2fba3f9389ce315",
						size: 16,
					},
				},
			});
			const flatBodies = Object.fromEntries(
				uploadBodies.flatMap((b) => [...b.entries()])
			);
			await expect(
				flatBodies["80e40c1f2422528cb2fba3f9389ce315"]
			).toBeAFileWhichMatches({
				fileBits: ["c29tZXRoaW5nLWJpbmFyeQ=="],
				name: "80e40c1f2422528cb2fba3f9389ce315",
				type: "application/null",
			});
		});

		it("should be able to upload files with special characters in filepaths", async () => {
			// NB windows will disallow these characters in file paths anyway < > : " / \ | ? *
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file#1.txt", content: "Content of file-2" },
				{ filePath: "béëp/boo^p.txt", content: "Content of file-3" },
			];
			writeAssets(assets);
			writeWranglerConfig({
				assets: { directory: "assets" },
			});

			const manifestBodies: AssetManifest[] = [];
			const mockBuckets = [
				[
					"ff5016e92f039aa743a4ff7abb3180fa",
					"7574a8cd3094a050388ac9663af1c1d6",
					"0de3dd5df907418e9730fd2bd747bd5e",
				],
			];
			await mockAUSRequest(manifestBodies, mockBuckets, "<<aus-token>>");
			const uploadBodies: FormData[] = [];
			const uploadAuthHeaders: (string | null)[] = [];
			const uploadContentTypeHeaders: (string | null)[] = [];
			await mockAssetUploadRequest(
				mockBuckets.length,
				uploadBodies,
				uploadContentTypeHeaders,
				uploadAuthHeaders
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy");
			expect(manifestBodies.length).toBe(1);
			expect(manifestBodies[0]).toEqual({
				manifest: {
					"/béëp/boo^p.txt": {
						hash: "ff5016e92f039aa743a4ff7abb3180fa",
						size: 17,
					},
					"/boop/file#1.txt": {
						hash: "7574a8cd3094a050388ac9663af1c1d6",
						size: 17,
					},
					"/file-1.txt": {
						hash: "0de3dd5df907418e9730fd2bd747bd5e",
						size: 17,
					},
				},
			});
			const flatBodies = Object.fromEntries(
				uploadBodies.flatMap((b) => [...b.entries()])
			);
			await expect(
				flatBodies["ff5016e92f039aa743a4ff7abb3180fa"]
			).toBeAFileWhichMatches({
				fileBits: ["Q29udGVudCBvZiBmaWxlLTM="],
				name: "ff5016e92f039aa743a4ff7abb3180fa",
				type: "text/plain",
			});
			await expect(
				flatBodies["7574a8cd3094a050388ac9663af1c1d6"]
			).toBeAFileWhichMatches({
				fileBits: ["Q29udGVudCBvZiBmaWxlLTI="],
				name: "7574a8cd3094a050388ac9663af1c1d6",
				type: "text/plain",
			});
			await expect(
				flatBodies["0de3dd5df907418e9730fd2bd747bd5e"]
			).toBeAFileWhichMatches({
				fileBits: ["Q29udGVudCBvZiBmaWxlLTE="],
				name: "0de3dd5df907418e9730fd2bd747bd5e",
				type: "text/plain",
			});
		});

		it("should resolve assets directory relative to wrangler.toml if using config", async () => {
			const assets = [{ filePath: "file-1.txt", content: "Content of file-1" }];
			writeAssets(assets, "some/path/assets");
			writeWranglerConfig(
				{
					assets: { directory: "assets" },
				},
				"some/path/wrangler.toml"
			);
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy --config some/path/wrangler.toml");
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toEqual({
				manifest: {
					"/file-1.txt": {
						hash: "0de3dd5df907418e9730fd2bd747bd5e",
						size: 17,
					},
				},
			});
		});

		it("should ignore assets that match patterns in an .assetsignore file in the root of the assets directory", async () => {
			const redirectsContent = "/foo /bar";
			const headersContent = "/some-path\nX-Header: Custom-Value";
			const assets = [
				{ filePath: ".assetsignore", content: "*.bak\nsub-dir" },
				{ filePath: "_redirects", content: redirectsContent },
				{ filePath: "_headers", content: headersContent },
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "file-2.bak", content: "Content of file-2" },
				{ filePath: "file-3.txt", content: "Content of file-3" },
				{ filePath: "sub-dir/file-4.bak", content: "Content of file-4" },
				{ filePath: "sub-dir/file-5.txt", content: "Content of file-5" },
			];
			writeAssets(assets, "some/path/assets");
			writeWranglerConfig(
				{
					assets: { directory: "assets" },
				},
				"some/path/wrangler.toml"
			);
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {
						_headers: headersContent,
						_redirects: redirectsContent,
					},
				},
				expectedType: "none",
			});
			await runWrangler("deploy --config some/path/wrangler.toml");
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toMatchInlineSnapshot(`
				{
				  "manifest": {
				    "/file-1.txt": {
				      "hash": "0de3dd5df907418e9730fd2bd747bd5e",
				      "size": 17,
				    },
				    "/file-3.txt": {
				      "hash": "ff5016e92f039aa743a4ff7abb3180fa",
				      "size": 17,
				    },
				  },
				}
			`);
		});

		it("should error if it is going to upload a _worker.js file as an asset", async () => {
			const assets = [
				{ filePath: "_worker.js", content: "// some secret server-side code." },
			];
			writeAssets(assets, "some/path/assets");
			writeWranglerConfig(
				{
					assets: { directory: "assets" },
				},
				"some/path/wrangler.toml"
			);
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await expect(runWrangler("deploy --config some/path/wrangler.toml"))
				.rejects.toThrowErrorMatchingInlineSnapshot(`
				[Error: Uploading a Pages _worker.js file as an asset.
				This could expose your private server-side code to the public Internet. Is this intended?
				If you do not want to upload this file, either remove it or add an ".assetsignore" file, to the root of your asset directory, containing "_worker.js" to avoid uploading.
				If you do want to upload this file, you can add an empty ".assetsignore" file, to the root of your asset directory, to hide this error.]
			`);
		});

		it("should error if it is going to upload a _worker.js directory as an asset", async () => {
			const assets = [
				{
					filePath: "_worker.js/index.js",
					content: "// some secret server-side code.",
				},
				{
					filePath: "_worker.js/dep.js",
					content: "// some secret server-side code.",
				},
			];
			writeAssets(assets, "some/path/assets");
			writeWranglerConfig(
				{
					assets: { directory: "assets" },
				},
				"some/path/wrangler.toml"
			);
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await expect(runWrangler("deploy --config some/path/wrangler.toml"))
				.rejects.toThrowErrorMatchingInlineSnapshot(`
				[Error: Uploading a Pages _worker.js directory as an asset.
				This could expose your private server-side code to the public Internet. Is this intended?
				If you do not want to upload this directory, either remove it or add an ".assetsignore" file, to the root of your asset directory, containing "_worker.js" to avoid uploading.
				If you do want to upload this directory, you can add an empty ".assetsignore" file, to the root of your asset directory, to hide this error.]
			`);
		});

		it("should not error if it is going to upload a _worker.js file as an asset and there is an .assetsignore file", async () => {
			const assets = [
				{ filePath: ".assetsignore", content: "" },
				{ filePath: "_worker.js", content: "// some secret server-side code." },
			];
			writeAssets(assets, "some/path/assets");
			writeWranglerConfig(
				{
					assets: { directory: "assets" },
				},
				"some/path/wrangler.toml"
			);
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy --config some/path/wrangler.toml");
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toMatchInlineSnapshot(`
				{
				  "manifest": {
				    "/_worker.js": {
				      "hash": "266570622a24a5fb8913d53fd3ac8562",
				      "size": 32,
				    },
				  },
				}
			`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should not error if it is going to upload a _worker.js file that is not at the root of the asset directory", async () => {
			const assets = [
				{
					filePath: "foo/_worker.js",
					content: "// some secret server-side code.",
				},
			];
			writeAssets(assets, "some/path/assets");
			writeWranglerConfig(
				{
					assets: { directory: "assets" },
				},
				"some/path/wrangler.toml"
			);
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy --config some/path/wrangler.toml");
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toMatchInlineSnapshot(`
				{
				  "manifest": {
				    "/foo/_worker.js": {
				      "hash": "266570622a24a5fb8913d53fd3ac8562",
				      "size": 32,
				    },
				  },
				}
			`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should upload _redirects and _headers", async () => {
			const redirectsContent = "/foo /bar";
			const headersContent = "/some-path\nX-Header: Custom-Value";
			const assets = [
				{ filePath: "_redirects", content: redirectsContent },
				{ filePath: "_headers", content: headersContent },
				{ filePath: "index.html", content: "<html></html>" },
			];
			writeAssets(assets);
			writeWranglerConfig({
				assets: { directory: "assets" },
			});
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {
						_redirects: redirectsContent,
						_headers: headersContent,
					},
				},
				expectedType: "none",
			});
			await runWrangler("deploy");
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toMatchInlineSnapshot(`
				{
				  "manifest": {
				    "/index.html": {
				      "hash": "4752155c2c0c0320b40bca1d83e8380a",
				      "size": 13,
				    },
				  },
				}
			`);
		});

		it("should resolve assets directory relative to cwd if using cli", async () => {
			const assets = [{ filePath: "file-1.txt", content: "Content of file-1" }];
			writeAssets(assets, "some/path/assets");
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			process.chdir("some/path");
			await runWrangler(
				"deploy --name test-name --compatibility-date 2024-07-31 --assets assets"
			);
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toEqual({
				manifest: {
					"/file-1.txt": {
						hash: "0de3dd5df907418e9730fd2bd747bd5e",
						size: 17,
					},
				},
			});
		});

		it("should upload an asset manifest of the files in the directory specified by --assets", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			// skips asset uploading since empty buckets returned
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler(
				"deploy --name test-name --compatibility-date 2024-07-31 --assets assets"
			);
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toStrictEqual({
				manifest: {
					"/file-1.txt": {
						hash: "0de3dd5df907418e9730fd2bd747bd5e",
						size: 17,
					},
					"/boop/file-2.txt": {
						hash: "7574a8cd3094a050388ac9663af1c1d6",
						size: 17,
					},
				},
			});
		});

		it("should upload an asset manifest of the files in the directory specified by [assets] config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			writeWranglerConfig({
				assets: { directory: "assets" },
			});
			const bodies: AssetManifest[] = [];
			await mockAUSRequest(bodies);
			// skips asset uploading since empty buckets returned
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy");
			expect(bodies.length).toBe(1);
			expect(bodies[0]).toStrictEqual({
				manifest: {
					"/file-1.txt": {
						hash: "0de3dd5df907418e9730fd2bd747bd5e",
						size: 17,
					},
					"/boop/file-2.txt": {
						hash: "7574a8cd3094a050388ac9663af1c1d6",
						size: 17,
					},
				},
			});
		});

		it("should upload assets in the requested buckets", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
				{ filePath: "boop/file-3.txt", content: "Content of file-3" },
				{ filePath: "file-4.txt", content: "Content of file-4" },
				{ filePath: "beep/file-5.txt", content: "Content of file-5" },
				{
					filePath: "beep/boop/beep/boop/file-6.txt",
					content: "Content of file-6",
				},
			];
			writeAssets(assets);
			writeWranglerConfig({
				assets: { directory: "assets" },
			});
			const mockBuckets = [
				[
					"0de3dd5df907418e9730fd2bd747bd5e",
					"7574a8cd3094a050388ac9663af1c1d6",
				],
				["ff5016e92f039aa743a4ff7abb3180fa"],
				["f05e28a3d0bdb90d3cf4bdafe592488f"],
				["0de3dd5df907418e9730fd2bd747bd5e"],
			];
			await mockAUSRequest([], mockBuckets, "<<aus-token>>");
			const bodies: FormData[] = [];
			const uploadAuthHeaders: (string | null)[] = [];
			const uploadContentTypeHeaders: (string | null)[] = [];
			await mockAssetUploadRequest(
				mockBuckets.length,
				bodies,
				uploadContentTypeHeaders,
				uploadAuthHeaders
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {},
				},
				expectedType: "none",
			});
			await runWrangler("deploy");
			expect(uploadAuthHeaders).toStrictEqual([
				"Bearer <<aus-token>>",
				"Bearer <<aus-token>>",
				"Bearer <<aus-token>>",
				"Bearer <<aus-token>>",
			]);
			for (const uploadContentTypeHeader of uploadContentTypeHeaders) {
				expect(uploadContentTypeHeader).toMatch(/multipart\/form-data/);
			}

			expect(
				bodies
					.map((b) => [...b.entries()])
					.map((entry) => entry.length)
					.sort()
			).toEqual([1, 1, 1, 2]);

			const flatBodies = Object.fromEntries(
				bodies.flatMap((b) => [...b.entries()])
			);

			await expect(
				flatBodies["0de3dd5df907418e9730fd2bd747bd5e"]
			).toBeAFileWhichMatches({
				fileBits: ["Q29udGVudCBvZiBmaWxlLTE="],
				name: "0de3dd5df907418e9730fd2bd747bd5e",
				type: "text/plain",
			});
			await expect(
				flatBodies["7574a8cd3094a050388ac9663af1c1d6"]
			).toBeAFileWhichMatches({
				fileBits: ["Q29udGVudCBvZiBmaWxlLTI="],
				name: "7574a8cd3094a050388ac9663af1c1d6",
				type: "text/plain",
			});
			await expect(
				flatBodies["ff5016e92f039aa743a4ff7abb3180fa"]
			).toBeAFileWhichMatches({
				fileBits: ["Q29udGVudCBvZiBmaWxlLTM="],
				name: "ff5016e92f039aa743a4ff7abb3180fa",
				type: "text/plain",
			});
			await expect(
				flatBodies["f05e28a3d0bdb90d3cf4bdafe592488f"]
			).toBeAFileWhichMatches({
				fileBits: ["Q29udGVudCBvZiBmaWxlLTU="],
				name: "f05e28a3d0bdb90d3cf4bdafe592488f",
				type: "text/plain",
			});
		});

		it("should be able to upload a user worker with ASSETS binding and config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				main: "index.js",
				compatibility_date: "2024-09-27",
				compatibility_flags: ["nodejs_compat"],
				assets: {
					directory: "assets",
					binding: "ASSETS",
					html_handling: "none",
					not_found_handling: "404-page",
				},
			});
			await mockAUSRequest();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: { html_handling: "none", not_found_handling: "404-page" },
				},
				expectedBindings: [{ name: "ASSETS", type: "assets" }],
				expectedMainModule: "index.js",
				expectedCompatibilityDate: "2024-09-27",
				expectedCompatibilityFlags: ["nodejs_compat"],
			});
			await runWrangler("deploy");
		});

		it("run_worker_first correctly overrides default if set to true", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				main: "index.js",
				compatibility_date: "2024-09-27",
				compatibility_flags: ["nodejs_compat"],
				assets: {
					directory: "assets",
					binding: "ASSETS",
					html_handling: "none",
					not_found_handling: "404-page",
					run_worker_first: true,
				},
			});
			await mockAUSRequest();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {
						html_handling: "none",
						not_found_handling: "404-page",
						run_worker_first: true,
					},
				},
				expectedBindings: [{ name: "ASSETS", type: "assets" }],
				expectedMainModule: "index.js",
				expectedCompatibilityDate: "2024-09-27",
				expectedCompatibilityFlags: ["nodejs_compat"],
			});
			await runWrangler("deploy");
		});

		it("uploads run_worker_first=true when provided in config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				main: "index.js",
				compatibility_date: "2024-09-27",
				compatibility_flags: ["nodejs_compat"],
				assets: {
					directory: "assets",
					binding: "ASSETS",
					html_handling: "none",
					not_found_handling: "404-page",
					run_worker_first: true,
				},
			});
			await mockAUSRequest();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {
						html_handling: "none",
						not_found_handling: "404-page",
						run_worker_first: true,
					},
				},
				expectedBindings: [{ name: "ASSETS", type: "assets" }],
				expectedMainModule: "index.js",
				expectedCompatibilityDate: "2024-09-27",
				expectedCompatibilityFlags: ["nodejs_compat"],
			});
			await runWrangler("deploy");
		});

		it("uploads run_worker_first=[rules] when provided in config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				main: "index.js",
				compatibility_date: "2024-09-27",
				compatibility_flags: ["nodejs_compat"],
				assets: {
					directory: "assets",
					binding: "ASSETS",
					html_handling: "none",
					not_found_handling: "404-page",
					run_worker_first: ["/api", "!/api/asset"],
				},
			});
			await mockAUSRequest();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {
						html_handling: "none",
						not_found_handling: "404-page",
						run_worker_first: ["/api", "!/api/asset"],
					},
				},
				expectedBindings: [{ name: "ASSETS", type: "assets" }],
				expectedMainModule: "index.js",
				expectedCompatibilityDate: "2024-09-27",
				expectedCompatibilityFlags: ["nodejs_compat"],
			});
			await runWrangler("deploy");
		});

		it("run_worker_first omitted when not provided in config", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				main: "index.js",
				compatibility_date: "2024-09-27",
				compatibility_flags: ["nodejs_compat"],
				assets: {
					directory: "assets",
					binding: "ASSETS",
					html_handling: "none",
					not_found_handling: "404-page",
				},
			});
			await mockAUSRequest();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: {
						html_handling: "none",
						not_found_handling: "404-page",
					},
				},
				expectedBindings: [{ name: "ASSETS", type: "assets" }],
				expectedMainModule: "index.js",
				expectedCompatibilityDate: "2024-09-27",
				expectedCompatibilityFlags: ["nodejs_compat"],
			});
			await runWrangler("deploy");
		});

		it("should be able to upload an asset-only project", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				compatibility_date: "2024-09-27",
				compatibility_flags: ["nodejs_compat"],
				assets: {
					directory: "assets",
					html_handling: "none",
				},
			});
			await mockAUSRequest();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: { html_handling: "none" },
				},
				expectedCompatibilityDate: "2024-09-27",
				expectedCompatibilityFlags: ["nodejs_compat"],
				expectedMainModule: undefined,
			});
			await runWrangler("deploy");
		});

		it("should be able to upload to a WfP script", async () => {
			const assets = [
				{ filePath: "file-1.txt", content: "Content of file-1" },
				{ filePath: "boop/file-2.txt", content: "Content of file-2" },
			];
			writeAssets(assets);
			writeWorkerSource({ format: "js" });
			writeWranglerConfig({
				compatibility_date: "2024-09-27",
				compatibility_flags: ["nodejs_compat"],
				assets: {
					directory: "assets",
					html_handling: "none",
				},
			});
			await mockAUSRequest(undefined, undefined, undefined, "my-namespace");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAssets: {
					jwt: "<<aus-completion-token>>",
					config: { html_handling: "none" },
				},
				expectedCompatibilityDate: "2024-09-27",
				expectedCompatibilityFlags: ["nodejs_compat"],
				expectedMainModule: undefined,
				expectedDispatchNamespace: "my-namespace",
			});
			await runWrangler("deploy --dispatch-namespace my-namespace");
		});
	});

});
