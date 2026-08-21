/**
 * chart-init.js
 *
 * Reads the SSR-embedded JSON from <script type="application/json" id="chart-data">
 * and initializes a Chart.js line chart on the <canvas id="progress-chart"> element.
 *
 * Chart.js itself is loaded via CDN (not bundled).
 *
 * For htmx partial updates, the global `window.initProgressChart` function
 * is called from an inline script in the swapped content.
 */
(function () {
	"use strict";

	var COLORS = [
		"rgba(54, 162, 235, 1)",
		"rgba(255, 99, 132, 1)",
		"rgba(75, 192, 192, 1)",
		"rgba(255, 205, 86, 1)",
		"rgba(153, 102, 255, 1)",
		"rgba(255, 159, 64, 1)",
	];

	var BG_COLORS = [
		"rgba(54, 162, 235, 0.1)",
		"rgba(255, 99, 132, 0.1)",
		"rgba(75, 192, 192, 0.1)",
		"rgba(255, 205, 86, 0.1)",
		"rgba(153, 102, 255, 0.1)",
		"rgba(255, 159, 64, 0.1)",
	];

	function initChart() {
		var dataEl = document.getElementById("chart-data");
		if (!dataEl || !dataEl.textContent) return;

		var data;
		try {
			data = JSON.parse(dataEl.textContent);
		} catch (_e) {
			return;
		}

		var canvas = document.getElementById("progress-chart");
		if (!canvas) return;

		// Destroy existing chart instance if any (for htmx re-renders)
		if (typeof Chart !== "undefined" && Chart.getChart) {
			var existing = Chart.getChart(canvas);
			if (existing) existing.destroy();
		}

		if (typeof Chart === "undefined") return;

		var yLabel = data.type === "speed" ? "Speed (km/h)" : "Weight";

		var datasets = data.datasets.map(function (ds, i) {
			return {
				label: ds.unit,
				data: ds.values,
				borderColor: COLORS[i % COLORS.length],
				backgroundColor: BG_COLORS[i % BG_COLORS.length],
				fill: false,
				tension: 0.1,
				spanGaps: true,
				pointRadius: 4,
				pointHoverRadius: 6,
			};
		});

		new Chart(canvas, {
			type: "line",
			data: {
				labels: data.labels,
				datasets: datasets,
			},
			options: {
				responsive: true,
				maintainAspectRatio: true,
				scales: {
					y: {
						title: { display: true, text: yLabel },
						beginAtZero: false,
					},
					x: {
						title: { display: true, text: "Date" },
					},
				},
				plugins: {
					legend: {
						display: true,
						position: "top",
					},
					tooltip: {
						mode: "index",
						intersect: false,
					},
				},
			},
		});
	}

	// Expose globally for htmx re-initialization
	window.initProgressChart = initChart;

	// Auto-init on DOMContentLoaded or immediately if already loaded
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initChart);
	} else {
		initChart();
	}
})();
