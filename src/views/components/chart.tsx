import { raw } from "hono/html";
import type { FC } from "hono/jsx";

/** A single dataset (one line on the chart, identified by unit) */
export interface ChartDataset {
	unit: string;
	values: (number | null)[];
}

/**
 * JSON structure embedded in the page for chart-init.js to consume.
 * - type "weight": Y-axis shows weight (for strength exercises)
 * - type "speed":  Y-axis shows speed in km/h (for cardio exercises)
 */
export interface ChartData {
	labels: string[];
	datasets: ChartDataset[];
	type: "weight" | "speed";
}

/**
 * SSR component that embeds chart data as JSON and includes Chart.js references.
 * This renders:
 *   1. A <canvas> element for Chart.js to draw on
 *   2. A <script type="application/json"> with the serialized chart data
 *
 * The Chart.js CDN and chart-init.js script tags are NOT included here;
 * they should be placed outside the htmx swap target so they load only once.
 */
export const ChartContainer: FC<{ data: ChartData }> = ({ data }) => {
	if (data.datasets.length === 0 || data.labels.length === 0) {
		return <p id="chart-empty">データがありません</p>;
	}

	// Escape '<' to '<' to prevent script injection in JSON
	const jsonStr = JSON.stringify(data).replaceAll("<", "\\u003c");

	return (
		<div>
			<canvas id="progress-chart" />
			{raw(
				`<script type="application/json" id="chart-data">${jsonStr}</script>`,
			)}
		</div>
	);
};
