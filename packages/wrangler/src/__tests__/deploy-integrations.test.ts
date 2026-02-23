import * as fs from "node:fs";
import * as path from "node:path";
import { writeWranglerConfig } from "@cloudflare/workers-utils/test-helpers";
import { http, HttpResponse } from "msw";
/* eslint-disable workers-sdk/no-vitest-import-expect -- large file with .each and custom matchers */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/* eslint-enable workers-sdk/no-vitest-import-expect */
import { getInstalledPackageVersion } from "../autoconfig/frameworks/utils/packages";
import { WORKFLOW_NOT_FOUND_CODE } from "../deploy/check-workflow-conflicts";
import { clearOutputFilePath } from "../output";
import { fetchSecrets } from "../utils/fetch-secrets";
import {
	mockDeploymentsListRequest,
	mockGetQueueByName,
	mockGetServiceByName,
	mockLastDeploymentRequest,
	mockPatchScriptSettings,
	mockPostConsumerById,
	mockPostQueueHTTPConsumer,
	mockPutQueueConsumerById,
} from "./deploy-test-utils";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import { mockConsoleMethods } from "./helpers/mock-console";
import { clearDialogs, mockConfirm } from "./helpers/mock-dialogs";
import { useMockIsTTY } from "./helpers/mock-istty";
import { mockGetMemberships, mockOAuthFlow } from "./helpers/mock-oauth-flow";
import { mockUploadWorkerRequest } from "./helpers/mock-upload-worker";
import { mockGetSettings } from "./helpers/mock-worker-settings";
import { mockSubDomainRequest } from "./helpers/mock-workers-subdomain";
import { createFetchResult, msw } from "./helpers/msw";
import { mswListNewDeploymentsLatestFull } from "./helpers/msw/handlers/versions";
import { runInTempDir } from "./helpers/run-in-tmp";
import { runWrangler } from "./helpers/run-wrangler";
import { writeWorkerSource } from "./helpers/write-worker-source";
import type { QueueResponse } from "../queues/client";

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
	const { mockOAuthServerCallback } = mockOAuthFlow();

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

	describe("queues", () => {
		const queueId = "queue-id";
		const queueName = "queue1";
		it("should upload producer bindings", async () => {
			writeWranglerConfig({
				queues: {
					producers: [{ binding: "QUEUE_ONE", queue: "queue1" }],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "queue",
						name: "QUEUE_ONE",
						queue_name: queueName,
					},
				],
			});
			const existingQueue = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [],
				producers_total_count: 1,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                     Resource
				env.QUEUE_ONE (queue1)      Queue

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				  Producer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should update queue producers on deploy", async () => {
			writeWranglerConfig({
				queues: {
					producers: [
						{
							queue: queueName,
							binding: "MY_QUEUE",
							delivery_delay: 10,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			const existingQueue = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [],
				producers_total_count: 1,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                    Resource
				env.MY_QUEUE (queue1)      Queue

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				  Producer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should post worker queue consumers on deploy", async () => {
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							max_batch_timeout: 3,
							max_retries: 10,
							retry_delay: 5,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [],
				producers_total_count: 0,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);
			mockPostConsumerById(queueId, {
				dead_letter_queue: "myDLQ",
				type: "worker",
				script_name: "test-name",
				settings: {
					batch_size: 5,
					max_retries: 10,
					max_wait_time_ms: 3000,
					retry_delay: 5,
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
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should post worker queue consumers on deploy, using command line script name arg", async () => {
			const expectedScriptName = "command-line-arg-script-name";
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							max_batch_timeout: 3,
							max_retries: 10,
							retry_delay: 5,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({ expectedScriptName });
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [],
				producers_total_count: 0,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);
			mockPostConsumerById(queueId, {
				dead_letter_queue: "myDLQ",
				type: "worker",
				script_name: expectedScriptName,
				settings: {
					batch_size: 5,
					max_retries: 10,
					max_wait_time_ms: 3000,
					retry_delay: 5,
				},
			});
			await runWrangler(`deploy index.js --name ${expectedScriptName}`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded command-line-arg-script-name (TIMINGS)
				Deployed command-line-arg-script-name triggers (TIMINGS)
				  https://command-line-arg-script-name.test-sub-domain.workers.dev
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should update worker queue consumers on deploy", async () => {
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							max_batch_timeout: 3,
							max_retries: 10,
							retry_delay: 5,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			const expectedConsumerId = "consumerId";
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [
					{
						script: "test-name",
						consumer_id: expectedConsumerId,
						type: "worker",
						settings: {},
					},
				],
				producers_total_count: 1,
				consumers_total_count: 1,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);
			mockPutQueueConsumerById(queueId, queueName, expectedConsumerId, {
				dead_letter_queue: "myDLQ",
				type: "worker",
				script_name: "test-name",
				settings: {
					batch_size: 5,
					max_retries: 10,
					max_wait_time_ms: 3000,
					retry_delay: 5,
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
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should update worker (service) queue consumers with default environment on deploy", async () => {
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							max_batch_timeout: 3,
							max_retries: 10,
							retry_delay: 5,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			const expectedConsumerId = "consumerId";
			const expectedConsumerName = "test-name";
			const expectedEnvironment = "production";
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [
					{
						service: expectedConsumerName,
						environment: "production",
						consumer_id: expectedConsumerId,
						type: "worker",
						settings: {},
					},
				],
				producers_total_count: 1,
				consumers_total_count: 1,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);
			mockGetServiceByName(expectedConsumerName, expectedEnvironment);
			mockPutQueueConsumerById(queueId, queueName, expectedConsumerId, {
				dead_letter_queue: "myDLQ",
				type: "worker",
				script_name: "test-name",
				settings: {
					batch_size: 5,
					max_retries: 10,
					max_wait_time_ms: 3000,
					retry_delay: 5,
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
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should post queue http consumers on deploy", async () => {
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							type: "http_pull",
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							visibility_timeout_ms: 4000,
							max_retries: 10,
							retry_delay: 1,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [],
				producers_total_count: 0,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);
			mockPostQueueHTTPConsumer(queueId, {
				type: "http_pull",
				dead_letter_queue: "myDLQ",
				settings: {
					batch_size: 5,
					max_retries: 10,
					visibility_timeout_ms: 4000,
					retry_delay: 1,
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
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should update queue http consumers when one already exists for queue", async () => {
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							type: "http_pull",
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [
					{
						type: "http_pull",
						consumer_id: "queue1-consumer-id",
						settings: {},
					},
				],
				producers_total_count: 0,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);

			msw.use(
				http.put(
					`*/accounts/:accountId/queues/:queueId/consumers/:consumerId`,
					async ({ params }) => {
						expect(params.queueId).toEqual(queueId);
						expect(params.consumerId).toEqual("queue1-consumer-id");
						expect(params.accountId).toEqual("some-account-id");
						return HttpResponse.json({
							success: true,
							errors: [],
							messages: [],
							result: null,
						});
					}
				)
			);
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
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should support queue consumer concurrency with a max concurrency specified", async () => {
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							max_batch_timeout: 3,
							max_retries: 10,
							max_concurrency: 5,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			const consumerId = "consumer-id";
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [
					{
						type: "worker",
						script: "test-name",
						consumer_id: consumerId,
						settings: {},
					},
				],
				producers_total_count: 0,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);
			mockPutQueueConsumerById(queueId, queueName, consumerId, {
				dead_letter_queue: "myDLQ",
				type: "worker",
				script_name: "test-name",
				settings: {
					batch_size: 5,
					max_retries: 10,
					max_wait_time_ms: 3000,
					max_concurrency: 5,
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
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should support queue consumer concurrency with a null max concurrency", async () => {
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							max_batch_timeout: 3,
							max_retries: 10,
							max_concurrency: null,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();

			const consumerId = "consumer-id";
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [
					{
						type: "worker",
						script: "test-name",
						consumer_id: consumerId,
						settings: {},
					},
				],
				producers_total_count: 0,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);
			mockPutQueueConsumerById(queueId, queueName, consumerId, {
				dead_letter_queue: "myDLQ",
				type: "worker",
				script_name: "test-name",
				settings: {
					batch_size: 5,
					max_retries: 10,
					max_wait_time_ms: 3000,
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
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should support queue consumer with max_batch_timeout of 0", async () => {
			writeWranglerConfig({
				queues: {
					consumers: [
						{
							queue: queueName,
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							max_batch_timeout: 0,
							max_retries: 10,
							max_concurrency: null,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();

			const consumerId = "consumer-id";
			const existingQueue: QueueResponse = {
				queue_id: queueId,
				queue_name: queueName,
				created_on: "",
				producers: [],
				consumers: [
					{
						type: "worker",
						script: "test-name",
						consumer_id: consumerId,
						settings: {},
					},
				],
				producers_total_count: 0,
				consumers_total_count: 0,
				modified_on: "",
			};
			mockGetQueueByName(queueName, existingQueue);
			mockPutQueueConsumerById(queueId, queueName, consumerId, {
				dead_letter_queue: "myDLQ",
				type: "worker",
				script_name: "test-name",
				settings: {
					batch_size: 5,
					max_retries: 10,
					max_wait_time_ms: 0,
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
				  Consumer for queue1
				Current Version ID: Galaxy-Class"
			`);
		});

		it("consumer should error when a queue doesn't exist", async () => {
			writeWranglerConfig({
				queues: {
					producers: [],
					consumers: [
						{
							queue: queueName,
							dead_letter_queue: "myDLQ",
							max_batch_size: 5,
							max_batch_timeout: 3,
							max_retries: 10,
						},
					],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			mockGetQueueByName(queueName, null);

			await expect(
				runWrangler("deploy index.js")
			).rejects.toMatchInlineSnapshot(
				`[Error: Queue "queue1" does not exist. To create it, run: wrangler queues create queue1]`
			);
		});

		it("producer should error when a queue doesn't exist", async () => {
			writeWranglerConfig({
				queues: {
					producers: [{ queue: queueName, binding: "QUEUE_ONE" }],
					consumers: [],
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			mockGetQueueByName(queueName, null);

			await expect(
				runWrangler("deploy index.js")
			).rejects.toMatchInlineSnapshot(
				`[Error: Queue "queue1" does not exist. To create it, run: wrangler queues create queue1]`
			);
		});
	});

	describe("ai", () => {
		it("should upload ai bindings", async () => {
			writeWranglerConfig({
				ai: { binding: "AI_BIND" },
				browser: { binding: "MYBROWSER" },
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "browser",
						name: "MYBROWSER",
					},
					{
						type: "ai",
						name: "AI_BIND",
					},
				],
			});

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding               Resource
				env.MYBROWSER         Browser
				env.AI_BIND           AI

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});
	});

	describe("images", () => {
		it("should upload images bindings", async () => {
			writeWranglerConfig({
				images: { binding: "IMAGES_BIND" },
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "images",
						name: "IMAGES_BIND",
					},
				],
			});

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                 Resource
				env.IMAGES_BIND         Images

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});
	});

	describe("python", () => {
		it("should upload python module defined in wrangler.toml", async () => {
			writeWranglerConfig({
				main: "index.py",
				compatibility_flags: ["python_workers"],
			});
			const expectedModules = {
				"index.py":
					"from js import Response;\ndef fetch(request):\n return Response.new('hello')",
			};
			await fs.promises.writeFile("index.py", expectedModules["index.py"]);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedMainModule: "index.py",
				expectedModules,
			});

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
		});

		it("should print vendor modules correctly in table", async () => {
			writeWranglerConfig({
				main: "src/index.py",
				compatibility_flags: ["python_workers"],
				// python_modules.exclude is set to `**/*.pyc` by default
			});

			// Create main Python file
			const mainPython =
				"from js import Response;\ndef fetch(request):\n return Response.new('hello')";
			await fs.promises.mkdir("src", { recursive: true });
			await fs.promises.writeFile("src/index.py", mainPython);

			// Create vendor directory and files
			await fs.promises.mkdir("python_modules", { recursive: true });
			await fs.promises.writeFile(
				"python_modules/module1.so",
				"binary content for module 1"
			);
			await fs.promises.writeFile(
				"python_modules/module2.py",
				"# Python vendor module 2\nprint('hello')"
			);

			await fs.promises.writeFile(
				"python_modules/test.pyc",
				"this shouldn't be deployed"
			);
			await fs.promises.mkdir("python_modules/other", { recursive: true });
			await fs.promises.writeFile(
				"python_modules/other/test.pyc",
				"this shouldn't be deployed"
			);

			// Create a regular Python module
			await fs.promises.writeFile(
				"src/helper.py",
				"# Helper module\ndef helper(): pass"
			);

			const expectedModules = {
				"index.py": mainPython,
				"helper.py": "# Helper module\ndef helper(): pass",
				"python_modules/module1.so": "binary content for module 1",
				"python_modules/module2.py": "# Python vendor module 2\nprint('hello')",
			};

			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedMainModule: "index.py",
				expectedModules,
				excludedModules: [
					"python_modules/test.pyc",
					"python_modules/other/test.pyc",
				],
			});

			await runWrangler("deploy");

			// Check that the table output shows vendor modules aggregated correctly
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				┌─┬─┬─┐
				│ Name │ Type │ Size │
				├─┼─┼─┤
				│ helper.py │ python │ xx KiB │
				├─┼─┼─┤
				│ Vendored Modules │ │ xx KiB │
				├─┼─┼─┤
				│ Total (3 modules) │ │ xx KiB │
				└─┴─┴─┘
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should upload python module specified in CLI args", async () => {
			writeWranglerConfig({
				compatibility_flags: ["python_workers"],
			});
			const expectedModules = {
				"index.py":
					"from js import Response;\ndef fetch(request):\n return Response.new('hello')",
			};
			await fs.promises.writeFile("index.py", expectedModules["index.py"]);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedMainModule: "index.py",
				expectedModules,
			});

			await runWrangler("deploy index.py");
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
		});
	});

	describe("hyperdrive", () => {
		it("should upload hyperdrive bindings", async () => {
			writeWranglerConfig({
				hyperdrive: [
					{
						binding: "HYPERDRIVE",
						id: "343cd4f1d58c42fbb5bd082592fd7143",
					},
				],
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "hyperdrive",
						name: "HYPERDRIVE",
						id: "343cd4f1d58c42fbb5bd082592fd7143",
					},
				],
			});

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                                                Resource
				env.HYPERDRIVE (343cd4f1d58c42fbb5bd082592fd7143)      Hyperdrive Config

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});
	});

	describe("vpc_services", () => {
		it("should upload VPC services bindings", async () => {
			writeWranglerConfig({
				vpc_services: [
					{
						binding: "VPC_SERVICE",
						service_id: "0199295b-b3ac-7760-8246-bca40877b3e9",
					},
				],
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "vpc_service",
						name: "VPC_SERVICE",
						service_id: "0199295b-b3ac-7760-8246-bca40877b3e9",
					},
				],
			});

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                                                     Resource
				env.VPC_SERVICE (0199295b-b3ac-7760-8246-bca40877b3e9)      VPC Service

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should upload multiple VPC services bindings", async () => {
			writeWranglerConfig({
				vpc_services: [
					{
						binding: "VPC_API",
						service_id: "0199295b-b3ac-7760-8246-bca40877b3e9",
					},
					{
						binding: "VPC_DATABASE",
						service_id: "0299295b-b3ac-7760-8246-bca40877b3e0",
					},
				],
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "vpc_service",
						name: "VPC_API",
						service_id: "0199295b-b3ac-7760-8246-bca40877b3e9",
					},
					{
						type: "vpc_service",
						name: "VPC_DATABASE",
						service_id: "0299295b-b3ac-7760-8246-bca40877b3e0",
					},
				],
			});

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                                                      Resource
				env.VPC_API (0199295b-b3ac-7760-8246-bca40877b3e9)           VPC Service
				env.VPC_DATABASE (0299295b-b3ac-7760-8246-bca40877b3e0)      VPC Service

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});
	});

	describe("mtls_certificates", () => {
		it("should upload mtls_certificate bindings", async () => {
			writeWranglerConfig({
				mtls_certificates: [{ binding: "CERT_ONE", certificate_id: "1234" }],
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "mtls_certificate",
						name: "CERT_ONE",
						certificate_id: "1234",
					},
				],
			});

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                  Resource
				env.CERT_ONE (1234)      mTLS Certificate

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});
	});

	describe("pipelines", () => {
		it("should upload pipelines bindings", async () => {
			writeWranglerConfig({
				pipelines: [
					{
						binding: "MY_PIPELINE",
						pipeline: "my-pipeline",
					},
				],
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "pipelines",
						name: "MY_PIPELINE",
						pipeline: "my-pipeline",
					},
				],
			});

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                            Resource
				env.MY_PIPELINE (my-pipeline)      Pipeline

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});
	});

	describe("secrets_store_secrets", () => {
		it("should upload secret store bindings", async () => {
			writeWranglerConfig({
				secrets_store_secrets: [
					{
						binding: "SECRET",
						store_id: "store_id",
						secret_name: "secret_name",
					},
				],
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "secrets_store_secret",
						name: "SECRET",
						store_id: "store_id",
						secret_name: "secret_name",
					},
				],
			});

			await runWrangler("deploy index.js");
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                                Resource
				env.SECRET (store_id/secret_name)      Secrets Store Secret

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});
	});

	describe("--keep-vars", () => {
		it("should send keepVars when keep-vars is passed in", async () => {
			vi.stubEnv("CLOUDFLARE_API_TOKEN", "hunter2");
			vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "some-account-id");
			setIsTTY(false);
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest({ keepVars: true, keepSecrets: true });
			mockOAuthServerCallback();
			mockGetMemberships([]);

			await runWrangler("deploy index.js --keep-vars");

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

		it("should not send keepVars by default", async () => {
			vi.stubEnv("CLOUDFLARE_API_TOKEN", "hunter2");
			vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "some-account-id");
			setIsTTY(false);
			writeWranglerConfig();
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest();
			mockOAuthServerCallback();
			mockGetMemberships([]);

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

		it("should send keepVars when `keep_vars = true`", async () => {
			vi.stubEnv("CLOUDFLARE_API_TOKEN", "hunter2");
			vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "some-account-id");
			setIsTTY(false);
			writeWranglerConfig({
				keep_vars: true,
			});
			writeWorkerSource();
			mockSubDomainRequest();
			mockUploadWorkerRequest({ keepVars: true, keepSecrets: true });
			mockOAuthServerCallback();
			mockGetMemberships([]);

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
	});

	describe("--metafile", () => {
		it("should output a metafile when --metafile is set", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			await runWrangler("deploy index.js --metafile --dry-run --outdir=dist");

			// Check if file exists
			const metafilePath = path.join(process.cwd(), "dist", "bundle-meta.json");
			expect(fs.existsSync(metafilePath)).toBe(true);
			const metafile = JSON.parse(fs.readFileSync(metafilePath, "utf8"));
			expect(metafile.inputs).toBeDefined();
			expect(metafile.outputs).toBeDefined();
		});

		it("should output a metafile when --metafile=./meta.json is set", async () => {
			writeWranglerConfig();
			writeWorkerSource();
			await runWrangler("deploy index.js --metafile=./meta.json --dry-run");

			// Check if file exists
			const metafilePath = path.join(process.cwd(), "meta.json");
			expect(fs.existsSync(metafilePath)).toBe(true);
			const metafile = JSON.parse(fs.readFileSync(metafilePath, "utf8"));
			expect(metafile.inputs).toBeDefined();
			expect(metafile.outputs).toBeDefined();
		});
	});

	describe("--dispatch-namespace", () => {
		it("should upload to dispatch namespace", async () => {
			writeWranglerConfig();
			const scriptContent = `
      export default {
				fetch() {
					return new Response("Hello, World!");
				}
			}
    `;
			fs.writeFileSync("index.js", scriptContent);
			mockUploadWorkerRequest({
				expectedMainModule: "index.js",
				expectedDispatchNamespace: "test-dispatch-namespace",
			});

			await runWrangler(
				"deploy --dispatch-namespace test-dispatch-namespace index.js"
			);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Uploaded test-name (TIMINGS)
				  Dispatch Namespace: test-dispatch-namespace
				Current Version ID: undefined"
			`);
		});
	});

	describe("[observability]", () => {
		it("should allow uploading workers with observability", async () => {
			writeWranglerConfig({
				observability: {
					enabled: true,
					head_sampling_rate: 0.5,
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedObservability: {
					enabled: true,
					head_sampling_rate: 0.5,
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
		});

		it("should allow uploading workers with nested observability logs setting", async () => {
			writeWranglerConfig({
				observability: {
					enabled: true,
					head_sampling_rate: 0.5,
					logs: {
						enabled: true,
						head_sampling_rate: 0.3,
						destinations: ["cloudflare", "foo"],
						persist: false,
						invocation_logs: false,
					},
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedObservability: {
					enabled: true,
					head_sampling_rate: 0.5,
					logs: {
						enabled: true,
						head_sampling_rate: 0.3,
						destinations: ["cloudflare", "foo"],
						persist: false,
						invocation_logs: false,
					},
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
		});

		it("should allow uploading workers with nested observability traces setting", async () => {
			writeWranglerConfig({
				observability: {
					enabled: true,
					head_sampling_rate: 0.5,
					traces: {
						enabled: true,
						head_sampling_rate: 0.3,
						destinations: ["cloudflare", "foo"],
						persist: false,
					},
				},
			});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedObservability: {
					enabled: true,
					head_sampling_rate: 0.5,
					traces: {
						enabled: true,
						head_sampling_rate: 0.3,
						destinations: ["cloudflare", "foo"],
						persist: false,
					},
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
		});

		it("should disable observability if not explicitly defined", async () => {
			writeWranglerConfig({});
			await fs.promises.writeFile("index.js", `export default {};`);
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedSettingsPatch: {
					observability: {
						enabled: false,
					},
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
		});
	});

	describe("workflows", () => {
		function mockDeployWorkflow(expectedWorkflowName?: string) {
			const handler = http.put(
				"*/accounts/:accountId/workflows/:workflowName",
				({ params }) => {
					if (expectedWorkflowName) {
						expect(params.workflowName).toBe(expectedWorkflowName);
					}
					return HttpResponse.json(
						createFetchResult({ id: "mock-new-workflow-id" })
					);
				}
			);
			msw.use(handler);
		}

		beforeEach(() => {
			msw.use(
				http.get("*/accounts/:accountId/workflows/:workflowName", () => {
					return HttpResponse.json(
						{
							success: false,
							errors: [{ code: 10200, message: "Workflow not found" }],
							messages: [],
							result: null,
						},
						{ status: 404 }
					);
				})
			);
		});

		it("should deploy a workflow", async () => {
			writeWranglerConfig({
				main: "index.js",
				workflows: [
					{
						binding: "WORKFLOW",
						name: "my-workflow",
						class_name: "MyWorkflow",
					},
				],
			});
			await fs.promises.writeFile(
				"index.js",
				`
                import { WorkflowEntrypoint } from 'cloudflare:workers';
                export default {};
                export class MyWorkflow extends WorkflowEntrypoint {};
            `
			);

			mockDeployWorkflow("my-workflow");
			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedBindings: [
					{
						type: "workflow",
						name: "WORKFLOW",
						workflow_name: "my-workflow",
						class_name: "MyWorkflow",
					},
				],
			});

			await runWrangler("deploy");

			expect(std.warn).toMatchInlineSnapshot(`""`);
			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                        Resource
				env.WORKFLOW (MyWorkflow)      Workflow

				Uploaded test-name (TIMINGS)
				Deployed test-name triggers (TIMINGS)
				  https://test-name.test-sub-domain.workers.dev
				  workflow: my-workflow
				Current Version ID: Galaxy-Class"
			`);
		});

		it("should not call Workflow's API if the workflow binds to another script", async () => {
			writeWranglerConfig({
				main: "index.js",
				name: "this-script",
				workflows: [
					{
						binding: "WORKFLOW",
						name: "my-workflow",
						class_name: "MyWorkflow",
						script_name: "another-script",
					},
				],
			});

			mockSubDomainRequest();
			mockUploadWorkerRequest({
				expectedScriptName: "this-script",
				expectedBindings: [
					{
						type: "workflow",
						name: "WORKFLOW",
						workflow_name: "my-workflow",
						class_name: "MyWorkflow",
						script_name: "another-script",
					},
				],
			});

			const handler = http.put(
				"*/accounts/:accountId/workflows/:workflowName",
				() => {
					expect(
						false,
						"Workflows API should not be called at all, in this case."
					);
				}
			);
			msw.use(handler);
			await fs.promises.writeFile(
				"index.js",
				`
                export default {};
            `
			);

			await runWrangler("deploy");

			expect(std.out).toMatchInlineSnapshot(`
				"
				 ⛅️ wrangler x.x.x
				──────────────────
				Total Upload: xx KiB / gzip: xx KiB
				Worker Startup Time: 100 ms
				Your Worker has access to the following bindings:
				Binding                                                    Resource
				env.WORKFLOW (MyWorkflow (defined in another-script))      Workflow

				Uploaded this-script (TIMINGS)
				Deployed this-script triggers (TIMINGS)
				  https://this-script.test-sub-domain.workers.dev
				Current Version ID: Galaxy-Class"
			`);
		});

		describe("workflow conflict detection", () => {
			function mockGetWorkflow(
				workflowsByName: Record<
					string,
					{
						id: string;
						name: string;
						script_name: string;
						class_name: string;
						created_on: string;
						modified_on: string;
					} | null
				>
			) {
				msw.use(
					http.get(
						"*/accounts/:accountId/workflows/:workflowName",
						({ params }) => {
							const workflow = workflowsByName[params.workflowName as string];
							if (workflow === null || workflow === undefined) {
								return HttpResponse.json(
									{
										success: false,
										errors: [
											{ code: WORKFLOW_NOT_FOUND_CODE, message: "Not found" },
										],
										messages: [],
										result: null,
									},
									{ status: 404 }
								);
							}
							return HttpResponse.json({
								success: true,
								errors: [],
								messages: [],
								result: workflow,
							});
						}
					)
				);
			}

			it("should warn when deploying a workflow that belongs to a different worker", async () => {
				writeWranglerConfig({
					main: "index.js",
					workflows: [
						{
							binding: "WORKFLOW",
							name: "my-workflow",
							class_name: "MyWorkflow",
						},
					],
				});
				await fs.promises.writeFile(
					"index.js",
					`
					import { WorkflowEntrypoint } from 'cloudflare:workers';
					export default {};
					export class MyWorkflow extends WorkflowEntrypoint {};
				`
				);

				mockGetWorkflow({
					"my-workflow": {
						id: "existing-workflow-id",
						name: "my-workflow",
						script_name: "other-worker",
						class_name: "SomeClass",
						created_on: "2024-01-01T00:00:00Z",
						modified_on: "2024-01-01T00:00:00Z",
					},
				});

				mockSubDomainRequest();
				mockUploadWorkerRequest();
				mockDeployWorkflow("my-workflow");

				mockConfirm({
					text: "Do you want to continue?",
					result: true,
				});

				await runWrangler("deploy");

				expect(std.warn).toContain(
					"already exist and belong to different workers"
				);
				expect(std.warn).toContain(
					'"my-workflow" (currently belongs to "other-worker")'
				);
				expect(std.warn).toContain(
					'Deploying will reassign these workflows to "test-name".'
				);
			});

			it("should abort deploy when user declines the workflow conflict confirmation", async () => {
				writeWranglerConfig({
					main: "index.js",
					workflows: [
						{
							binding: "WORKFLOW",
							name: "my-workflow",
							class_name: "MyWorkflow",
						},
					],
				});
				await fs.promises.writeFile(
					"index.js",
					`
					import { WorkflowEntrypoint } from 'cloudflare:workers';
					export default {};
					export class MyWorkflow extends WorkflowEntrypoint {};
				`
				);

				mockGetWorkflow({
					"my-workflow": {
						id: "existing-workflow-id",
						name: "my-workflow",
						script_name: "other-worker",
						class_name: "SomeClass",
						created_on: "2024-01-01T00:00:00Z",
						modified_on: "2024-01-01T00:00:00Z",
					},
				});

				mockConfirm({
					text: "Do you want to continue?",
					result: false,
				});

				await runWrangler("deploy");

				expect(std.warn).toContain(
					"already exist and belong to different workers"
				);
				expect(std.out).not.toContain("Uploaded");
			});

			it("should not warn when workflow belongs to the same worker", async () => {
				writeWranglerConfig({
					main: "index.js",
					workflows: [
						{
							binding: "WORKFLOW",
							name: "my-workflow",
							class_name: "MyWorkflow",
						},
					],
				});
				await fs.promises.writeFile(
					"index.js",
					`
					import { WorkflowEntrypoint } from 'cloudflare:workers';
					export default {};
					export class MyWorkflow extends WorkflowEntrypoint {};
				`
				);

				mockGetWorkflow({
					"my-workflow": {
						id: "existing-workflow-id",
						name: "my-workflow",
						script_name: "test-name",
						class_name: "MyWorkflow",
						created_on: "2024-01-01T00:00:00Z",
						modified_on: "2024-01-01T00:00:00Z",
					},
				});

				mockSubDomainRequest();
				mockUploadWorkerRequest();
				mockDeployWorkflow("my-workflow");

				await runWrangler("deploy");

				expect(std.warn).not.toContain(
					"already exist and belong to different workers"
				);
				expect(std.out).toContain("Uploaded test-name");
			});

			it("should not warn when workflow does not exist yet", async () => {
				writeWranglerConfig({
					main: "index.js",
					workflows: [
						{
							binding: "WORKFLOW",
							name: "my-workflow",
							class_name: "MyWorkflow",
						},
					],
				});
				await fs.promises.writeFile(
					"index.js",
					`
					import { WorkflowEntrypoint } from 'cloudflare:workers';
					export default {};
					export class MyWorkflow extends WorkflowEntrypoint {};
				`
				);

				mockGetWorkflow({
					"my-workflow": null,
				});

				mockSubDomainRequest();
				mockUploadWorkerRequest();
				mockDeployWorkflow("my-workflow");

				await runWrangler("deploy");

				expect(std.warn).not.toContain(
					"already exist and belong to different workers"
				);
				expect(std.out).toContain("Uploaded test-name");
			});

			it("should warn about multiple conflicting workflows", async () => {
				writeWranglerConfig({
					main: "index.js",
					workflows: [
						{
							binding: "WORKFLOW1",
							name: "workflow-one",
							class_name: "WorkflowOne",
						},
						{
							binding: "WORKFLOW2",
							name: "workflow-two",
							class_name: "WorkflowTwo",
						},
					],
				});
				await fs.promises.writeFile(
					"index.js",
					`
					import { WorkflowEntrypoint } from 'cloudflare:workers';
					export default {};
					export class WorkflowOne extends WorkflowEntrypoint {};
					export class WorkflowTwo extends WorkflowEntrypoint {};
				`
				);

				mockGetWorkflow({
					"workflow-one": {
						id: "existing-workflow-1",
						name: "workflow-one",
						script_name: "other-worker-a",
						class_name: "SomeClass",
						created_on: "2024-01-01T00:00:00Z",
						modified_on: "2024-01-01T00:00:00Z",
					},
					"workflow-two": {
						id: "existing-workflow-2",
						name: "workflow-two",
						script_name: "other-worker-b",
						class_name: "AnotherClass",
						created_on: "2024-01-01T00:00:00Z",
						modified_on: "2024-01-01T00:00:00Z",
					},
				});

				mockSubDomainRequest();
				mockUploadWorkerRequest();
				mockDeployWorkflow();

				mockConfirm({
					text: "Do you want to continue?",
					result: true,
				});

				await runWrangler("deploy");

				expect(std.warn).toContain(
					'"workflow-one" (currently belongs to "other-worker-a")'
				);
				expect(std.warn).toContain(
					'"workflow-two" (currently belongs to "other-worker-b")'
				);
			});

			it("should skip workflow conflict check in non-interactive mode without --strict", async () => {
				setIsTTY(false);

				writeWranglerConfig({
					main: "index.js",
					workflows: [
						{
							binding: "WORKFLOW",
							name: "my-workflow",
							class_name: "MyWorkflow",
						},
					],
				});
				await fs.promises.writeFile(
					"index.js",
					`
					import { WorkflowEntrypoint } from 'cloudflare:workers';
					export default {};
					export class MyWorkflow extends WorkflowEntrypoint {};
				`
				);

				// Note: we don't mock the workflows API endpoint - if it's called, the test will fail
				mockSubDomainRequest();
				mockUploadWorkerRequest();
				mockDeployWorkflow("my-workflow");

				await runWrangler("deploy");

				// Should deploy without warning (check was skipped)
				expect(std.warn).not.toContain(
					"already exist and belong to different workers"
				);
				expect(std.out).toContain("Uploaded test-name");
			});

			it("should abort deploy in non-interactive strict mode when workflow belongs to different worker", async () => {
				setIsTTY(false);

				writeWranglerConfig({
					main: "index.js",
					workflows: [
						{
							binding: "WORKFLOW",
							name: "my-workflow",
							class_name: "MyWorkflow",
						},
					],
				});
				await fs.promises.writeFile(
					"index.js",
					`
					import { WorkflowEntrypoint } from 'cloudflare:workers';
					export default {};
					export class MyWorkflow extends WorkflowEntrypoint {};
				`
				);

				mockGetWorkflow({
					"my-workflow": {
						id: "existing-workflow-id",
						name: "my-workflow",
						script_name: "other-worker",
						class_name: "SomeClass",
						created_on: "2024-01-01T00:00:00Z",
						modified_on: "2024-01-01T00:00:00Z",
					},
				});

				await runWrangler("deploy --strict");

				expect(std.warn).toContain(
					"already exist and belong to different workers"
				);
				expect(std.err).toContain(
					"Aborting the deployment operation because of conflicts"
				);
				expect(std.out).not.toContain("Uploaded");
				expect(process.exitCode).not.toBe(0);
			});
		});
	});
});
