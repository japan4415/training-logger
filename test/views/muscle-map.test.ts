import { renderToString } from "hono/jsx/dom/server";
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import atlas from "../../public/models/human-atlas/atlas.json";
import {
	getExerciseAnatomy,
	MuscleMap,
	resolveAtlasMuscles,
	splitAtlasMuscles,
} from "../../src/views/components/muscle-map.js";

function render(muscles: string[]) {
	return renderToString(jsx(MuscleMap, { muscles }));
}

describe("Human Atlas muscle map", () => {
	it("uses exact assigned IDs and keeps explicit emptiness distinct from legacy fallback", () => {
		const assignment = {
			primary: ["FJ1394"],
			secondary: ["FJ1437"],
			unavailable: ["広背筋"],
		};
		const anatomy = getExerciseAnatomy({
			target_muscles: "胸",
			atlas_muscles: JSON.stringify(assignment),
		});
		expect(anatomy).toEqual({ assignment, legacy: false });
		const html = renderToString(
			jsx(MuscleMap, { anatomy, context: "exercise" }),
		);
		expect(html).toContain('data-primary-ids="[&quot;FJ1394&quot;]"');
		expect(html).toContain('data-secondary-ids="[&quot;FJ1437&quot;]"');
		expect(html).toContain("data-atlas-xray");
		expect(html).toContain('class="atlas-count">3<small>対象</small>');
		expect(html).toContain("補助・安定化");
		expect(html).not.toContain("大胸筋");
		expect(html).not.toContain("FJ1394M");
		const empty = getExerciseAnatomy({
			target_muscles: "胸",
			atlas_muscles: JSON.stringify({
				primary: [],
				secondary: [],
				unavailable: [],
			}),
		});
		expect(renderToString(jsx(MuscleMap, { anatomy: empty }))).toBe("");
		expect(
			renderToString(jsx(MuscleMap, { anatomy: empty, context: "exercise" })),
		).toContain("対象筋肉がまだ設定されていません");
		const legacy = getExerciseAnatomy({
			target_muscles: "胸",
			atlas_muscles: null,
		});
		expect(legacy.legacy).toBe(true);
		expect(legacy.assignment.primary).toContain("FJ1446");
	});
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
		expect(render(["", " ・ ,、/；;\n "])).toBe("");
		expect(resolveAtlasMuscles(["", "  "])).toEqual({
			patterns: [],
			unmapped: [],
		});
	});

	it("splits common separators, trims names and removes duplicate labels", () => {
		expect(
			splitAtlasMuscles([
				" 胸・肩･腕,前腕，背中、腹筋/脚／下腿;臀部；内転筋\n胸",
				" 肩 ",
				"",
			]),
		).toEqual([
			"胸",
			"肩",
			"腕",
			"前腕",
			"背中",
			"腹筋",
			"脚",
			"下腿",
			"臀部",
			"内転筋",
		]);
	});

	it.each([
		["下半身・心肺", "rectus femoris", "心肺", "下半身"],
		["ふくらはぎ・足首", "gastrocnemius", "足首", "ふくらはぎ"],
		["肩・肩甲帯", "deltoid", "肩甲帯", "肩"],
	])(
		"renders the supported part of compound label %s",
		(label, pattern, unknown, known) => {
			const resolved = resolveAtlasMuscles([label, known]);
			expect(resolved.patterns).toContain(pattern);
			expect(resolved.unmapped).toEqual([unknown]);
			const html = render([label, known]);
			expect(html).toContain('class="atlas-stage"');
			expect(html).toContain('src="/js/muscle-atlas.js"');
			expect(html).toContain("<small>対象</small>");
			expect(html).toContain("data-primary-ids=");
			expect(html).toContain(`モデル未対応（名称のみ表示）: ${unknown}`);
			expect(html).not.toContain(label);
		},
	);

	it("keeps names readable without JavaScript and supplies only resolved patterns", () => {
		const html = render(["胸", "広背筋"]);
		expect(html).toContain(
			'data-primary-ids="[&quot;FJ1446&quot;,&quot;FJ1446M&quot;,&quot;FJ1447&quot;,&quot;FJ1447M&quot;,&quot;FJ1464&quot;,&quot;FJ1464M&quot;]"',
		);
		expect(html).toContain("<noscript>");
		expect(html).toContain("大胸筋</span>");
		expect(html).toContain("モデル未対応（名称のみ表示）: 広背筋");
		expect(html).toContain('src="/js/muscle-atlas.js"');
	});

	it("escapes unsupported names and avoids loading an empty 3D model", () => {
		const html = render(['<img src=x onerror="alert(1)">']);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
		expect(html).toContain('data-primary-ids="[]"');
		expect(html).not.toContain('class="atlas-stage"');
		expect(html).not.toContain('src="/js/muscle-atlas.js"');
	});
});
