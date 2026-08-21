import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import type { JSX } from "hono/jsx/jsx-runtime";

export type LayoutProps = {
	title: string;
	activeNav?: "sessions" | "exercises";
	children: JSX.Element | JSX.Element[] | string;
};

export const Layout: FC<LayoutProps> = (props) => (
	<>
		{raw("<!DOCTYPE html>")}
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{props.title} - training-logger</title>
				<link rel="stylesheet" href="/css/style.css" />
				<script src="https://cdn.jsdelivr.net/npm/htmx.org@2/dist/htmx.min.js"></script>
			</head>
			<body>
				<header class="app-header">
					<h1 class="app-title">
						<a href="/">training-logger</a>
					</h1>
					<nav class="main-nav">
						<a
							href="/"
							class={
								props.activeNav === "sessions" ? "nav-link active" : "nav-link"
							}
						>
							セッション
						</a>
						<a
							href="/exercises"
							class={
								props.activeNav === "exercises" ? "nav-link active" : "nav-link"
							}
						>
							種目
						</a>
					</nav>
				</header>
				<main class="main-content">{props.children}</main>
				<footer class="app-footer">
					<p>training-logger</p>
				</footer>
			</body>
		</html>
	</>
);
