CREATE TABLE "tick_resolutions" (
	"world_id" text NOT NULL,
	"tick" integer NOT NULL,
	"content_version" text NOT NULL,
	"command_cutoff_at" bigint NOT NULL,
	"resolved_at" bigint NOT NULL,
	"seed" text NOT NULL,
	"phase_hashes" jsonb NOT NULL,
	"planet_state_hash" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "tick_resolutions_world_id_tick_pk" PRIMARY KEY("world_id","tick")
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" text PRIMARY KEY NOT NULL,
	"seed" integer NOT NULL,
	"tick" integer NOT NULL,
	"next_tick_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"last_resolved_at" bigint,
	"world_version" text NOT NULL,
	"content_version" text NOT NULL,
	"tick_duration_ms" integer NOT NULL,
	"state" jsonb NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tick_resolutions" ADD CONSTRAINT "tick_resolutions_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;