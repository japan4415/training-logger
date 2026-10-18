// `cf build` / `cf deploy` が読む cloudflare.config.ts・wrangler.config.ts と、
// vitest-pool-workers・`wrangler dev`・D1 マイグレーションが読む wrangler.jsonc の
// drift を止めるテスト。cf は wrangler.jsonc を読まず、wrangler は cloudflare.config.ts を
// 読まないため、片側だけ更新するとローカルと本番で挙動がずれる。
import { describe, expect, it } from "vitest";
import cloudflareConfig from "../cloudflare.config";
import wranglerConfig from "../wrangler.config";
import wranglerJsonc from "../wrangler.jsonc?raw";

type WranglerJsonc = {
	name: string;
	main: string;
	compatibility_date: string;
	compatibility_flags: string[];
	workers_dev: boolean;
	routes: { pattern: string; custom_domain?: boolean }[];
	assets: { directory: string };
	d1_databases: {
		binding: string;
		database_name: string;
		database_id: string;
	}[];
	r2_buckets: { binding: string; bucket_name: string }[];
	kv_namespaces: { binding: string; id: string }[];
	observability: {
		enabled: boolean;
		head_sampling_rate: number;
		traces: { enabled: boolean; head_sampling_rate: number };
	};
};

/** wrangler.jsonc はコメント付き JSON なので、行コメントだけ落として読む。 */
function parseWranglerJsonc(text: string): WranglerJsonc {
	return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as WranglerJsonc;
}

/** binding を検査しやすいように緩く型付けした view。 */
type BindingView = { type: string; id?: string; name?: string };

const wrangler = parseWranglerJsonc(wranglerJsonc);
const worker = cloudflareConfig.worker;
const env = worker.env as unknown as Record<string, BindingView>;

describe("deploy configuration", () => {
	it("identifies the same Worker", () => {
		expect(worker.name).toBe(wrangler.name);
		expect(worker.entrypoint).toBe(wrangler.main);
		expect(worker.compatibilityDate).toBe(wrangler.compatibility_date);
		expect([...worker.compatibilityFlags].sort()).toEqual(
			[...wrangler.compatibility_flags].sort(),
		);
		expect(worker.workersDev).toBe(wrangler.workers_dev);
	});

	it("serves the same custom domain", () => {
		const wranglerDomains = wrangler.routes
			.filter((route) => route.custom_domain === true)
			.map((route) => route.pattern);
		expect(worker.domains).toEqual(wranglerDomains);
	});

	it("keeps observability settings in sync", () => {
		expect(worker.observability.enabled).toBe(wrangler.observability.enabled);
		expect(worker.observability.headSamplingRate).toBe(
			wrangler.observability.head_sampling_rate,
		);
		expect(worker.observability.traces.enabled).toBe(
			wrangler.observability.traces.enabled,
		);
		expect(worker.observability.traces.headSamplingRate).toBe(
			wrangler.observability.traces.head_sampling_rate,
		);
	});

	it("binds the same D1 database, KV namespace, and R2 bucket", () => {
		expect(Object.keys(env).sort()).toEqual(
			[
				...wrangler.d1_databases.map((database) => database.binding),
				...wrangler.kv_namespaces.map((namespace) => namespace.binding),
				...wrangler.r2_buckets.map((bucket) => bucket.binding),
			].sort(),
		);

		for (const database of wrangler.d1_databases) {
			expect(env[database.binding]).toMatchObject({
				type: "d1",
				name: database.database_name,
				id: database.database_id,
			});
		}

		for (const namespace of wrangler.kv_namespaces) {
			expect(env[namespace.binding]).toMatchObject({
				type: "kv",
				id: namespace.id,
			});
		}

		for (const bucket of wrangler.r2_buckets) {
			expect(env[bucket.binding]).toMatchObject({
				type: "r2",
				name: bucket.bucket_name,
			});
		}
	});

	it("builds the same static assets directory", () => {
		expect(wranglerConfig.assetsDirectory).toBe(wrangler.assets.directory);
	});
});
