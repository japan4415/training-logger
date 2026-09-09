import { renderToString } from "hono/jsx/dom/server";
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import atlas from "../../public/models/human-atlas/atlas.json";
import {
	MuscleMap,
	resolveAtlasMuscles,
} from "../../src/views/components/muscle-map.js";

function render(muscles: string[]) {
	return renderToString(jsx(MuscleMap, { muscles }));
}

describe("Human Atlas muscle map", () => {
	it("normalizes aliases and deduplicates overlapping training regions", () => {
		expect(
			resolveAtlasMuscles([" 胸 ", "ＣＨＥＳＴ", "胸筋", "腕", "二頭筋"]),
		).toEqual({
			patterns: [
				"pectoralis major",
				"biceps brachii",
				"brachialis",
				"triceps brachii",
			],
			unmapped: [],
		});
	});

	it("keeps unsupported free text without guessing an unrelated region", () => {
		const muscles = [
			"広背筋",
			"腹直筋",
			"胸の周辺",
			"",
			"__proto__",
			"constructor",
		];
		expect(resolveAtlasMuscles(muscles)).toEqual({
			patterns: [],
			unmapped: muscles,
		});
	});

	it("resolves every supported group to muscles present in the shipped atlas", () => {
		const regions = [
			"胸",
			"肩",
			"腕",
			"前腕",
			"背中",
			"腹筋",
			"脚",
			"大臀筋",
			"中臀筋",
		];
		const { patterns, unmapped } = resolveAtlasMuscles(regions);
		expect(unmapped).toEqual([]);
		for (const pattern of patterns) {
			expect(
				atlas.parts.some(
					(part) =>
						part.system === "muscular" &&
						part.name.toLowerCase().includes(pattern),
				),
				`No atlas muscle matches ${pattern}`,
			).toBe(true);
		}
	});

	it("renders no map for a session without trained regions", () => {
		expect(render([])).toBe("");
	});

	it("keeps names readable without JavaScript and supplies only resolved patterns", () => {
		const html = render(["胸", "広背筋"]);
		expect(html).toContain('data-muscles="[&quot;pectoralis major&quot;]"');
		expect(html).toContain("<noscript>");
		expect(html).toContain("胸</span>");
		expect(html).toContain("モデル未対応（名称のみ表示）: 広背筋");
		expect(html).toContain('src="/js/muscle-atlas.js"');
	});

	it("escapes unsupported names and avoids loading an empty 3D model", () => {
		const html = render(['<img src=x onerror="alert(1)">']);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
		expect(html).toContain('data-muscles="[]"');
		expect(html).not.toContain('class="atlas-stage"');
		expect(html).not.toContain('src="/js/muscle-atlas.js"');
	});
});
