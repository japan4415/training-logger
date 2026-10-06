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
	/** 検証済み Access JWT の email（無い場合もある）。許可するアカウントの表示用。 */
	accountEmail?: string | null;
	handle: string;
	csrfToken: string;
}

/**
 * scope の生トークンを人が読める説明へ対応付ける。未知の値は「不明な権限」として
 * 生トークンだけを添え、生トークンの羅列だけで同意させない。
 */
const SCOPE_LABELS: Readonly<Record<string, string>> = {
	"mcp:read": "記録の閲覧",
	"mcp:write": "記録の追加・変更・削除",
	"photos:write": "写真のアップロード",
	offline_access: "接続を維持（30 日間）",
};

/** 常に許可する（チェックを外せない）必須 scope。 */
const REQUIRED_SCOPE = "mcp:read";

const MONO_FONT =
	'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const CONSENT_STYLES = `
.consent-card {
	background: var(--bg-tertiary);
	border: 1px solid var(--separator);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow);
	padding: 20px;
	margin-bottom: 16px;
}
.consent-title { overflow-wrap: anywhere; }
.consent-lead { color: var(--label-secondary); font-size: 13px; line-height: 1.5; margin-bottom: 12px; }
.consent-client { font-size: 20px; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; margin-bottom: 4px; overflow-wrap: anywhere; }
.consent-domain { font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--label); margin-bottom: 4px; overflow-wrap: anywhere; }
.consent-client-id { font-family: ${MONO_FONT}; font-size: 13px; line-height: 1.5; color: var(--label-secondary); overflow-wrap: anywhere; }
.consent-field { margin-top: 16px; }
.consent-field-label { display: block; font-size: 13px; font-weight: 600; color: var(--label-secondary); margin-bottom: 4px; }
.consent-host { font-size: 16px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.consent-redirect-uri { font-family: ${MONO_FONT}; font-size: 13px; line-height: 1.5; color: var(--label-secondary); overflow-wrap: anywhere; margin-top: 2px; }
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
.consent-account { margin-top: 8px; font-size: 13px; line-height: 1.5; color: var(--label-secondary); overflow-wrap: anywhere; }
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
.consent-scope input[type="checkbox"] { width: 20px; height: 20px; flex: none; accent-color: var(--accent); }
.consent-scope input[type="checkbox"][disabled] { opacity: 0.6; }
.consent-scope-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.consent-scope-label { font-size: 14px; font-weight: 600; color: var(--label); overflow-wrap: anywhere; }
.consent-scope-raw { font-family: ${MONO_FONT}; font-size: 12px; line-height: 1.4; color: var(--label-secondary); overflow-wrap: anywhere; }
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
.consent-error { color: var(--danger-small-text); font-size: 15px; font-weight: 600; line-height: 1.5; }
.consent-error-help { margin-top: 12px; font-size: 13px; line-height: 1.6; color: var(--label-secondary); }
@media (max-width: 480px) {
	.consent-actions { flex-direction: column-reverse; }
}
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

/**
 * 1 行分の許可 scope。説明を主、生トークンを補助にし、`mcp:read` は常に含める
 * （チェックを外して空の grant を作れないようにする）。
 */
const ScopeRow: FC<{ scope: string }> = (props) => {
	const label = SCOPE_LABELS[props.scope];
	const text = (
		<span class="consent-scope-text">
			<span class="consent-scope-label">{label ?? "不明な権限"}</span>
			<span class="consent-scope-raw">
				{props.scope === REQUIRED_SCOPE
					? `${props.scope}（必須）`
					: props.scope}
			</span>
		</span>
	);
	if (props.scope === REQUIRED_SCOPE) {
		return (
			<div class="consent-scope">
				<input type="checkbox" checked disabled />
				<input type="hidden" name="scope" value={props.scope} />
				{text}
			</div>
		);
	}
	return (
		<label class="consent-scope">
			<input type="checkbox" name="scope" value={props.scope} checked />
			{text}
		</label>
	);
};

export const ConsentPage: FC<ConsentPageProps> = (props) => (
	<ConsentShell title="アクセスの許可">
		<h1 class="consent-title">
			{props.clientName} に記録へのアクセスを許可しますか？
		</h1>
		<div class="consent-card">
			<p class="consent-lead">
				許可すると、このアプリはあなたの training-logger
				の記録へアクセスできるようになります。
			</p>
			<p class="consent-client">{props.clientName}</p>
			{props.clientDomain ? (
				<p class="consent-domain">公開元: {props.clientDomain}</p>
			) : (
				<p class="consent-warning">
					このアプリは自己登録されています。名前は検証されていません。
				</p>
			)}
			{props.clientName !== props.clientId && (
				<p class="consent-client-id">{props.clientId}</p>
			)}

			<div class="consent-field">
				<span class="consent-field-label">アクセス許可の送り先</span>
				<p class="consent-host">{props.redirectHost}</p>
				<p class="consent-redirect-uri">{props.redirectUri}</p>
			</div>

			<p class="consent-warning">
				この画面に見覚えがない場合は許可しないでください。自分で開始した接続だけを許可してください。
			</p>
			{props.redirectIsLoopback && (
				<p class="consent-warning">
					このアクセス許可はあなたのコンピュータ上のアプリへ送られます。いま自分で
					そのアプリからログインを始めた場合だけ続けてください。
				</p>
			)}
			{props.accountEmail && (
				<p class="consent-account">ログイン中: {props.accountEmail}</p>
			)}

			<form method="post" action="/authorize">
				<input type="hidden" name="handle" value={props.handle} />
				<input type="hidden" name="csrf" value={props.csrfToken} />
				<fieldset class="consent-field consent-scopes">
					<legend class="consent-field-label">許可する権限</legend>
					{props.scopes.map((scope) => (
						<ScopeRow scope={scope} />
					))}
				</fieldset>
				<div class="consent-actions">
					<button
						type="submit"
						name="decision"
						value="deny"
						class="consent-button"
					>
						拒否する
					</button>
					<button
						type="submit"
						name="decision"
						value="approve"
						class="consent-button consent-button-primary"
					>
						許可する
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
			<p class="consent-error-help">
				タブを閉じて、コネクタから接続し直してください。問題が続く場合は管理者に連絡してください。
			</p>
			<p class="consent-error-help">
				<a href="/">記録一覧へ戻る</a>
			</p>
		</div>
	</ConsentShell>
);
