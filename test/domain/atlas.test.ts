import { describe, expect, it } from "vitest";
import model from "../../public/models/human-atlas/atlas.json";
import {
	ATLAS_MUSCLES,
	type AtlasAssignment,
	atlasGroupLabels,
	getDefaultAtlasAssignment,
	mergeAtlasAssignments,
	parseAtlasAssignment,
	validateAtlasAssignment,
} from "../../src/domain/atlas.js";
import profiles from "../../src/domain/atlas-profiles.json";

const empty = { primary: [], secondary: [], unavailable: [] };

describe("Atlas assignments", () => {
	it("exposes only real, unique muscle IDs and validates all reviewed profiles", () => {
		expect(new Set(ATLAS_MUSCLES.map((m) => m.id)).size).toBe(
			ATLAS_MUSCLES.length,
		);
		expect(ATLAS_MUSCLES.map((m) => m.id)).toEqual(
			model.parts.filter((p) => p.system === "muscular").map((p) => p.id),
		);
		expect(profiles).toHaveLength(14);
		for (const profile of profiles) {
			expect(validateAtlasAssignment(profile.assignment)).toEqual(
				profile.assignment,
			);
			for (const name of profile.names)
				expect(getDefaultAtlasAssignment(name)).toEqual(profile.assignment);
		}
	});

	it("normalizes known exercise names but never guesses from a partial or prototype name", () => {
		expect(getDefaultAtlasAssignment(" ＢＥＮＣＨ ＰＲＥＳＳ ")).toEqual(
			getDefaultAtlasAssignment("ベンチプレス"),
		);
		for (const name of ["__proto__", "constructor", "ベンチ", "未知の種目", ""])
			expect(getDefaultAtlasAssignment(name)).toBeNull();
		const first = getDefaultAtlasAssignment("ベンチプレス");
		first?.primary.push("not-a-muscle");
		expect(getDefaultAtlasAssignment("ベンチプレス")?.primary).not.toContain(
			"not-a-muscle",
		);
	});

	it("deduplicates with primary precedence without mutating the caller", () => {
		const input = {
			primary: ["FJ1394", "FJ1394"],
			secondary: ["FJ1394", "FJ1397", "FJ1397"],
			unavailable: [" 広背筋 ", "広背筋"],
		};
		expect(validateAtlasAssignment(input)).toEqual({
			primary: ["FJ1394"],
			secondary: ["FJ1397"],
			unavailable: ["広背筋"],
		});
		expect(input.primary).toHaveLength(2);
	});

	it.each([
		null,
		{},
		{ ...empty, primary: "FJ1394" },
		{ ...empty, primary: ["gastrocnemius"] },
		{ ...empty, secondary: ["__proto__"] },
		{ ...empty, primary: [123] },
		{ ...empty, primary: Array(201).fill("FJ1394") },
		{ ...empty, unavailable: [""] },
		{ ...empty, unavailable: [" "] },
		{ ...empty, unavailable: ["x".repeat(101)] },
	])("rejects malformed or noncatalog assignments: %j", (input) => {
		expect(() => validateAtlasAssignment(input as AtlasAssignment)).toThrow();
	});

	it("rejects nonmuscular meshes and safely parses damaged persisted data", () => {
		const skin = model.parts.find((part) => part.system !== "muscular");
		expect(skin).toBeDefined();
		expect(() =>
			validateAtlasAssignment({ ...empty, primary: [skin?.id ?? ""] }),
		).toThrow();
		for (const value of [
			undefined,
			null,
			"",
			"not json",
			"null",
			"{}",
			'{"primary":["fake"],"secondary":[],"unavailable":[]}',
		])
			expect(parseAtlasAssignment(value)).toBeNull();
		expect(parseAtlasAssignment(JSON.stringify(empty))).toEqual(empty);
	});

	it("merges sessions with primary precedence and readable bilateral group labels", () => {
		expect(
			mergeAtlasAssignments([
				{ primary: ["FJ1394"], secondary: ["FJ1397"], unavailable: ["広背筋"] },
				{
					primary: ["FJ1397"],
					secondary: ["FJ1394", "FJ1437"],
					unavailable: ["広背筋", "腹直筋"],
				},
			]),
		).toEqual({
			primary: ["FJ1394", "FJ1397"],
			secondary: ["FJ1437"],
			unavailable: ["広背筋", "腹直筋"],
		});
		expect(atlasGroupLabels(["FJ1394", "FJ1394M", "unknown"])).toEqual([
			"腓腹筋",
		]);
	});
});
