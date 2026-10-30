import type { UserRole } from "../db/schema/users.js";

export type AuthContext = {
  userId: string;
  clinicId: string;
  role: UserRole;
  practitionerId: string | null;
  email: string;
  fullName: string;
  avatarData: string | null;
};

export type Permission =
  | "clinic:read"
  | "appointments:read"
  | "appointments:write"
  | "appointments:force_overbook"
  | "availability:read"
  | "availability:write"
  | "waitlist:read"
  | "waitlist:write"
  | "patients:read"
  | "patients:write"
  | "clinical:read"
  | "clinical:write"
  | "settings:read"
  | "settings:write"
  | "audit:read"
  | "users:manage";

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  admin: new Set<Permission>([
    "clinic:read",
    "appointments:read",
    "appointments:write",
    "appointments:force_overbook",
    "availability:read",
    "availability:write",
    "waitlist:read",
    "waitlist:write",
    "patients:read",
    "patients:write",
    "clinical:read",
    "clinical:write",
    "settings:read",
    "settings:write",
    "audit:read",
    "users:manage",
  ]),
  practitioner: new Set<Permission>([
    "clinic:read",
    "appointments:read",
    "appointments:write",
    "availability:read",
    "availability:write",
    "waitlist:read",
    "patients:read",
    "clinical:read",
    "clinical:write",
  ]),
  receptionist: new Set<Permission>([
    "clinic:read",
    "appointments:read",
    "appointments:write",
    "availability:read",
    "waitlist:read",
    "waitlist:write",
    "patients:read",
    "patients:write",
    "clinical:read",
  ]),
};

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
