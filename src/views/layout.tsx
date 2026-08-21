// src/views/layout.tsx (このファイルはスタブです。issue #10の本実装で置き換えられます)
import type { Child, FC } from "hono/jsx";

export type LayoutProps = {
	title: string;
	activeNav?: "sessions" | "exercises";
	children: Child;
};

export const Layout: FC<LayoutProps> = (props) => {
	return (
		<html lang="ja">
			<head>
				<title>{props.title}</title>
			</head>
			<body>{props.children}</body>
		</html>
	);
};
