import type { FC } from "hono/jsx";

const groups = {
	chest: ["pectoralis major"],
	shoulders: ["deltoid"],
	biceps: ["biceps brachii", "brachialis"],
	triceps: ["triceps brachii"],
	forearms: ["brachioradialis", "flexor carpi", "extensor carpi", "pronator"],
	back: ["trapezius", "rhomboid", "infraspinatus", "teres major"],
	abs: ["external oblique"],
	glutes: ["gluteus"],
	quads: ["rectus femoris", "vastus"],
	hamstrings: ["biceps femoris", "semitendinosus", "semimembranosus"],
	calves: ["gastrocnemius", "soleus"],
	adductors: ["adductor", "gracilis"],
};

const aliases: Record<string, string[]> = Object.create(null);
function register(names: string[], patterns: string[]) {
	for (const name of names) aliases[name] = patterns;
}
register(["胸", "胸筋", "大胸筋", "chest", "pectoralis major"], groups.chest);
register(["肩", "三角筋", "shoulders", "deltoid"], groups.shoulders);
register(["上腕二頭筋", "二頭筋", "biceps"], groups.biceps);
register(["上腕三頭筋", "三頭筋", "triceps"], groups.triceps);
register(["前腕", "前腕筋", "forearms"], groups.forearms);
register(["腕", "上腕", "arms"], [...groups.biceps, ...groups.triceps]);
register(["背中", "背筋", "back"], groups.back);
register(["僧帽筋", "trapezius"], ["trapezius"]);
register(["菱形筋", "rhomboids"], ["rhomboid"]);
register(
	["腹筋", "腹", "腹斜筋", "外腹斜筋", "abs", "core", "体幹"],
	groups.abs,
);
register(["臀部", "殿部", "お尻", "臀筋", "殿筋", "glutes"], groups.glutes);
register(["大臀筋", "大殿筋"], ["gluteus maximus"]);
register(["中臀筋", "中殿筋"], ["gluteus medius"]);
register(
	["大腿四頭筋", "もも前", "太もも前", "quads", "quadriceps"],
	groups.quads,
);
register(
	["ハムストリング", "ハムストリングス", "もも裏", "太もも裏", "hamstrings"],
	groups.hamstrings,
);
register(["ふくらはぎ", "下腿", "下腿三頭筋", "calves"], groups.calves);
register(["腓腹筋"], ["gastrocnemius"]);
register(["ヒラメ筋"], ["soleus"]);
register(["内転筋", "内もも", "内腿", "adductors"], groups.adductors);
register(
	["脚", "足", "下半身", "legs"],
	[
		...groups.quads,
		...groups.hamstrings,
		...groups.calves,
		...groups.adductors,
		...groups.glutes,
	],
);
register(
	["太もも", "大腿"],
	[...groups.quads, ...groups.hamstrings, ...groups.adductors],
);

/** Exact aliases only: unknown free text must never highlight an unrelated muscle. */
export function resolveAtlasMuscles(muscles: string[]) {
	const patterns = new Set<string>();
	const unmapped: string[] = [];
	for (const muscle of muscles) {
		const matches = aliases[muscle.normalize("NFKC").trim().toLowerCase()];
		if (matches) for (const pattern of matches) patterns.add(pattern);
		else unmapped.push(muscle);
	}
	return { patterns: [...patterns], unmapped };
}

export const MuscleMap: FC<{ muscles: string[] }> = ({ muscles }) => {
	if (muscles.length === 0) return null;
	const { patterns, unmapped } = resolveAtlasMuscles(muscles);
	return (
		<section
			class="muscle-atlas target-muscles-summary"
			aria-labelledby="atlas-heading"
			data-muscles={JSON.stringify(patterns)}
		>
			<div class="atlas-heading-row">
				<div>
					<p class="atlas-eyebrow">WORKOUT ATLAS</p>
					<h2 id="atlas-heading">
						鍛えた部位<span class="atlas-heading-colon">:</span>
					</h2>
				</div>
				<span class="atlas-count">
					{muscles.length}
					<small>部位</small>
				</span>
			</div>
			<p class="atlas-description">このセッションで完了した種目の対象部位</p>
			{patterns.length > 0 && (
				<>
					<div class="atlas-stage">
						<p class="atlas-status" role="status">
							立体モデルを読み込んでいます…
						</p>
					</div>
					<div class="atlas-toolbar">
						<span class="atlas-legend">
							<i aria-hidden="true" />
							鍛えた部位
						</span>
						<fieldset class="atlas-controls" aria-label="体の向き">
							<button
								type="button"
								data-atlas-view="front"
								aria-pressed="true"
								disabled
							>
								正面
							</button>
							<button
								type="button"
								data-atlas-view="back"
								aria-pressed="false"
								disabled
							>
								背面
							</button>
						</fieldset>
					</div>
					<p class="atlas-hint">
						左右にドラッグして回転 · キーボードの ← → でも操作
					</p>
					<noscript>
						<p class="atlas-note">
							立体表示にはJavaScriptが必要です。鍛えた部位は下の一覧で確認できます。
						</p>
					</noscript>
				</>
			)}
			<div class="target-muscles-tags">
				{muscles.map((muscle) => (
					<span
						class={`target-muscle-tag${unmapped.includes(muscle) ? " atlas-unmapped" : ""}`}
						key={muscle}
					>
						{muscle}
					</span>
				))}
			</div>
			{unmapped.length > 0 && (
				<p class="atlas-note">
					モデル未対応（名称のみ表示）: {unmapped.join("、")}
				</p>
			)}
			<p class="atlas-note">
				部位の位置を示す参考表示です。背中・腹筋などの広い部位は、モデルに含まれる一部の筋肉を表示します。
			</p>
			<div class="atlas-credit">
				<a href="https://github.com/ashemag/human-atlas">Human Atlas</a>
				<span> / </span>
				<a href="/models/human-atlas/ATTRIBUTION.md">
					BodyParts3D · CC BY 4.0 / 出典
				</a>
			</div>
			{patterns.length > 0 && <script src="/js/muscle-atlas.js" defer></script>}
		</section>
	);
};
