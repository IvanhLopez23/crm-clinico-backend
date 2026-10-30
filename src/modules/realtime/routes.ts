import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { requirePermission } from "../../lib/require-permission.js";
import { realtimeBus, type RealtimeTopic } from "./bus.js";

const ALLOWED_TOPICS: RealtimeTopic[] = ["agenda", "sala", "patients"];

export const realtimeRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  void opts;

  app.get(
    "/realtime/stream",
    { preHandler: requirePermission("appointments:read") },
    async (request, reply) => {
      const query = request.query as { topics?: string } | undefined;
      const rawTopics = String(query?.topics ?? "");
      const requested = rawTopics
        .split(",")
        .map((topic) => topic.trim())
        .filter((topic): topic is RealtimeTopic =>
          ALLOWED_TOPICS.includes(topic as RealtimeTopic),
        );
      const topics = new Set<RealtimeTopic>(
        requested.length > 0 ? requested : ALLOWED_TOPICS,
      );

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write("retry: 5000\n\n");
      reply.raw.write(
        `event: ready\ndata: ${JSON.stringify({ topics: [...topics] })}\n\n`,
      );

      const send = (event: { topic: RealtimeTopic; type: string; at: string }) => {
        if (!topics.has(event.topic)) return;
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        reply.raw.write(
          `event: update\ndata: ${JSON.stringify({
            topic: event.topic,
            type: event.type,
            at: event.at,
          })}\n\n`,
        );
      };

      const unsubscribe = realtimeBus.subscribe(request.clinicId, send);
      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.write(": heartbeat\n\n");
        }
      }, 25_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };

      request.raw.on("close", cleanup);
      request.raw.on("error", cleanup);

      return reply;
    },
  );
};
