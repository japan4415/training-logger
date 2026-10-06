import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import type { JSX } from "hono/jsx/jsx-runtime";

/**
 * OAuth 同意画面。
 *
 * MCP クライアントが `/authorize` に来たとき、だれに何を許可するかを
 * ユーザーへ必ず確認する。表示する client_name / client_id / redirect_uri /
 * scope はすべてクライアント由来の値なので、Hono JSX の自動エスケープに必ず通す
 * （`raw()` は使わない）。既存の `public/css/style.css` の CSS 変数と
 * タイポグラフィを再利用し、ライト / ダーク、フォーカス可視、モバイル幅
 * （320px〜）、`prefers-reduced-motion` に揃える。
 */

export interface ConsentPageProps {
	clientName: string;
	clientId: string;
	clientDomain?: string;
	redirectUri: string;
	redirectHost: string;
	redirectIsLoopback: boolean;
	scopes: string[];
	handle: string;
	csrfToken: string;
}

const CONSENT_STYLES = `
.consent-card {
	background: var(--bg-tertiary);
	border: 1px solid var(--separator);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow);
	padding: 20px;
	margin-bottom: 16px;
}
.consent-lead { color: var(--label-secondary); font-size: 13px; line-height: 1.5; margin-bottom: 12px; }
.consent-client { font-size: 20px; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; margin-bottom: 4px; }
.consent-domain { font-size: 13px; line-height: 1.35; color: var(--accent); margin-bottom: 4px; }
.consent-unverified { font-size: 13px; line-height: 1.35; color: var(--warning); margin-bottom: 4px; }
.consent-client-id { font-size: 11px; line-height: 1.5; color: var(--label-tertiary); overflow-wrap: anywhere; }
.consent-field { margin-top: 16px; }
.consent-field-label { display: block; font-size: 13px; font-weight: 600; color: var(--label-secondary); margin-bottom: 4px; }
.consent-host { font-size: 16px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.consent-redirect-uri { font-size: 11px; line-height: 1.5; color: var(--label-tertiary); overflow-wrap: anywhere; margin-top: 2px; }
.consent-warning {
	display: block;
	margin-top: 8px;
	padding: 10px 12px;
	border: 1px solid var(--warning);
	border-radius: var(--radius-btn);
	color: var(--label);
	background: var(--bg-secondary);
	font-size: 13px;
	line-height: 1.5;
}
.consent-scopes { border: 0; margin: 0; padding: 0; }
.consent-scope {
	display: flex;
	align-items: center;
	gap: 10px;
	min-height: 44px;
	font-size: 14px;
	line-height: 1.4;
	overflow-wrap: anywhere;
}
.consent-scope input { width: 20px; height: 20px; flex: none; accent-color: var(--accent); }
.consent-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
.consent-button {
	min-height: 44px;
	flex: 1 1 140px;
	padding: 10px 16px;
	font: inherit;
	font-size: 15px;
	font-weight: 600;
	border: 1px solid var(--separator);
	border-radius: var(--radius-btn);
	background: var(--bg-tertiary);
	color: var(--label);
	cursor: pointer;
	transition: background 0.15s, transform 0.1s;
}
.consent-button-primary { background: var(--accent); border-color: var(--accent); color: var(--label-on-accent); }
.consent-button:hover { background: var(--accent-hover); }
.consent-button-primary:hover { background: var(--accent); }
.consent-button:active { transform: scale(0.97); }
.consent-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.consent-error { color: var(--danger); font-size: 13px; line-height: 1.5; }
@media (prefers-reduced-motion: reduce) {
	.consent-button { transition: none; }
	.consent-button:active { transform: none; }
}
`;

/** 同意画面の共通シェル。 */
const ConsentShell: FC<{
	title: string;
	children: JSX.Element | JSX.Element[] | string;
}> = (props) => (
	<>
		{raw("<!DOCTYPE html>")}
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<meta name="color-scheme" content="light dark" />
				<title>{props.title} - training-logger</title>
				<link rel="stylesheet" href="/css/style.css" />
				<style>{raw(CONSENT_STYLES)}</style>
			</head>
			<body>
				<main class="main-content">{props.children}</main>
			</body>
		</html>
	</>
);

export const ConsentPage: FC<ConsentPageProps> = (props) => (
	<ConsentShell title="アクセスの許可">
		<h1>アクセスの許可</h1>
		<div class="consent-card">
			<p class="consent-lead">
				次のアプリが training-logger
				のあなたの記録へアクセスすることを許可しますか？
			</p>
			<p class="consent-client">{props.clientName}</p>
			{props.clientDomain ? (
				<p class="consent-domain">公開元: {props.clientDomain}</p>
			) : (
				<p class="consent-unverified">
					このアプリは自己登録されています。名前は検証されていません。
				</p>
			)}
			<p class="consent-client-id">client_id: {props.clientId}</p>

			<div class="consent-field">
				<span class="consent-field-label">アクセス許可の送り先</span>
				<p class="consent-host">{props.redirectHost}</p>
				<p class="consent-redirect-uri">redirect_uri: {props.redirectUri}</p>
				{props.redirectIsLoopback && (
					<p class="consent-warning">
						このアクセス許可はあなたのコンピュータ上のアプリへ送られます。いま自分で
						そのアプリからログインを始めた場合だけ続けてください。
					</p>
				)}
			</div>

			<form method="post" action="/authorize">
				<input type="hidden" name="handle" value={props.handle} />
				<input type="hidden" name="csrf" value={props.csrfToken} />
				<fieldset class="consent-field consent-scopes">
					<legend class="consent-field-label">許可する権限</legend>
					{props.scopes.map((scope) => (
						<label class="consent-scope">
							<input type="checkbox" name="scope" value={scope} checked />
							<span>{scope}</span>
						</label>
					))}
				</fieldset>
				<div class="consent-actions">
					<button
						type="submit"
						name="decision"
						value="approve"
						class="consent-button consent-button-primary"
					>
						許可する
					</button>
					<button
						type="submit"
						name="decision"
						value="deny"
						class="consent-button"
					>
						拒否する
					</button>
				</div>
			</form>
		</div>
	</ConsentShell>
);

/** 同意フローを続行できないときに、クライアントへリダイレクトせずローカル表示する。 */
export const ConsentErrorPage: FC<{ message: string }> = (props) => (
	<ConsentShell title="認可エラー">
		<h1>認可できませんでした</h1>
		<div class="consent-card">
			<p class="consent-error">{props.message}</p>
		</div>
	</ConsentShell>
);
