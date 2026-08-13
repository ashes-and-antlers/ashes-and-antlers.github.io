UPDATE "accounts" SET "username" = lower(trim("username"));
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_username_lower_unique" ON "accounts" USING btree (lower("username"));
