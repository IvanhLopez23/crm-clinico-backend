import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { notifications } from "../../db/schema/notifications.js";
import { users } from "../../db/schema/users.js";
import { withTenant } from "../../db/tenant.js";

export type NotificationView = {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
};

export type NotificationsResult = {
  items: NotificationView[];
  unreadCount: number;
};

export async function listNotifications(
  db: Database,
  params: { clinicId: string; userId: string; limit?: number },
): Promise<NotificationsResult> {
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);

  return withTenant(db, params.clinicId, async (tx) => {
    const [items, unread] = await Promise.all([
      tx
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          data: notifications.data,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(
          and(
            eq(notifications.clinicId, params.clinicId),
            eq(notifications.userId, params.userId),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(limit),
      tx
        .select({ total: count() })
        .from(notifications)
        .where(
          and(
            eq(notifications.clinicId, params.clinicId),
            eq(notifications.userId, params.userId),
            isNull(notifications.readAt),
          ),
        ),
    ]);

    return {
      items,
      unreadCount: Number(unread[0]?.total ?? 0),
    };
  });
}

export async function markNotificationRead(
  db: Database,
  params: { clinicId: string; userId: string; notificationId: string },
): Promise<void> {
  await withTenant(db, params.clinicId, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.clinicId, params.clinicId),
          eq(notifications.userId, params.userId),
          eq(notifications.id, params.notificationId),
          isNull(notifications.readAt),
        ),
      ),
  );
}

export async function markAllNotificationsRead(
  db: Database,
  params: { clinicId: string; userId: string },
): Promise<void> {
  await withTenant(db, params.clinicId, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.clinicId, params.clinicId),
          eq(notifications.userId, params.userId),
          isNull(notifications.readAt),
        ),
      ),
  );
}

/**
 * Crea una notificacion por cada usuario de recepcion/administracion de la
 * clinica. Se llama despues de una reserva hecha desde el portal publico.
 */
export async function createPublicBookingNotifications(
  db: Database,
  params: {
    clinicId: string;
    appointmentId: string;
    patientId: string;
    patientName: string;
    serviceName: string;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<void> {
  await withTenant(db, params.clinicId, async (tx) => {
    const recipients = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.clinicId, params.clinicId),
          eq(users.isActive, true),
          inArray(users.role, ["admin", "receptionist"]),
        ),
      );

    if (recipients.length === 0) return;

    await tx.insert(notifications).values(
      recipients.map((recipient) => ({
        clinicId: params.clinicId,
        userId: recipient.id,
        type: "public_booking",
        title: "Nueva reserva en linea",
        body: `${params.patientName} · ${params.serviceName}`,
        data: {
          appointmentId: params.appointmentId,
          patientId: params.patientId,
          patientName: params.patientName,
          serviceName: params.serviceName,
          startsAt: params.startsAt.toISOString(),
          endsAt: params.endsAt.toISOString(),
        },
      })),
    );
  });
}
