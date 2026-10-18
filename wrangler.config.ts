import { defineWranglerConfig } from "wrangler/experimental-config";

/**
 * Wrangler bundler（`cf build` / `cf deploy` が使う）向けのビルド設定。
 * Worker 名・binding・ドメインは cloudflare.config.ts が持つ。
 * 静的アセットの配置は wrangler.jsonc の `assets.directory` と揃える
 * （一致は test/deploy-config.test.ts が検査する）。
 */
export default defineWranglerConfig({
	assetsDirectory: "./public",
});
