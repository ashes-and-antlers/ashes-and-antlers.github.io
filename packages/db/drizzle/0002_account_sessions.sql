CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE "account_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"last_seen_at" bigint NOT NULL,
	"user_agent" text,
	"ip_address" text,
	CONSTRAINT "account_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "account_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "account_sessions_account_id_idx" ON "account_sessions" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "account_sessions_expires_at_idx" ON "account_sessions" USING btree ("expires_at");
--> statement-breakpoint
INSERT INTO "account_sessions" ("id", "account_id", "token_hash", "created_at", "expires_at", "last_seen_at")
SELECT 'legacy_' || "id", "id", encode(digest("token", 'sha256'), 'hex'), "created_at", "created_at" + 2592000000, "created_at"
FROM "accounts"
WHERE "token" IS NOT NULL
ON CONFLICT ("token_hash") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "token" DROP NOT NULL;
--> statement-breakpoint
UPDATE "accounts" SET "token" = NULL WHERE "token" IS NOT NULL;
