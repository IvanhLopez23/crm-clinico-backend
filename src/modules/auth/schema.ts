import { z } from "zod";

export const loginBody = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
});
