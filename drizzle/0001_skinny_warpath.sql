CREATE TABLE "board_files" (
	"board_id" uuid NOT NULL,
	"file_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_files_board_id_file_id_pk" PRIMARY KEY("board_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "board_files" ADD CONSTRAINT "board_files_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_files" ADD CONSTRAINT "board_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_files_board_idx" ON "board_files" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "board_files_created_by_idx" ON "board_files" USING btree ("created_by");