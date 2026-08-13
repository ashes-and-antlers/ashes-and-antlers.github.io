CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"token" text NOT NULL,
	"world_id" text NOT NULL,
	"player_id" text NOT NULL,
	"name" text NOT NULL,
	"faction_id" text NOT NULL,
	"symbol_id" text NOT NULL,
	"home_planet_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "accounts_username_unique" UNIQUE("username"),
	CONSTRAINT "accounts_token_unique" UNIQUE("token")
);
