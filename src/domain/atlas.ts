import model from "../../public/models/human-atlas/atlas.json";
import profiles from "./atlas-profiles.json";

/** Stable BodyParts3D mesh IDs; primary always takes precedence over secondary. */
export interface AtlasAssignment {
	primary: string[];
	secondary: string[];
	unavailable: string[];
}

// Group labels are for reading; selection always uses the individual source IDs.
const groupLabels: Record<string, string> = {
	FJ1394: "腓腹筋",
	FJ1397: "腓腹筋",
	FJ1437: "ヒラメ筋",
	FJ1395: "大腿二頭筋",
	FJ1444: "大腿二頭筋",
	FJ1401: "短内転筋",
	FJ1402: "長内転筋",
	FJ1403: "大内転筋",
	FJ1404: "小内転筋",
	FJ1418: "大殿筋",
	FJ1419: "中殿筋",
	FJ1420: "小殿筋",
	FJ1421: "薄筋",
	FJ1422: "腸骨筋",
	FJ1427: "恥骨筋",
	FJ1431: "大腰筋",
	FJ1433: "大腿直筋",
	FJ1435: "半膜様筋",
	FJ1436: "半腱様筋",
	FJ1438: "大腿筋膜張筋",
	FJ1439: "前脛骨筋",
	FJ1441: "中間広筋",
	FJ1442: "外側広筋",
	FJ1443: "内側広筋",
	FJ1446: "大胸筋",
	FJ1447: "大胸筋",
	FJ1464: "大胸筋",
	FJ1452: "外腹斜筋",
	FJ1459: "前鋸筋",
	FJ1467: "三角筋（中部）",
	FJ1468: "三角筋（前部）",
	FJ1513: "三角筋（後部）",
	FJ1472: "尺側手根伸筋",
	FJ1517: "尺側手根伸筋",
	FJ1473: "尺側手根屈筋",
	FJ1518: "尺側手根屈筋",
	FJ1474: "円回内筋",
	FJ1516: "円回内筋",
	FJ1475: "浅指屈筋",
	FJ1499: "浅指屈筋",
	FJ1477: "上腕三頭筋",
	FJ1479: "上腕三頭筋",
	FJ1480: "上腕三頭筋",
	FJ1478: "上腕二頭筋",
	FJ1512: "上腕二頭筋",
	FJ1484: "長母指外転筋",
	FJ1486: "上腕筋",
	FJ1487: "腕橈骨筋",
	FJ1488: "烏口腕筋",
	FJ1489: "短橈側手根伸筋",
	FJ1490: "長橈側手根伸筋",
	FJ1491: "小指伸筋",
	FJ1492: "総指伸筋",
	FJ1493: "示指伸筋",
	FJ1495: "長母指伸筋",
	FJ1496: "橈側手根屈筋",
	FJ1497: "深指屈筋",
	FJ1498: "長母指屈筋",
	FJ1500: "棘下筋",
	FJ1504: "肩甲下筋",
	FJ1506: "棘上筋",
	FJ1508: "小円筋",
	FJ1502: "長掌筋",
	FJ1503: "方形回内筋",
	FJ1505: "回外筋",
	FJ1507: "大円筋",
	FJ1520: "僧帽筋（下部）",
	FJ1521: "僧帽筋（上部）",
	FJ1554: "僧帽筋（中部）",
	FJ1527: "腰腸肋筋",
	FJ1528: "胸腸肋筋",
	FJ1535: "胸最長筋",
	FJ1544: "胸棘筋",
	FJ1536: "大菱形筋",
	FJ1537: "小菱形筋",
	FMA13358: "広背筋",
	FMA13359: "広背筋",
	FMA13377: "腹直筋",
	FMA13378: "腹直筋",
};

export const ATLAS_MUSCLES = model.parts
	.filter((part) => part.system === "muscular")
	.map((part) => {
		const groupLabel = groupLabels[part.id.replace(/M$/, "")] ?? part.name;
		// Both original FJ meshes and the supplemental FMA meshes retain source names.
		// The FMA IDs do not encode laterality with an M suffix.
		const side = /\bleft\b/i.test(part.name)
			? "左"
			: /\bright\b/i.test(part.name)
				? "右"
				: "";
		return {
			id: part.id,
			name: part.name,
			label: side ? `${side} ${groupLabel}` : groupLabel,
			groupLabel,
		};
	});
const muscleIds = new Set(ATLAS_MUSCLES.map((muscle) => muscle.id));

export function validateAtlasAssignment(
	value: AtlasAssignment,
): AtlasAssignment {
	if (!value || typeof value !== "object")
		throw new Error("筋肉の対応付けはオブジェクトで指定してください");
	for (const key of ["primary", "secondary", "unavailable"] as const) {
		if (!Array.isArray(value[key]) || value[key].length > 200)
			throw new Error(`${key} は200件以下の配列で指定してください`);
	}
	function ids(values: string[]): string[] {
		for (const id of values)
			if (typeof id !== "string" || !muscleIds.has(id))
				throw new Error(`Atlasに存在しない筋肉IDです: ${String(id)}`);
		return [...new Set(values)];
	}
	const primary = ids(value.primary);
	const secondary = ids(value.secondary).filter((id) => !primary.includes(id));
	const unavailable = value.unavailable.map((name) => {
		if (typeof name !== "string" || !name.trim() || name.length > 100)
			throw new Error("未収録の筋肉名は1〜100文字で指定してください");
		return name.trim();
	});
	return { primary, secondary, unavailable: [...new Set(unavailable)] };
}

export function parseAtlasAssignment(
	value: string | null | undefined,
): AtlasAssignment | null {
	if (!value) return null;
	try {
		return validateAtlasAssignment(JSON.parse(value));
	} catch {
		return null;
	}
}

interface ExerciseProfile {
	names: string[];
	assignment: AtlasAssignment;
}
export function getDefaultAtlasAssignment(
	name: string,
): AtlasAssignment | null {
	const normalized = name.normalize("NFKC").trim().toLowerCase();
	const profile = (profiles as ExerciseProfile[]).find((p) =>
		p.names.some(
			(alias) => alias.normalize("NFKC").trim().toLowerCase() === normalized,
		),
	);
	return profile ? validateAtlasAssignment(profile.assignment) : null;
}

export function mergeAtlasAssignments(
	assignments: AtlasAssignment[],
): AtlasAssignment {
	const primary = [...new Set(assignments.flatMap((a) => a.primary))];
	return {
		primary,
		secondary: [...new Set(assignments.flatMap((a) => a.secondary))].filter(
			(id) => !primary.includes(id),
		),
		unavailable: [...new Set(assignments.flatMap((a) => a.unavailable))],
	};
}

export function atlasGroupLabels(ids: string[]): string[] {
	const selected = new Set(ids);
	return [
		...new Set(
			ATLAS_MUSCLES.filter((m) => selected.has(m.id)).map((m) => m.groupLabel),
		),
	];
}
