import type { FC } from "hono/jsx";
import type { SessionExerciseDetail } from "../../db/queries.js";
import type { ExerciseRow } from "../../db/types.js";
import {
	ATLAS_MUSCLES,
	type AtlasAssignment,
	atlasGroupLabels,
	mergeAtlasAssignments,
	parseAtlasAssignment,
} from "../../domain/atlas.js";

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

/** Split recorded lists, preserving English names containing spaces. */
export function splitAtlasMuscles(muscles: string[]): string[] {
	return [
		...new Set(
			muscles.flatMap((muscle) =>
				muscle
					.split(/[・･,，、/／;；\r\n]+/u)
					.map((part) => part.trim())
					.filter(Boolean),
			),
		),
	];
}

/** Match each complete list item; never guess from substrings in free text. */
export function resolveAtlasMuscles(muscles: string[]) {
	const patterns = new Set<string>();
	const unmapped: string[] = [];
	for (const muscle of splitAtlasMuscles(muscles)) {
		const matches = aliases[muscle.normalize("NFKC").trim().toLowerCase()];
		if (matches) for (const pattern of matches) patterns.add(pattern);
		else unmapped.push(muscle);
	}
	return { patterns: [...patterns], unmapped };
}

export interface AnatomyViewModel {
	assignment: AtlasAssignment;
	legacy: boolean;
}

function legacyAnatomy(muscles: string[]): AnatomyViewModel {
	const { patterns, unmapped } = resolveAtlasMuscles(muscles);
	return {
		assignment: {
			primary: ATLAS_MUSCLES.filter((part) =>
				patterns.some((pattern) => part.name.toLowerCase().includes(pattern)),
			).map((part) => part.id),
			secondary: [],
			unavailable: unmapped,
		},
		legacy: true,
	};
}

export function getExerciseAnatomy(
	exercise: Pick<ExerciseRow, "target_muscles" | "atlas_muscles">,
): AnatomyViewModel {
	const assignment = parseAtlasAssignment(exercise.atlas_muscles);
	return assignment
		? { assignment, legacy: false }
		: legacyAnatomy(exercise.target_muscles ? [exercise.target_muscles] : []);
}

export function getSessionAnatomy(
	exercises: SessionExerciseDetail[],
): AnatomyViewModel {
	const completed = exercises
		.filter(({ sessionExercise }) => sessionExercise.status === "completed")
		.map(({ exercise }) => getExerciseAnatomy(exercise));
	return {
		assignment: mergeAtlasAssignments(completed.map((item) => item.assignment)),
		legacy: completed.some(
			(item) =>
				item.legacy &&
				(item.assignment.primary.length > 0 ||
					item.assignment.unavailable.length > 0),
		),
	};
}

