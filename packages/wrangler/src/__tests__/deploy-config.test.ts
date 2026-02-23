import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { APIError } from "@cloudflare/workers-utils";
import {
	normalizeString,
	writeRedirectedWranglerConfig,
	writeWranglerConfig,
} from "@cloudflare/workers-utils/test-helpers";
import { http, HttpResponse } from "msw";
import dedent from "ts-dedent";
/* eslint-disable workers-sdk/no-vitest-import-expect -- large file with .each and custom matchers */
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
/* eslint-enable workers-sdk/no-vitest-import-expect */
import { getDetailsForAutoConfig } from "../autoconfig/details";
import { Static } from "../autoconfig/frameworks/static";
import { getInstalledPackageVersion } from "../autoconfig/frameworks/utils/packages";
import { runAutoConfig } from "../autoconfig/run";
import { clearOutputFilePath } from "../output";
import { NpmPackageManager } from "../package-manager";
import { fetchSecrets } from "../utils/fetch-secrets";
import {
	mockAUSRequest,
	mockDeploymentsListRequest,
	mockGetScriptWithTags,
	mockGetServiceBindings,
	mockGetServiceByName,
	mockGetServiceCustomDomainRecords,
	mockGetServiceMetadata,
	mockGetServiceRoutes,
	mockGetServiceSchedules,
	mockGetServiceSubDomainData,
	mockLastDeploymentRequest,
	mockPatchScriptSettings,
} from "./deploy-test-utils";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import { mockConsoleMethods } from "./helpers/mock-console";
import { clearDialogs, mockConfirm } from "./helpers/mock-dialogs";
import { useMockIsTTY } from "./helpers/mock-istty";
import { mockUploadWorkerRequest } from "./helpers/mock-upload-worker";
import { mockGetSettings } from "./helpers/mock-worker-settings";
import {
	mockGetWorkerSubdomain,
	mockSubDomainRequest,
} from "./helpers/mock-workers-subdomain";
import {
	createFetchResult,
	msw,
	mswSuccessDeploymentScriptAPI,
} from "./helpers/msw";
import { mswListNewDeploymentsLatestFull } from "./helpers/msw/handlers/versions";
import { runInTempDir } from "./helpers/run-in-tmp";
import { runWrangler } from "./helpers/run-wrangler";
import { writeWorkerSource } from "./helpers/write-worker-source";
import type { OutputEntry } from "../output";
import type { ServiceMetadataRes } from "@cloudflare/workers-utils";
import type { MockInstance } from "vitest";

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

	describe("compliance region support", () => {
		it("should upload to the public region by default", async () => {
			writeWranglerConfig({});
			writeWorkerSource();
			mockUploadWorkerRequest({
				expectedBaseUrl: "api.cloudflare.com",
			});
			mockSubDomainRequest();
			mockGetWorkerSubdomain({ enabled: true });

			await runWrangler("deploy ./index.js");
		});

		it("should upload to the FedRAMP High region if set in config", async () => {
			writeWranglerConfig({
				compliance_region: "fedramp_high",
			});
			writeWorkerSource();
			mockUploadWorkerRequest({
				expectedBaseUrl: "api.fed.cloudflare.com",
			});
			mockSubDomainRequest();
			mockGetWorkerSubdomain({ enabled: true });

			await runWrangler("deploy ./index.js");
		});

		it("should upload to the FedRAMP High region if set in an env var", async () => {
			vi.stubEnv("CLOUDFLARE_COMPLIANCE_REGION", "fedramp_high");
			writeWranglerConfig({});
			writeWorkerSource();
			mockUploadWorkerRequest({
				expectedBaseUrl: "api.fed.cloudflare.com",
			});
			mockSubDomainRequest();
			mockGetWorkerSubdomain({ enabled: true });

			await runWrangler("deploy ./index.js");
		});

		it("should error if the region is set in both env var and configured, and they conflict", async () => {
			vi.stubEnv("CLOUDFLARE_COMPLIANCE_REGION", "public");
			writeWranglerConfig({ compliance_region: "fedramp_high" });
			writeWorkerSource();

			await expect(runWrangler("deploy ./index.js")).rejects
				.toThrowErrorMatchingInlineSnapshot(`
				[Error: The compliance region has been set to different values in two places:
				 - \`CLOUDFLARE_COMPLIANCE_REGION\` environment variable: \`public\`
				 - \`compliance_region\` configuration property: \`fedramp_high\`]
			`);
		});

		it("should not error if the region is set in both env var and configured, and they are the same", async () => {
			vi.stubEnv("CLOUDFLARE_COMPLIANCE_REGION", "fedramp_high");
			writeWranglerConfig({ compliance_region: "fedramp_high" });
			writeWorkerSource();
			mockUploadWorkerRequest({
				expectedBaseUrl: "api.fed.cloudflare.com",
			});
			mockSubDomainRequest();
			mockGetWorkerSubdomain({ enabled: true });

			await runWrangler("deploy ./index.js");
		});
	});

	describe("Service and environment tagging", () => {
		beforeEach(() => {
			msw.resetHandlers();

			mockLastDeploymentRequest();
			mockDeploymentsListRequest();
			msw.use(...mswListNewDeploymentsLatestFull);

			mockSubDomainRequest();
			mockGetSettings();
			writeWorkerSource();
			setIsTTY(false);
		});

		test("has environments, no existing tags, top-level env", async () => {
			mockGetScriptWithTags(null);
			mockUploadWorkerRequest();

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", ["cf:service=test-name"]);
		});

		test("has environments, no existing tags, named env", async () => {
			mockGetScriptWithTags(null);
			mockUploadWorkerRequest({
				env: "production",
				useServiceEnvironments: false,
			});

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy --env production");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", [
				"cf:service=test-name",
				"cf:environment=production",
			]);
		});

		test("has environments, missing tags, top-level env", async () => {
			mockGetScriptWithTags(["some-tag"]);
			mockUploadWorkerRequest();

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", ["some-tag", "cf:service=test-name"]);
		});

		test("has environments, missing tags, named env", async () => {
			mockGetScriptWithTags(["some-tag"]);
			mockUploadWorkerRequest({
				env: "production",
				useServiceEnvironments: false,
			});

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy --env production");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", [
				"some-tag",
				"cf:service=test-name",
				"cf:environment=production",
			]);
		});

		test("has environments, missing environment tag, named env", async () => {
			mockGetScriptWithTags(["some-tag", "cf:service=test-name"]);
			mockUploadWorkerRequest({
				env: "production",
				useServiceEnvironments: false,
			});

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy --env production");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", [
				"some-tag",
				"cf:service=test-name",
				"cf:environment=production",
			]);
		});

		test("has environments, stale service tag, top-level env", async () => {
			mockGetScriptWithTags(["some-tag", "cf:service=some-other-service"]);
			mockUploadWorkerRequest();

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", ["some-tag", "cf:service=test-name"]);
		});

		test("has environments, stale service tag, named env", async () => {
			mockGetScriptWithTags([
				"some-tag",
				"cf:service=some-other-service",
				"cf:environment=production",
			]);
			mockUploadWorkerRequest({
				env: "production",
				useServiceEnvironments: false,
			});

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy --env production");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", [
				"some-tag",
				"cf:service=test-name",
				"cf:environment=production",
			]);
		});

		test("has environments, stale environment tag, top-level env", async () => {
			mockGetScriptWithTags([
				"some-tag",
				"cf:service=test-name",
				"cf:environment=some-other-env",
			]);
			mockUploadWorkerRequest();

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", ["some-tag", "cf:service=test-name"]);
		});

		test("has environments, stale environment tag, named env", async () => {
			mockGetScriptWithTags([
				"some-tag",
				"cf:service=test-name",
				"cf:environment=some-other-env",
			]);
			mockUploadWorkerRequest({
				env: "production",
				useServiceEnvironments: false,
			});

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy --env production");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", [
				"some-tag",
				"cf:service=test-name",
				"cf:environment=production",
			]);
		});

		test("has environments, has expected tags, top-level env", async () => {
			mockGetScriptWithTags(["some-tag", "cf:service=test-name"]);
			mockUploadWorkerRequest();

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", ["some-tag", "cf:service=test-name"]);
		});

		test("has environments, has expected tags, named env", async () => {
			mockGetScriptWithTags([
				"some-tag",
				"cf:service=test-name",
				"cf:environment=production",
			]);
			mockUploadWorkerRequest({
				env: "production",
				useServiceEnvironments: false,
			});

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy --env production");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", [
				"some-tag",
				"cf:service=test-name",
				"cf:environment=production",
			]);
		});

		test("no environments", async () => {
			mockGetScriptWithTags([
				"some-tag",
				"cf:service=some-other-service",
				"cf:environment=some-other-env",
			]);
			mockUploadWorkerRequest();

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", ["some-tag"]);
		});

		test("no top-level name", async () => {
			mockGetScriptWithTags(["some-tag", "cf:service=undefined"]);
			mockUploadWorkerRequest({
				env: "production",
				useServiceEnvironments: false,
			});

			writeWranglerConfig({
				name: undefined,
				main: "./index.js",
				env: {
					production: {
						name: "test-name-production",
					},
				},
			});

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy --env production");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", ["some-tag"]);

			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mNo top-level \`name\` has been defined in Wrangler configuration. Add a top-level \`name\` to group this Worker together with its sibling environments in the Cloudflare dashboard.[0m

				"
			`);
		});

		test("displays warning when error updating tags", async () => {
			mockGetScriptWithTags([
				"some-tag",
				"cf:service=some-other-service",
				"cf:environment=some-other-env",
			]);
			mockUploadWorkerRequest({
				env: "production",
				useServiceEnvironments: false,
			});

			writeWranglerConfig({
				name: "test-name",
				main: "./index.js",
				env: {
					production: {},
				},
			});

			msw.use(
				http.patch(
					`*/accounts/:accountId/workers/scripts/:scriptName/script-settings`,
					() => HttpResponse.error()
				)
			);

			await runWrangler("deploy --env production");

			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mCould not apply service and environment tags. This Worker will not appear grouped together with its sibling environments in the Cloudflare dashboard.[0m

				"
			`);
		});

		test("environments with redirected config", async () => {
			mockGetScriptWithTags(["some-tag"]);
			mockUploadWorkerRequest({
				expectedScriptName: "test-name-production",
			});

			writeWranglerConfig(
				{
					name: "test-name",
					main: "./index.js",
					env: {
						production: {
							name: "test-name-production",
						},
					},
				},
				"./wrangler.toml"
			);

			writeRedirectedWranglerConfig(
				{
					name: "test-name-production",
					main: "../index.js",
					userConfigPath: "./wrangler.toml",
					topLevelName: "test-name",
					targetEnvironment: "production",
					definedEnvironments: ["production"],
				},
				"./dist/wrangler.json"
			);

			const patchScriptSettings = mockPatchScriptSettings();

			await runWrangler("deploy");

			await expect(
				patchScriptSettings.requests[0].json()
			).resolves.toHaveProperty("tags", [
				"some-tag",
				"cf:service=test-name",
				"cf:environment=production",
			]);

			expect(std.info).toMatchInlineSnapshot(`
				"Using redirected Wrangler configuration.
				 - Configuration being used: "dist/wrangler.json"
				 - Original user's configuration: "wrangler.toml"
				 - Deploy configuration file: ".wrangler/deploy/config.json""
			`);
		});
	});

	describe("multi-env warning", () => {
		it("should warn if the wrangler config contains environments but none was specified in the command", async () => {
			writeWorkerSource();
			writeWranglerConfig({
				main: "./index.js",
				env: {
					test: {},
				},
			});
			mockSubDomainRequest();
			mockUploadWorkerRequest();

			await runWrangler("deploy");

			expect(std.warn).toMatchInlineSnapshot(`
				"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mMultiple environments are defined in the Wrangler configuration file, but no target environment was specified for the deploy command.[0m

				  To avoid unintentional changes to the wrong environment, it is recommended to explicitly specify
				  the target environment using the \`-e|--env\` flag.
				  If your intention is to use the top-level environment of your configuration simply pass an empty
				  string to the flag to target such environment. For example \`--env=""\`.

				"
			`);
		});

		it("should not warn if the wrangler config contains environments and one was specified in the command", async () => {
			writeWorkerSource();
			writeWranglerConfig({
				main: "./index.js",
				env: {
					test: {},
				},
			});
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				env: "test",
				useServiceEnvironments: false,
			});

			await runWrangler("deploy -e test");

			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should not warn if the wrangler config doesn't contain environments and none was specified in the command", async () => {
			writeWorkerSource();
			writeWranglerConfig({
				main: "./index.js",
			});
			mockSubDomainRequest();
			mockUploadWorkerRequest();

			await runWrangler("deploy");

			expect(std.warn).toMatchInlineSnapshot(`""`);
		});
	});

	function normalizeLogWithConfigDiff(log: string): string {
		// If the path is long the log could be wrapped so we need to remove the potential wrapping
		let normalizedLog = log.replace(/"main":\s*"/, '"main": "');

		if (process.platform === "win32") {
			// On windows the snapshot paths incorrectly use double slashes, such as:
			//  `\"main\": \"C://Users//RUNNER~1//AppData//Local//Temp//wrangler-testse63LuJ//index.js\",
			// so in the `main` field we replace all possible occurrences of `//` with just `\\`
			// (so that the path normalization of `normalizeString` can appropriately work)
			normalizedLog = normalizedLog.replace(
				/"main": "(.*?)"/,
				(_, mainPath: string) => `"main": "${mainPath.replaceAll("//", "\\")}"`
			);
		}

		normalizedLog = normalizeString(normalizedLog);

		// Let's remove the various extra characters for colors to get a more clear output
		normalizedLog = normalizedLog
			.replaceAll("", "X")
			.replaceAll(/X\[\d+(?:;\d+)?m/g, "");

		// Let's also normalize Windows newlines
		normalizedLog = normalizedLog.replaceAll("\r\n", "\n");

		return normalizedLog;
	}

	describe("config remote differences", () => {
		it("should present a diff warning to the user when there are differences between the local config (json/jsonc) and the dash config", async () => {
			writeWorkerSource();
			mockGetServiceByName("test-name", "production", "dash");
			writeWranglerConfig(
				{
					compatibility_date: "2024-04-24",
					main: "./index.js",
					workers_dev: true,
					preview_urls: true,
					vars: {
						MY_VAR: 123,
					},
					observability: {
						enabled: true,
					},
				},
				"./wrangler.json"
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({ wranglerConfigPath: "./wrangler.json" });
			mockGetServiceBindings("test-name", [
				{ name: "MY_VAR", text: "abc", type: "plain_text" },
			]);
			mockGetServiceRoutes("test-name", []);
			mockGetServiceCustomDomainRecords([]);
			mockGetServiceSubDomainData("test-name", {
				enabled: true,
				previews_enabled: true,
			});
			mockGetServiceSchedules("test-name", { schedules: [] });
			mockGetServiceMetadata("test-name", {
				created_on: "2025-08-07T09:34:47.846308Z",
				modified_on: "2025-08-08T10:48:12.688997Z",
				script: {
					created_on: "2025-08-07T09:34:47.846308Z",
					modified_on: "2025-08-08T10:48:12.688997Z",
					id: "my-worker-id",
					observability: { enabled: true, head_sampling_rate: 1 },
					compatibility_date: "2024-04-24",
				},
			} as unknown as ServiceMetadataRes["default_environment"]);

			mockConfirm({
				text: "Would you like to continue?",
				result: true,
			});

			await runWrangler("deploy");

			expect(normalizeLogWithConfigDiff(std.warn)).toMatchInlineSnapshot(`
				"▲ [WARNING] The local configuration being used (generated from your local configuration file) differs from the remote configuration of your Worker set via the Cloudflare Dashboard:

				   {
				     vars: {
				  -    MY_VAR: "abc"
				  +    MY_VAR: 123
				     }
				   }


				  Deploying the Worker will override the remote configuration with your local one.

				"
			`);
		});

		it("should not present a diff warning to the user when there are differences between the local config (json/jsonc) and the dash config in dry-run mode", async () => {
			writeWorkerSource();
			writeWranglerConfig(
				{
					compatibility_date: "2024-04-24",
					main: "./index.js",
					workers_dev: true,
					preview_urls: true,
					vars: {
						MY_VAR: 123,
					},
					observability: {
						enabled: true,
					},
				},
				"./wrangler.json"
			);

			// Note: we don't set any mocks here since in dry-run we don't expect wragnler to interact
			//       with the rest API in any way

			await runWrangler("deploy --dry-run");

			expect(normalizeLogWithConfigDiff(std.warn)).toMatchInlineSnapshot(`""`);
		});

		it("should present a diff warning to the user when there are differences between the local config (toml) and the dash config", async () => {
			writeWorkerSource();
			mockGetServiceByName("test-name", "production", "dash");
			writeWranglerConfig(
				{
					compatibility_date: "2024-04-24",
					main: "./index.js",
					workers_dev: true,
					preview_urls: true,
					vars: {
						MY_VAR: "this is a toml file",
					},
					observability: {
						enabled: true,
					},
				},
				"./wrangler.toml"
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			mockGetServiceBindings("test-name", [
				{ name: "MY_VAR", text: "abc", type: "plain_text" },
			]);
			mockGetServiceRoutes("test-name", []);
			mockGetServiceCustomDomainRecords([]);
			mockGetServiceSubDomainData("test-name", {
				enabled: true,
				previews_enabled: true,
			});
			mockGetServiceSchedules("test-name", { schedules: [] });
			mockGetServiceMetadata("test-name", {
				created_on: "2025-08-07T09:34:47.846308Z",
				modified_on: "2025-08-08T10:48:12.688997Z",
				script: {
					created_on: "2025-08-07T09:34:47.846308Z",
					modified_on: "2025-08-08T10:48:12.688997Z",
					id: "my-worker-id",
					observability: { enabled: true, head_sampling_rate: 1 },
					compatibility_date: "2024-04-24",
				},
			} as unknown as ServiceMetadataRes["default_environment"]);

			mockConfirm({
				text: "Would you like to continue?",
				result: true,
			});

			await runWrangler("deploy");

			// Note: we display the toml config diff in json format since code-wise we'd have to convert the rawConfig to toml
			//       to be able to show toml content/diffs, that combined with the fact that json(c) config files are the
			//       recommended ones moving forward makes this small shortcoming of the config diffing acceptable
			expect(normalizeLogWithConfigDiff(std.warn)).toMatchInlineSnapshot(`
				"▲ [WARNING] The local configuration being used (generated from your local configuration file) differs from the remote configuration of your Worker set via the Cloudflare Dashboard:

				   {
				     vars: {
				  -    MY_VAR: "abc"
				  +    MY_VAR: "this is a toml file"
				     }
				   }


				  Deploying the Worker will override the remote configuration with your local one.

				"
			`);
		});

		it("in non-intractive (and non-strict) mode, should present a diff when there are differences between the local config and the dash config, and proceed with the deployment", async () => {
			setIsTTY(false);

			fs.mkdirSync("./public");

			await mockAUSRequest([]);

			writeWorkerSource();
			mockGetServiceByName("test-name", "production", "dash");
			writeWranglerConfig(
				{
					compatibility_date: "2024-04-24",
					main: "./index.js",
					workers_dev: true,
					preview_urls: true,
					vars: {
						MY_VAR: "this is a toml file",
					},
					assets: {
						binding: "ASSETS",
						// Note: remotely we only get the assets' binding name, so in the diff below you can see that
						//       no diff for the directory configuration is shown
						directory: "public",
					},
					observability: {
						enabled: true,
					},
				},
				"./wrangler.toml"
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			mockGetServiceBindings("test-name", [
				{ name: "MY_VAR", text: "abc", type: "plain_text" },
			]);
			mockGetServiceRoutes("test-name", []);
			mockGetServiceCustomDomainRecords([]);
			mockGetServiceSubDomainData("test-name", {
				enabled: true,
				previews_enabled: true,
			});
			mockGetServiceSchedules("test-name", { schedules: [] });
			mockGetServiceMetadata("test-name", {
				created_on: "2025-08-07T09:34:47.846308Z",
				modified_on: "2025-08-08T10:48:12.688997Z",
				script: {
					created_on: "2025-08-07T09:34:47.846308Z",
					modified_on: "2025-08-08T10:48:12.688997Z",
					id: "my-worker-id",
					observability: { enabled: true, head_sampling_rate: 1 },
					compatibility_date: "2024-04-24",
				},
			} as unknown as ServiceMetadataRes["default_environment"]);

			await runWrangler("deploy");

			// Note: we display the toml config diff in json format since code-wise we'd have to convert the rawConfig to toml
			//       to be able to show toml content/diffs, that combined with the fact that json(c) config files are the
			//       recommended ones moving forward makes this small shortcoming of the config diffing acceptable
			expect(normalizeLogWithConfigDiff(std.warn)).toMatchInlineSnapshot(`
				"▲ [WARNING] The local configuration being used (generated from your local configuration file) differs from the remote configuration of your Worker set via the Cloudflare Dashboard:

				   {
				  +  assets: {
				  +    binding: "ASSETS"
				  +  }
				     vars: {
				  -    MY_VAR: "abc"
				  +    MY_VAR: "this is a toml file"
				     }
				   }


				  Deploying the Worker will override the remote configuration with your local one.

				"
			`);

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				? Would you like to continue?
				🤖 Using fallback value in non-interactive context: yes
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                                 Resource
				env.ASSETS                              Assets
				env.MY_VAR ("this is a toml file")      Environment Variable

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
		});

		describe("with strict mode enabled", () => {
			it("should error if there are remote config difference in non-interactive mode", async () => {
				setIsTTY(false);

				writeWorkerSource();
				mockGetServiceByName("test-name", "production", "dash");
				writeWranglerConfig(
					{
						compatibility_date: "2024-04-24",
						main: "./index.js",
						workers_dev: true,
						preview_urls: true,
					},
					"./wrangler.json"
				);
				mockSubDomainRequest();
				mockUploadWorkerRequest({ wranglerConfigPath: "./wrangler.json" });
				mockGetServiceBindings("test-name", []);
				mockGetServiceRoutes("test-name", []);
				mockGetServiceCustomDomainRecords([]);
				mockGetServiceSubDomainData("test-name", {
					enabled: true,
					previews_enabled: true,
				});
				mockGetServiceSchedules("test-name", { schedules: [] });
				mockGetServiceMetadata("test-name", {
					created_on: "2025-08-07T09:34:47.846308Z",
					modified_on: "2025-08-08T10:48:12.688997Z",
					script: {
						created_on: "2025-08-07T09:34:47.846308Z",
						modified_on: "2025-08-08T10:48:12.688997Z",
						id: "my-worker-id",
						observability: { enabled: true, head_sampling_rate: 1 },
						compatibility_date: "2024-04-24",
					},
				} as unknown as ServiceMetadataRes["default_environment"]);

				await runWrangler("deploy --strict");

				expect(normalizeLogWithConfigDiff(std.warn)).toMatchInlineSnapshot(`
					"▲ [WARNING] The local configuration being used (generated from your local configuration file) differs from the remote configuration of your Worker set via the Cloudflare Dashboard:

					   {
					     observability: {
					  -    enabled: true
					  +    enabled: false
					       logs: {
					  -      enabled: true
					  +      enabled: false
					       }
					     }
					   }


					  Deploying the Worker will override the remote configuration with your local one.

					"
				`);

				expect(std.err).toMatchInlineSnapshot(`
					"[31mX [41;31m[[41;97mERROR[41;31m][0m [1mAborting the deployment operation because of conflicts. To override and deploy anyway remove the \`--strict\` flag[0m

					"
				`);
				// note: the test and the wrangler run share the same process, and we expect the deploy command (which fails)
				//       to set a non-zero exit code
				expect(process.exitCode).not.toBe(0);
			});

			it("should error when worker was last deployed from api", async () => {
				setIsTTY(false);

				msw.use(...mswSuccessDeploymentScriptAPI);
				writeWranglerConfig();
				writeWorkerSource();
				mockSubDomainRequest();
				mockUploadWorkerRequest();

				await runWrangler("deploy ./index --strict");

				expect(std.warn).toMatchInlineSnapshot(`
					"[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mYou are about to publish a Workers Service that was last updated via the script API.[0m

					  Edits that have been made via the script API will be overridden by your local code and config.

					"
				`);
				expect(std.err).toMatchInlineSnapshot(`
					"[31mX [41;31m[[41;97mERROR[41;31m][0m [1mAborting the deployment operation because of conflicts. To override and deploy anyway remove the \`--strict\` flag[0m

					"
				`);
				// note: the test and the wrangler run share the same process, and we expect the deploy command (which fails)
				//       to set a non-zero exit code
				expect(process.exitCode).not.toBe(0);
			});
		});

		it("should warn the user when the deployment would (likely unintentionally) override remote secrets", async () => {
			writeWorkerSource();
			mockGetServiceByName("test-name", "production", "dash");
			writeWranglerConfig(
				{
					compatibility_date: "2024-04-24",
					main: "./index.js",
					vars: {
						MY_SECRET: 123,
					},
					observability: {
						enabled: true,
					},
				},
				"./wrangler.json"
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({ wranglerConfigPath: "./wrangler.json" });
			mockGetServiceBindings("test-name", []);
			mockGetServiceRoutes("test-name", []);
			mockGetServiceCustomDomainRecords([]);
			mockGetServiceSubDomainData("test-name", {
				enabled: true,
				previews_enabled: true,
			});
			mockGetServiceSchedules("test-name", { schedules: [] });
			mockGetServiceMetadata("test-name", {
				created_on: "2025-08-07T09:34:47.846308Z",
				modified_on: "2025-08-08T10:48:12.688997Z",
				script: {
					created_on: "2025-08-07T09:34:47.846308Z",
					modified_on: "2025-08-08T10:48:12.688997Z",
					id: "my-worker-id",
					observability: { enabled: true, head_sampling_rate: 1 },
					compatibility_date: "2024-04-24",
				},
			} as unknown as ServiceMetadataRes["default_environment"]);

			vi.mocked(fetchSecrets).mockResolvedValue([
				{ name: "MY_SECRET", type: "secret_text" },
			]);
			mockConfirm({
				text: "Would you like to continue?",
				result: true,
			});

			await runWrangler("deploy");

			expect(fetchSecrets).toHaveBeenCalled();
			expect(normalizeLogWithConfigDiff(std.warn)).toMatchInlineSnapshot(`
				"▲ [WARNING] Environment variable \`MY_SECRET\` conflicts with an existing remote secret. This deployment will replace the remote secret with your environment variable.

				"
			`);
		});

		it("should handle the remote secrets fetching check for new workers", async () => {
			writeWorkerSource();
			writeWranglerConfig(
				{
					compatibility_date: "2024-04-24",
					main: "./index.js",
					vars: {
						MY_SECRET: 123,
					},
					observability: {
						enabled: true,
					},
				},
				"./wrangler.json"
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({ wranglerConfigPath: "./wrangler.json" });

			msw.use(
				http.get(
					`*/accounts/:accountId/workers/scripts/:scriptName/secrets`,
					() => {
						const workerNotFoundAPIError = new APIError({
							status: 404,
							text: "A request to the Cloudflare API (/accounts/xxx/workers/scripts/yyy/secrets) failed.",
						});

						workerNotFoundAPIError.code = 10007;
						throw workerNotFoundAPIError;
					},
					{ once: true }
				)
			);

			await runWrangler("deploy");

			expect(fetchSecrets).toHaveBeenCalled();
			expect(std.warn).toMatchInlineSnapshot(`""`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                  Resource
				env.MY_SECRET (123)      Environment Variable

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should not fetch remote secrets in dry-run mode", async () => {
			writeWorkerSource();
			writeWranglerConfig(
				{
					compatibility_date: "2024-04-24",
					main: "./index.js",
					vars: {
						MY_SECRET: 123,
					},
					observability: {
						enabled: true,
					},
				},
				"./wrangler.json"
			);

			// Note: we don't set any mocks here since in dry-run we don't expect wragnler to interact
			//       with the rest API in any way

			vi.mocked(fetchSecrets).mockResolvedValue([
				{ name: "MY_SECRET", type: "secret_text" },
			]);

			await runWrangler("deploy --dry-run");

			expect(fetchSecrets).not.toHaveBeenCalled();
			expect(normalizeLogWithConfigDiff(std.warn)).toMatchInlineSnapshot(`""`);
		});

		it("should abort the deployment when it would (likely unintentionally) override remote secrets in non-interactive strict mode", async () => {
			setIsTTY(false);

			writeWorkerSource();
			mockGetServiceByName("test-name", "production", "dash");
			writeWranglerConfig(
				{
					compatibility_date: "2024-04-24",
					main: "./index.js",
					vars: {
						MY_SECRET: 123,
					},
					observability: {
						enabled: true,
					},
				},
				"./wrangler.json"
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({ wranglerConfigPath: "./wrangler.json" });
			mockGetServiceBindings("test-name", []);
			mockGetServiceRoutes("test-name", []);
			mockGetServiceCustomDomainRecords([]);
			mockGetServiceSubDomainData("test-name", {
				enabled: true,
				previews_enabled: true,
			});
			mockGetServiceSchedules("test-name", { schedules: [] });
			mockGetServiceMetadata("test-name", {
				created_on: "2025-08-07T09:34:47.846308Z",
				modified_on: "2025-08-08T10:48:12.688997Z",
				script: {
					created_on: "2025-08-07T09:34:47.846308Z",
					modified_on: "2025-08-08T10:48:12.688997Z",
					id: "my-worker-id",
					observability: { enabled: true, head_sampling_rate: 1 },
					compatibility_date: "2024-04-24",
				},
			} as unknown as ServiceMetadataRes["default_environment"]);

			vi.mocked(fetchSecrets).mockResolvedValue([
				{ name: "MY_SECRET", type: "secret_text" },
			]);

			await runWrangler("deploy --strict");

			expect(fetchSecrets).toHaveBeenCalled();

			expect(normalizeLogWithConfigDiff(std.warn)).toMatchInlineSnapshot(`
				"▲ [WARNING] Environment variable \`MY_SECRET\` conflicts with an existing remote secret. This deployment will replace the remote secret with your environment variable.

				"
			`);

			expect(std.err).toMatchInlineSnapshot(`
				"[31mX [41;31m[[41;97mERROR[41;31m][0m [1mAborting the deployment operation because of conflicts. To override and deploy anyway remove the \`--strict\` flag[0m

				"
			`);

			// note: the test and the wrangler run share the same process, and we expect the deploy command (which fails)
			//       to set a non-zero exit code
			expect(process.exitCode).not.toBe(0);
		});
	});

	it("should output a deploy and an autoconfig output entry to WRANGLER_OUTPUT_FILE_PATH if autoconfig run", async () => {
		const outputFile = "./output.json";

		vi.mocked(getDetailsForAutoConfig).mockResolvedValue({
			configured: false,
			framework: new Static({ id: "static", name: "Static" }),
			workerName: "my-site",
			projectPath: ".",
			outputDir: "./public",
			packageManager: NpmPackageManager,
		});

		vi.mocked(runAutoConfig).mockImplementation(async () => {
			const wranglerConfig = {
				name: "my-site",
				compatibility_date: "2025-12-02",
				assets: {
					directory: ".",
				},
			};

			writeWranglerConfig(wranglerConfig);

			return {
				scripts: {
					build: "npm run build-my-static-site",
				},
				wranglerInstall: true,
				wranglerConfig,
				outputDir: "public",
			};
		});

		await runWrangler("deploy --x-autoconfig --dry-run", {
			...process.env,
			WRANGLER_OUTPUT_FILE_PATH: outputFile,
		});

		const outputEntries = (await readFile(outputFile, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)) as OutputEntry[];

		expect(outputEntries).toContainEqual(
			expect.objectContaining({ type: "deploy" })
		);

		const autoconfigOutputEntry = outputEntries.find(
			(obj) => obj.type === "autoconfig"
		);
		expect(autoconfigOutputEntry?.summary).toMatchInlineSnapshot(`
			{
			  "outputDir": "public",
			  "scripts": {
			    "build": "npm run build-my-static-site",
			  },
			  "wranglerConfig": {
			    "assets": {
			      "directory": ".",
			    },
			    "compatibility_date": "2025-12-02",
			    "name": "my-site",
			  },
			  "wranglerInstall": true,
			}
		`);
	});

	describe("open-next delegation", () => {
		async function mockOpenNextLikeProject() {
			vi.mocked(getInstalledPackageVersion).mockReturnValue("1.14.4");

			fs.mkdirSync("./.open-next/assets", { recursive: true });
			fs.writeFileSync(
				"./.open-next/worker.js",
				"export default { fetch() { return new Response(''); } };"
			);
			fs.writeFileSync("./next.config.js", "export default {};");
			fs.writeFileSync(
				"./open-next.config.ts",
				dedent`
					import { defineCloudflareConfig } from "@opennextjs/cloudflare";
					export default defineCloudflareConfig();
				`
			);

			await mockAUSRequest([]);

			writeWorkerSource();
			mockGetServiceByName("test-name", "production", "dash");
			writeWranglerConfig(
				{
					main: ".open-next/worker.js",
					compatibility_date: "2024-04-24",
					compatibility_flags: [
						"nodejs_compat",
						"global_fetch_strictly_public",
					],
					assets: {
						binding: "ASSETS",
						directory: ".open-next/assets",
					},
				},
				"./wrangler.jsonc"
			);
			mockSubDomainRequest();
			mockUploadWorkerRequest({ expectedMainModule: "worker.js" });
			mockGetServiceBindings("test-name", []);
			mockGetServiceRoutes("test-name", []);
			mockGetServiceCustomDomainRecords([]);
			mockGetServiceSubDomainData("test-name", {
				enabled: true,
				previews_enabled: true,
			});
			mockGetServiceSchedules("test-name", { schedules: [] });
			mockGetServiceMetadata("test-name", {
				created_on: "2025-08-07T09:34:47.846308Z",
				modified_on: "2025-08-08T10:48:12.688997Z",
				script: {
					created_on: "2025-08-07T09:34:47.846308Z",
					modified_on: "2025-08-08T10:48:12.688997Z",
					id: "my-worker-id",
					compatibility_date: "2024-04-24",
				},
			} as unknown as ServiceMetadataRes["default_environment"]);
		}

		it("should delegate to open-next when run in an open-next project and set OPEN_NEXT_DEPLOY", async () => {
			vi.spyOn(process, "argv", "get").mockReturnValue([
				"npx",
				"wrangler",
				"deploy",
				"--x-autoconfig",
			]);
			const runCommandSpy = (await import("../autoconfig/c3-vendor/command"))
				.runCommand;

			await mockOpenNextLikeProject();

			await runWrangler("deploy --x-autoconfig");

			expect(runCommandSpy).toHaveBeenCalledOnce();
			const call = (runCommandSpy as unknown as MockInstance).mock.calls[0];
			const [command, options] = call;
			expect(command).toEqual([
				"npx",
				"opennextjs-cloudflare",
				"deploy",
				"--x-autoconfig",
			]);
			expect(options).toMatchObject({
				env: {
					// Note: we want to ensure that OPEN_NEXT_DEPLOY has been set, this is not strictly necessary but it helps us
					//       ensure that we can't end up in an infinite wrangler<>open-next invokation loop
					OPEN_NEXT_DEPLOY: "true",
				},
			});

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				OpenNext project detected, calling \`opennextjs-cloudflare deploy\`",
				  "warn": "",
				}
			`);
		});

		it("should delegate to open-next when run in an open-next project and set OPEN_NEXT_DEPLOY and pass the various CLI arguments", async () => {
			vi.spyOn(process, "argv", "get").mockReturnValue([
				"npx",
				"wrangler",
				"deploy",
				"--keep-vars",
				"--x-autoconfig",
			]);
			const runCommandSpy = (await import("../autoconfig/c3-vendor/command"))
				.runCommand;

			await mockOpenNextLikeProject();

			await runWrangler("deploy --x-autoconfig");

			expect(runCommandSpy).toHaveBeenCalledOnce();
			const call = (runCommandSpy as unknown as MockInstance).mock.calls[0];
			const [command, options] = call;
			expect(command).toEqual([
				"npx",
				"opennextjs-cloudflare",
				"deploy",
				// `opennextjs-cloudflare deploy` accepts all the same arguments `wrangler deploy` does (since it then forwards them
				// to wrangler), so we do want to make sure that arguments are indeed forwarded to `opennextjs-cloudflare deploy`
				"--keep-vars",
				"--x-autoconfig",
			]);
			expect(options).toMatchObject({
				env: {
					// Note: we want to ensure that OPEN_NEXT_DEPLOY has been set, this is not strictly necessary but it helps us
					//       ensure that we can't end up in an infinite wrangler<>open-next invokation loop
					OPEN_NEXT_DEPLOY: "true",
				},
			});

			expect(std).toMatchInlineSnapshot(`
				{
				  "debug": "",
				  "err": "",
				  "info": "",
				  "out": "
				 ⛅️ wrangler x.x.x
				──────────────────
				OpenNext project detected, calling \`opennextjs-cloudflare deploy\`",
				  "warn": "",
				}
			`);
		});

		it("should not delegate to open-next deploy when run in an open-next project and OPEN_NEXT_DEPLOY is set", async () => {
			vi.stubEnv("OPEN_NEXT_DEPLOY", "1");

			const runCommandSpy = (await import("../autoconfig/c3-vendor/command"))
				.runCommand;

			await mockOpenNextLikeProject();

			await runWrangler("deploy --x-autoconfig");

			expect(runCommandSpy).not.toHaveBeenCalledOnce();

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding            Resource
				env.ASSETS         Assets

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should not delegate to open-next deploy when the --x-autoconfig flag is not provided", async () => {
			const runCommandSpy = (await import("../autoconfig/c3-vendor/command"))
				.runCommand;

			await mockOpenNextLikeProject();

			await runWrangler("deploy");

			expect(runCommandSpy).not.toHaveBeenCalledOnce();

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding            Resource
				env.ASSETS         Assets

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should not delegate to open-next deploy when the Next.js config file is missing (to avoid false positives)", async () => {
			const runCommandSpy = (await import("../autoconfig/c3-vendor/command"))
				.runCommand;

			await mockOpenNextLikeProject();

			// Let's delete the next.config.js file
			fs.rmSync("./next.config.js");

			await runWrangler("deploy --x-autoconfig");

			expect(runCommandSpy).not.toHaveBeenCalledOnce();

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding            Resource
				env.ASSETS         Assets

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});

		it("should not delegate to open-next deploy when the open-next config file is missing (to avoid false positives)", async () => {
			const runCommandSpy = (await import("../autoconfig/c3-vendor/command"))
				.runCommand;

			await mockOpenNextLikeProject();

			// Let's delete the open-next.config.ts file
			fs.rmSync("./open-next.config.ts");

			await runWrangler("deploy --x-autoconfig");

			expect(runCommandSpy).not.toHaveBeenCalledOnce();

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding            Resource
				env.ASSETS         Assets

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
			expect(std.err).toMatchInlineSnapshot(`""`);
			expect(std.warn).toMatchInlineSnapshot(`""`);
		});
	});

	describe("--tag and --message", () => {
		it("should send tag and message annotations via the new versions API", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAnnotations: {
					"workers/message": "my deploy message",
					"workers/tag": "v1.0.0",
				},
				expectedDeploymentMessage: "my deploy message",
			});

			await runWrangler(
				'deploy ./index --tag v1.0.0 --message "my deploy message"'
			);
			expect(std.out).toContain("Uploaded test-name");
			expect(std.out).toContain("Current Version ID: Galaxy-Class");
		});

		it("should send tag and message annotations via the legacy PUT API", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAnnotations: {
					"workers/message": "legacy deploy msg",
					"workers/tag": "v2.0.0",
				},
				expectedDispatchNamespace: "test-dispatch-namespace",
			});

			await runWrangler(
				'deploy ./index --dispatch-namespace test-dispatch-namespace --tag v2.0.0 --message "legacy deploy msg"'
			);
			expect(std.out).toContain("Uploaded test-name");
		});

		it("should send only --tag without --message", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAnnotations: {
					"workers/message": undefined,
					"workers/tag": "v1.0.0",
				},
				expectedDeploymentMessage: undefined,
			});

			await runWrangler("deploy ./index --tag v1.0.0");
			expect(std.out).toContain("Uploaded test-name");
		});

		it("should send only --message without --tag", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAnnotations: {
					"workers/message": "just a message",
					"workers/tag": undefined,
				},
				expectedDeploymentMessage: "just a message",
			});

			await runWrangler('deploy ./index --message "just a message"');
			expect(std.out).toContain("Uploaded test-name");
		});

		it("should not set annotations when neither --tag nor --message is provided", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedAnnotations: undefined,
			});

			await runWrangler("deploy ./index");
			expect(std.out).toContain("Uploaded test-name");
		});
	});
});
