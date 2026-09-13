import {
	PHOTO_ALLOWED_TYPES,
	PHOTO_MAX_BYTES,
	PHOTO_MAX_PER_SESSION,
} from "../../db/session-photos.js";
import type { SessionPhotoRow } from "../../db/types.js";

export function SessionPhotos(props: {
	sessionId: number;
	photos: SessionPhotoRow[];
}) {
	const { sessionId, photos } = props;
	const fragmentUrl = `/sessions/${sessionId}/photos`;
	const uploadUrl = `/api/sessions/${sessionId}/photos`;

	return (
		<div
			class="session-photos-content"
			data-fragment-url={fragmentUrl}
			data-photo-count={photos.length}
		>
			{photos.length === 0 ? (
				<p class="session-photos-empty">写真はまだありません</p>
			) : (
				<div class="session-photo-grid">
					{photos.map((photo, index) => {
						const photoUrl = `/api/sessions/${sessionId}/photos/${photo.id}`;
						const confirmationId = `photo-delete-confirm-${photo.id}`;
						const questionId = `${confirmationId}-question`;
						return (
							<figure class="session-photo-item" key={photo.id}>
								<a
									class="session-photo-link"
									href={photoUrl}
									target="_blank"
									rel="noopener noreferrer"
								>
									<img
										loading="lazy"
										src={photoUrl}
										alt={`セッション写真 ${index + 1} / ${photos.length}`}
									/>
								</a>
								<figcaption class="session-photo-actions">
									<button
										type="button"
										class="photo-delete-start"
										aria-controls={confirmationId}
										aria-expanded="false"
									>
										削除
									</button>
									<fieldset
										id={confirmationId}
										class="photo-delete-confirmation"
										aria-labelledby={questionId}
										hidden
									>
										<legend id={questionId} class="photo-delete-question">
											削除しますか？
										</legend>
										<button
											type="button"
											class="photo-delete-confirm"
											data-delete-url={photoUrl}
										>
											削除する
										</button>
										<button type="button" class="photo-delete-cancel">
											キャンセル
										</button>
									</fieldset>
								</figcaption>
							</figure>
						);
					})}
				</div>
			)}

			{photos.length >= PHOTO_MAX_PER_SESSION ? (
				<p
					class="photo-upload-status photo-upload-limit"
					role="status"
					aria-live="polite"
				>
					4枚まで追加済みです。追加するには削除してください。
				</p>
			) : (
				<form
					class="photo-upload-form"
					action={uploadUrl}
					method="post"
					enctype="multipart/form-data"
					data-fragment-url={fragmentUrl}
				>
					<label for="session-photo-input" class="photo-upload-label">
						写真を選択
					</label>
					<input
						id="session-photo-input"
						class="photo-upload-input"
						type="file"
						name="photo"
						accept={PHOTO_ALLOWED_TYPES.join(",")}
						multiple
					/>
					<p class="photo-upload-note">
						JPEG・PNG・WebP／1枚 {PHOTO_MAX_BYTES / (1024 * 1024)}
						MiBまで／最大{PHOTO_MAX_PER_SESSION}枚
					</p>
					<button type="submit" class="photo-upload-submit">
						アップロード
					</button>
					<p class="photo-upload-status" role="status" aria-live="polite" />
				</form>
			)}
		</div>
	);
}
