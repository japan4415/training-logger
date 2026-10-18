import { bindings, defineConfig } from "cf/config";

/**
 * `cf build` / `cf deploy`（Workers Builds の build / deploy command）が読む設定。
 * Programmatic configuration は open beta なので、変更時は `cf deploy --dry-run` で検証する。
 *
 * `wrangler.jsonc` は次の用途で残す（cf は wrangler.jsonc を読まず、wrangler は
 * cloudflare.config.ts を読まない）:
 *
 * - `@cloudflare/vitest-pool-workers`（wrangler 形式の config しか受け付けない）
 * - `wrangler dev` / `wrangler tail`
 * - D1 マイグレーションの適用
 *
 * 両者が同じ Worker を定義していることは test/deploy-config.test.ts が検査する。
 * 静的アセットの配置（`assets`）は wrangler.config.ts が持つ。
 */
export default defineConfig({
	worker: {
		name: "training-logger",
		compatibilityDate: "2026-08-01",
		// global_fetch_strictly_public は CIMD（Client ID Metadata Document）取得の SSRF 対策。
		// CIMD の取得が使う fetch の cache option に互換日付 2024-11-11 以降が必要で、
		// 2026-08-01 は満たしている（この日付要件はフラグ自体ではなく fetch の API 要件）。
		compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
		entrypoint: "src/index.ts",
		workersDev: false,
		observability: {
			enabled: true,
			headSamplingRate: 1,
			traces: {
				enabled: true,
				headSamplingRate: 1,
			},
		},
		// wrangler の `routes[].custom_domain: true` に対応する。
		domains: ["training-logger.discord.jp"],
		// D1 の `migrations_dir` は cf の設定に無い（cf migrate の既知の follow-up）。
		// 適用先は cf 側の設定ではなくコマンドで指定する:
		//   本番: pnpm run db:migrate
		//   ローカル: pnpm run db:migrate:local（--persist-to .wrangler/state で wrangler dev と共有）
		env: {
			DB: bindings.d1({
				name: "training-logger-db",
				id: "fed11dc7-680c-4245-a3db-95e73f4ddebe",
			}),
			OAUTH_KV: bindings.kv({
				id: "6bfe4841510f4c56b4c12db5a6edb362",
			}),
			PHOTOS: bindings.r2({
				name: "training-logger-photos",
			}),
		},
	},
});
