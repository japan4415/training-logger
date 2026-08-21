import type { Hono } from "hono";
import { getHistory } from "../db/queries.js";
import type { Bindings } from "../env.js";
import { SessionCard } from "./components/session-card.js";
import { Layout } from "./layout.js";
import { sessionDetailHandler } from "./session-detail.js";

/** Get current year/month in Asia/Tokyo timezone */
function getCurrentYearMonth(): { year: number; month: number } {
	const now = new Date();
	const tokyoDateStr = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	const [year, month] = tokyoDateStr.split("-").map(Number);
	return { year, month };
}

/** Parse "YYYY-MM" string to year and month */
function parseMonth(monthStr: string): { year: number; month: number } | null {
	const match = monthStr.match(/^(\d{4})-(\d{2})$/);
	if (!match) return null;
	const year = Number.parseInt(match[1], 10);
	const month = Number.parseInt(match[2], 10);
	if (month < 1 || month > 12) return null;
	return { year, month };
}

/** Get start date (YYYY-MM-01) for a given year/month */
function monthStartDate(year: number, month: number): string {
	return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** Get last date (YYYY-MM-DD) for a given year/month */
function monthEndDate(year: number, month: number): string {
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** Format year/month for display: "2026年8月" */
function formatYearMonth(year: number, month: number): string {
	return `${year}年${month}月`;
}

/** Get previous month */
function prevMonth(
	year: number,
	month: number,
): { year: number; month: number } {
	return month === 1
		? { year: year - 1, month: 12 }
		: { year, month: month - 1 };
}

/** Get next month */
function nextMonth(
	year: number,
	month: number,
): { year: number; month: number } {
	return month === 12
		? { year: year + 1, month: 1 }
		: { year, month: month + 1 };
}

/** Format year/month as "YYYY-MM" for URL parameter */
function toMonthParam(year: number, month: number): string {
	return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Session list content component (without Layout wrapper).
 * Used for both full page and htmx partial responses.
 */
function SessionListContent(props: {
	year: number;
	month: number;
	sessions: Array<{
		session: import("../db/types.js").WorkoutSessionRow;
		exercises: import("../db/queries.js").SessionExerciseDetail[];
	}>;
}) {
	const { year, month, sessions } = props;
	const prev = prevMonth(year, month);
	const next = nextMonth(year, month);

	return (
		<>
			{/* Month navigation */}
			<div class="month-nav">
				<a
					href={`/?month=${toMonthParam(prev.year, prev.month)}`}
					hx-get={`/?month=${toMonthParam(prev.year, prev.month)}`}
					hx-target="#session-content"
					hx-swap="innerHTML"
					hx-push-url="true"
					class="month-nav-btn"
				>
					&lt; 前月
				</a>
				<span class="month-nav-current">{formatYearMonth(year, month)}</span>
				<a
					href={`/?month=${toMonthParam(next.year, next.month)}`}
					hx-get={`/?month=${toMonthParam(next.year, next.month)}`}
					hx-target="#session-content"
					hx-swap="innerHTML"
					hx-push-url="true"
					class="month-nav-btn"
				>
					次月 &gt;
				</a>
			</div>

			{/* Session cards */}
			{sessions.length === 0 ? (
				<p class="empty-message">この月のセッションはありません</p>
			) : (
				<div class="session-cards">
					{sessions.map((detail) => (
						<SessionCard
							key={detail.session.id}
							session={detail.session}
							exercises={detail.exercises}
						/>
					))}
				</div>
			)}
		</>
	);
}

/**
 * Register session-related view routes on the given Hono app.
 *
 * Routes:
 * - GET /          — Session list (month-based, htmx partial update)
 * - GET /sessions/:id — Session detail
 */
export function registerSessionViews(app: Hono<{ Bindings: Bindings }>): void {
	// Session list
	app.get("/", async (c) => {
		const monthParam = c.req.query("month");
		let year: number;
		let month: number;

		if (monthParam) {
			const parsed = parseMonth(monthParam);
			if (!parsed) {
				return c.html(
					<Layout title="セッション一覧" activeNav="sessions">
						<p class="error-message">無効な月指定です</p>
					</Layout>,
					400,
				);
			}
			year = parsed.year;
			month = parsed.month;
		} else {
			const current = getCurrentYearMonth();
			year = current.year;
			month = current.month;
		}

		const db = c.env.DB;
		const sessions = await getHistory(db, {
			dateFrom: monthStartDate(year, month),
			dateTo: monthEndDate(year, month),
			includeSets: false,
		});

		const isHtmx = c.req.header("HX-Request") === "true";

		if (isHtmx) {
			// Return partial HTML (just the session content, no Layout)
			return c.html(
				<SessionListContent year={year} month={month} sessions={sessions} />,
			);
		}

		// Return full page with Layout
		return c.html(
			<Layout title="セッション一覧" activeNav="sessions">
				<div id="session-content">
					<SessionListContent year={year} month={month} sessions={sessions} />
				</div>
			</Layout>,
		);
	});

	// Session detail
	app.get("/sessions/:id", sessionDetailHandler);
}