export const MuscleMap: FC<{
	muscles?: string[];
	anatomy?: AnatomyViewModel;
	context?: "session" | "exercise";
	category?: ExerciseRow["category"];
}> = ({ muscles = [], anatomy, context = "session", category }) => {
	const { assignment, legacy } = anatomy ?? legacyAnatomy(muscles);
	const { primary, secondary, unavailable } = assignment;
	const primaryLabels = atlasGroupLabels(primary);
	const secondaryLabels = atlasGroupLabels(secondary);
	const count = new Set([...primaryLabels, ...secondaryLabels, ...unavailable])
		.size;
	if (count === 0 && context === "session") return null;
	const hasModel = primary.length + secondary.length > 0;
	const isMobility = context === "exercise" && category === "flexibility";
	const isCardio = context === "exercise" && category === "cardio";
	const title =
		context === "session"
			? "鍛えた部位"
			: isMobility
				? "ストレッチ・可動域の対象筋"
				: "この種目で使う筋肉";
	const primaryLabel = isMobility
		? "主な対象"
		: isCardio
			? "主な使用筋"
			: "主な対象筋";
	const secondaryLabel = isMobility ? "関連する筋肉" : "補助・安定化";
	return (
		<section
			class="muscle-atlas target-muscles-summary"
			aria-labelledby="atlas-heading"
			data-primary-ids={JSON.stringify(primary)}
			data-secondary-ids={JSON.stringify(secondary)}
			data-atlas-label={`${primaryLabel}を青緑、${secondaryLabel}を青で示す人体図。左右矢印キーまたは横ドラッグで回転できます。`}
		>
			<div class="atlas-heading-row">
				<div>
					<p class="atlas-eyebrow">
						{context === "session" ? "WORKOUT ATLAS" : "EXERCISE ATLAS"}
					</p>
					<h2 id="atlas-heading">{title}</h2>
				</div>
				{count > 0 && (
					<span class="atlas-count">
						{count}
						<small>対象</small>
					</span>
				)}
			</div>
			<p class="atlas-description">
				{context === "session"
					? "完了した種目の対象筋をまとめて表示"
					: isMobility
						? "筋力負荷ではなく、可動域・ストレッチの対象を表示"
						: "種目の一般的な対象筋を表示"}
			</p>
			{count === 0 && (
				<p class="atlas-note">対象筋肉がまだ設定されていません。</p>
			)}
			{hasModel && (
				<>
					<div class="atlas-stage">
						<p class="atlas-status" role="status">
							立体モデルを読み込んでいます…
						</p>
					</div>
					<div class="atlas-toolbar">
						<div class="atlas-legends">
							<span class="atlas-legend">
								<i aria-hidden="true" />
								{primaryLabel}
							</span>
							{secondary.length > 0 && (
								<span class="atlas-legend atlas-legend-secondary">
									<i aria-hidden="true" />
									{secondaryLabel}
								</span>
							)}
						</div>
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
					<div class="atlas-depth-control">
						<button
							class="atlas-xray"
							type="button"
							data-atlas-xray
							aria-pressed="false"
							disabled
						>
							対象筋を透かして表示
						</button>
					</div>
					<p class="atlas-hint">
						左右にドラッグして回転 · キーボードの ← → でも操作
					</p>
					<noscript>
						<p class="atlas-note">
							立体表示にはJavaScriptが必要です。対象筋は下の一覧で確認できます。
						</p>
					</noscript>
				</>
			)}
			{primaryLabels.length > 0 && (
				<div class="atlas-muscle-group">
					<h3>{primaryLabel}</h3>
					<div class="target-muscles-tags">
						{primaryLabels.map((label) => (
							<span class="target-muscle-tag" key={label}>
								{label}
							</span>
						))}
					</div>
				</div>
			)}
			{secondaryLabels.length > 0 && (
				<div class="atlas-muscle-group atlas-secondary-group">
					<h3>{secondaryLabel}</h3>
					<div class="target-muscles-tags">
						{secondaryLabels.map((label) => (
							<span class="target-muscle-tag" key={label}>
								{label}
							</span>
						))}
					</div>
				</div>
			)}
			{unavailable.length > 0 && (
				<div class="atlas-muscle-group">
					<h3>{legacy ? "名称のみ表示" : "Atlas未収録"}</h3>
					<div class="target-muscles-tags">
						{unavailable.map((label) => (
							<span class="target-muscle-tag atlas-unmapped" key={label}>
								{label}
							</span>
						))}
					</div>
					<p class="atlas-note">
						{legacy
							? "モデル未対応（名称のみ表示）: "
							: "モデル未収録（名称のみ表示）: "}
						{unavailable.join("、")}
					</p>
				</div>
			)}
			{count > 0 && (
				<p class="atlas-note">
					{legacy
						? "一部の筋肉は従来の部位名からの参考表示です。"
						: "主・補助は種目の役割による分類です。フォームや器具によって変わります。"}
				</p>
			)}
			<div class="atlas-credit">
				<a href="https://github.com/ashemag/human-atlas">Human Atlas</a>
				<span> / </span>
				<a href="/models/human-atlas/ATTRIBUTION.md">
					BodyParts3D · CC BY 4.0 / 出典
				</a>
			</div>
			{hasModel && <script src="/js/muscle-atlas.js" defer></script>}
		</section>
	);
};
