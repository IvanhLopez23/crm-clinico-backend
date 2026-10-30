import { z } from "zod";

export const waitingRoomQuery = z.object({
  date: z.iso.date().optional(),
});
