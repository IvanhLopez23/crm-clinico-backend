ALTER TABLE "clinics" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_latitude_chk" CHECK ("clinics"."latitude" is null or "clinics"."latitude" between -90 and 90);--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_longitude_chk" CHECK ("clinics"."longitude" is null or "clinics"."longitude" between -180 and 180);--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_coordinates_pair_chk" CHECK (("clinics"."latitude" is null) = ("clinics"."longitude" is null));