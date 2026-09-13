export type Bindings = {
	DB: D1Database;
	PHOTOS: R2Bucket;
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED?: string;
	GITHUB_TOKEN?: string;
	GITHUB_REPO_OWNER?: string;
	GITHUB_REPO_NAME?: string;
};
