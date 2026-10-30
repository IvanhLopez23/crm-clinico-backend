# CRM clinico - backend

API del CRM. Es un proyecto independiente: los comandos se ejecutan desde
`backend/` y tiene su propio `package.json`, `pnpm-lock.yaml` y `node_modules`.

Primer slice del backend: agenda con reserva atomica, multi-tenant con RLS y
anti doble-reserva garantizada en PostgreSQL.

## Stack

- Node.js >= 22 (ESM), TypeScript estricto
- **pnpm 12** (configuracion local de builds en `pnpm-workspace.yaml`)
- Fastify 5
- PostgreSQL 16 (Docker)
- Drizzle ORM + Drizzle Kit
- Zod
- Vitest + Testcontainers

## Arranque

```bash
pnpm install
pnpm db:up        # Postgres en localhost:5433
pnpm db:migrate   # aplica migraciones como postgres (owner)
pnpm dev          # http://localhost:3000
```

`.env` ya trae las URLs locales. El rol `crm_app` (sin privilegios) es el que
usa la API; las migraciones usan `postgres`.

### Datos demo

```bash
pnpm seed:demo
```

Crea una clinica con dos especialistas, pacientes, agenda de hoy y un usuario
admin. Imprime las credenciales (`admin@demo.local` / `demo-password-123`).
No es idempotente: si `admin@demo.local` ya existe, usa una base limpia o
elimina ese usuario antes de volver a ejecutarlo.

### Backfill Fase 1

```bash
pnpm backfill:phase1 --dry-run   # reporte sin escribir
pnpm backfill:phase1             # crea households y contactos cifrados
pnpm backfill:phase1 --clinic=<uuid>
```

Es idempotente. No fusiona familias ni inventa opt-in; copia telefono/email a
`contact_points` con `transactional_opt_in=false` y reporta duplicados.

## Autenticacion

```bash
# bootstrap del primer usuario (usa MIGRATION_DATABASE_URL)
pnpm user:create -- <clinicId> admin@clinica.com 'PasswordSegura123' admin

# login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"admin@clinica.com","password":"PasswordSegura123"}'

# perfil
curl http://localhost:3000/api/v1/auth/me -H "authorization: Bearer <token>"
```

| Permiso | admin | practitioner | receptionist |
|---|---|---|---|---|
| `appointments:read/write` | si | si (solo propias) | si |
| `appointments:force_overbook` | si | no | no |
| `availability:read` | si | si | si |
| `availability:write` | si | si (solo propias) | no |
| `waitlist:read` | si | si | si |
| `waitlist:write` | si | no | si |
| `patients:read/write` | si | solo lectura de sus pacientes | si |
| `clinical:read` | si | si | si (banner, sin notas) |
| `clinical:write` | si | si | no |
| `settings:read/write` | si | no | no |
| `audit:read` | si | no | no |
| `users:manage` | si | no | no |

- Staff: `Authorization: Bearer <jwt>` (HS256, TTL configurable con `AUTH_TOKEN_TTL`).
- Portal publico (`GET /availability`, `POST /appointments`): sin token, tenant
  por `x-clinic-id`. Si envian token, se autentican igual.
- El usuario se relee en cada request: desactivar una cuenta o cambiar su rol
  surte efecto inmediato.
- Contrasenas con `scrypt` + salt y comparacion en tiempo constante.

## Auditoria

```bash
# solo admin
curl "http://localhost:3000/api/v1/audit?action=appointment.create&limit=50" \
  -H "authorization: Bearer <token-admin>"
```

- Tabla `audit_events` append-only: `crm_app` solo tiene `SELECT`/`INSERT`.
- Cada evento encadena el hash del anterior por clinica (`prevHash` + `hash`),
  serializado con un advisory lock.
- Registra login (exito/fallo), citas (crear/cancelar/reagendar), lista de
  espera y cambios de agenda.
- Limitacion: la escritura ocurre despues de la mutacion; si falla, se loguea y
  no revierte la operacion ya confirmada.

## Endpoints

Las rutas de staff requieren `Authorization: Bearer <token>`; los ejemplos lo
omiten por brevedad.

```bash
# health (sin tenant)
curl http://localhost:3000/health

# crear cita
curl -X POST http://localhost:3000/api/v1/appointments \
  -H "content-type: application/json" \
  -H "authorization: Bearer <token>" \
  -H "idempotency-key: <uuid>" \
  -d '{
    "patientId": "<uuid>",
    "practitionerId": "<uuid>",
    "startsAt": "2027-03-10T15:00:00-06:00",
    "endsAt": "2027-03-10T15:30:00-06:00",
    "timezone": "America/Mexico_City"
  }'

# listar
curl "http://localhost:3000/api/v1/appointments?from=2027-03-01T00:00:00-06:00&to=2027-04-01T00:00:00-06:00" \
  -H "authorization: Bearer <token>"

# cancelar (idempotente)
curl -X POST "http://localhost:3000/api/v1/appointments/<id>/cancel" \
  -H "content-type: application/json" \
  -H "authorization: Bearer <token>" \
  -H "x-actor-type: patient" \
  -d '{ "reasonCode": "patient_request" }'

# reagendar (crea cita nueva encadenada y cancela la anterior)
curl -X POST "http://localhost:3000/api/v1/appointments/<id>/reschedule" \
  -H "content-type: application/json" \
  -H "authorization: Bearer <token>" \
  -d '{
    "startsAt": "2027-03-10T16:00:00-06:00",
    "endsAt": "2027-03-10T16:30:00-06:00",
    "timezone": "America/Mexico_City"
  }'
```

## Pacientes y servicios

```bash
# alta de paciente adulto (crea household y contactos cifrados)
curl -X POST http://localhost:3000/api/v1/patients \
  -H "authorization: Bearer <token>" -H "content-type: application/json" -d '{
    "firstName":"Ana","lastName":"Gomez","birthDate":"1990-04-12",
    "phone":"+5215512345678","email":"ana@example.com"
  }'

# busqueda por telefono, documento o nombre
curl "http://localhost:3000/api/v1/patients?q=5512345678" \
  -H "authorization: Bearer <token>"

# ficha, alergias y etiquetas
curl http://localhost:3000/api/v1/patients/<id> -H "authorization: Bearer <token>"
curl -X POST http://localhost:3000/api/v1/patients/<id>/allergies \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"allergen":"Penicilina","severity":"anaphylaxis"}'

# catalogo de servicios (admin) y practicantes
curl -X POST http://localhost:3000/api/v1/services \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" \
  -d '{"code":"GENERAL","name":"Consulta general","durationMinutes":30,"bufferAfterMinutes":5,"priceCents":80000}'
curl http://localhost:3000/api/v1/services?active=true -H "authorization: Bearer <token>"
curl http://localhost:3000/api/v1/practitioners -H "authorization: Bearer <token>"

# servicios propios del especialista: duracion y precio por especialista
curl "http://localhost:3000/api/v1/practitioner-services?practitionerId=<id>" \
  -H "authorization: Bearer <token>"
curl -X POST http://localhost:3000/api/v1/practitioners/<id>/services \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" \
  -d '{"serviceName":"Valoración express","durationMinutes":20,"priceCents":50000}'
# Tambien acepta serviceId para reutilizar un servicio existente del catalogo.
curl -X DELETE http://localhost:3000/api/v1/practitioner-services/<assignment-id> \
  -H "authorization: Bearer <admin>"
```

Al crear un especialista se copia el catálogo activo; al crear un servicio se
asigna a los especialistas activos. Cada asignación puede ajustar duración y
precio, y esos valores se usan en disponibilidad, reserva y snapshots de la
cita.

## Transiciones de cita

```bash
POST /api/v1/appointments/<id>/confirm
POST /api/v1/appointments/<id>/check-in   # ventana -90/+45 min
POST /api/v1/appointments/<id>/room
POST /api/v1/appointments/<id>/start
POST /api/v1/appointments/<id>/complete
POST /api/v1/appointments/<id>/no-show    # tras gracia de 15 min
GET  /api/v1/appointments/<id>/history
```

El trigger `appointments_enforce_transition` impide saltos de estado incluso
por SQL directo. El check-in desde `requested` confirma implicitamente y deja
dos eventos en el historial.

## Usuarios del sistema (admin)

```bash
# listar usuarios de la clinica
curl http://localhost:3000/api/v1/users \
  -H "authorization: Bearer <admin>"

# crear
curl -X POST http://localhost:3000/api/v1/users \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" -d '{
    "email":"recepcion@clinica.com","password":"PasswordSegura123",
    "fullName":"Recepcion","role":"receptionist"
  }'

# actualizar (rol, especialista, contraseña o estado)
curl -X PATCH http://localhost:3000/api/v1/users/<id> \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" \
  -d '{"isActive":false}'

# desactivar con DELETE (soft delete)
curl -X DELETE http://localhost:3000/api/v1/users/<id> \
  -H "authorization: Bearer <admin>"
```

Un usuario `practitioner` debe estar vinculado a un especialista activo. No se
puede desactivar el propio usuario ni dejar la clinica sin un admin activo.
`avatarData` es opcional (data URL PNG/JPEG/WebP, max 400 KB).
El cambio de contraseña aplica al siguiente login; los JWT existentes siguen
vigentes hasta expirar.

## Panel de plataforma (SaaS multiempresa)

```bash
# crear el primer administrador de plataforma
pnpm platform:admin plataforma@clinica.com PasswordSegura123 "Admin Plataforma"

# login (mismo endpoint; devuelve scope=platform)
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"plataforma@clinica.com","password":"PasswordSegura123"}'

# listar tenants con metricas
curl http://localhost:3000/api/v1/platform/clinics \
  -H "authorization: Bearer <platform>"

# crear tenant + admin inicial + servicio GENERAL
curl -X POST http://localhost:3000/api/v1/platform/clinics \
  -H "authorization: Bearer <platform>" -H "content-type: application/json" -d '{
    "name":"Clinica del Valle","timezone":"America/Mexico_City","currency":"MXN",
    "admin":{"fullName":"Admin Valle","email":"admin@valle.com","password":"PasswordSegura123"}
  }'

# suspender / reactivar
curl -X PATCH http://localhost:3000/api/v1/platform/clinics/<id> \
  -H "authorization: Bearer <platform>" -H "content-type: application/json" \
  -d '{"isActive":false}'

# usuarios del tenant
curl -X POST http://localhost:3000/api/v1/platform/clinics/<id>/users \
  -H "authorization: Bearer <platform>" -H "content-type: application/json" -d '{
    "fullName":"Recepcion","email":"recepcion@valle.com",
    "password":"PasswordSegura123","role":"receptionist"
  }'
```

Los tokens de plataforma no pueden entrar a rutas de tenant y viceversa. Un
tenant suspendido bloquea login y tokens existentes. Las metricas se calculan
por tenant; no se expone PHI entre clinicas.

## Especialistas y disponibilidad

```bash
# alta (admin)
curl -X POST http://localhost:3000/api/v1/practitioners \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" -d '{
    "fullName":"Dra. Nueva","specialty":"Dermatologia",
    "color":"#2563EB","defaultSlotMinutes":45,"bufferAfterMinutes":10
  }'

# listar (incluye inactivos para administracion)
curl "http://localhost:3000/api/v1/practitioners?includeInactive=true" \
  -H "authorization: Bearer <token>"

# editar perfil / desactivar
curl -X PATCH http://localhost:3000/api/v1/practitioners/<id> \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" \
  -d '{"isActive":false}'

# reglas semanales: crear, editar, eliminar
curl -X POST http://localhost:3000/api/v1/availability/rules \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" -d '{
    "practitionerId":"<id>","weekday":1,"startTime":"09:00","endTime":"13:00",
    "validFrom":"2026-11-01","slotMinutes":15
  }'
curl -X PATCH http://localhost:3000/api/v1/availability/rules/<ruleId> \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" \
  -d '{"endTime":"14:00"}'
curl -X DELETE http://localhost:3000/api/v1/availability/rules/<ruleId> \
  -H "authorization: Bearer <admin>"

# horario semanal en varios dias con comida (crea mañana y tarde)
curl -X POST http://localhost:3000/api/v1/availability/rules/bulk \
  -H "authorization: Bearer <admin>" -H "content-type: application/json" -d '{
    "practitionerId":"<id>","weekdays":[1,3,5],
    "startTime":"08:00","endTime":"18:00",
    "lunchStart":"12:00","lunchEnd":"14:00",
    "validFrom":"2026-12-01","slotMinutes":15
  }'
```

Los bloqueos puntuales siguen en `POST/DELETE /availability/blocks`. Los
buffers y el slot por defecto del especialista se usan al calcular la agenda.

## Sala de espera y tiempo real

```bash
# tablero de sala (staff)
curl "http://localhost:3000/api/v1/waiting-room?date=2026-10-28" \
  -H "authorization: Bearer <token>"

# stream SSE (el navegador pasa por /api/stream de Next)
curl -N "http://localhost:3000/api/v1/realtime/stream?topics=agenda,sala" \
  -H "authorization: Bearer <token>"
```

La sala devuelve `inRoom`, `inConsultation`, `upcoming` y `practitionerStatus`
con semáforo verde/ámbar/rojo. Los eventos SSE no llevan PHI: solo IDs, topic y
tipo de evento. El bus actual es en proceso; para múltiples instancias se
sustituye por Redis pub/sub o LISTEN/NOTIFY sin cambiar el contrato.

## Reglas de reserva

- `x-actor-type: staff` (default) puede forzar horarios fuera de la regla; el
  personal lo necesita para urgencias y sobrecupos.
- `x-actor-type: patient` (reserva publica) **solo** puede usar slots que
  devuelve `/availability`, y no puede crear sobrecupos.
- Cancelar es idempotente; cancelar una cita `completed` o `no_show` devuelve
  `409 INVALID_TRANSITION`.
- Reagendar cancela la cita anterior con motivo `rescheduled` y crea una nueva
  con `rescheduledFromId`. Si el nuevo horario choca, la transaccion revierte y
  la cita original sigue activa.
- Ambos flujos cancelan los `reminder_jobs` pendientes en la misma transaccion.

## Recordatorios

Al reservar se materializan 3 jobs (48h / 24h / 2h antes) en la misma
transaccion que crea la cita.

```bash
pnpm worker   # procesa jobs vencidos cada 30s
```

- Zona horaria del consultorio y DST-safe.
- Horario de silencio 21:00–08:00: se mueve a las 08:00 y se omite si quedaria
  despues de la cita.
- Reintentos con backoff (1 min, 5 min) y **fallback de canal**
  WhatsApp → SMS → email.
- `patients.reminder_opt_out` y los estados `cancelled` / `no_show` /
  `completed` se respetan tambien **en el envio**, no solo al programar.
- El worker corre con el rol `crm_worker` (BYPASSRLS) porque procesa jobs de
  todas las clinicas; la API nunca usa ese rol.
- `createConsoleSender()` es el sender de desarrollo. Para produccion se
  implementa `MessageSender` (`src/modules/reminders/sender.ts`) con Meta Cloud
  API / Twilio / Postmark, incluyendo plantillas aprobadas de WhatsApp y la
  ventana de 24 h.

## Lista de espera

```bash
# alta (practitionerId opcional = "cualquiera")
curl -X POST http://localhost:3000/api/v1/waitlist \
  -H "content-type: application/json" -H "authorization: Bearer <token>" -d '{
    "patientId": "<uuid>",
    "practitionerId": "<uuid>",
    "earliestDate": "2027-03-01",
    "latestDate": "2027-03-31",
    "preferredTimeFrom": "09:00",
    "preferredTimeTo": "12:00",
    "priority": 10
  }'

# ofertas (staff)
curl "http://localhost:3000/api/v1/waitlist/offers?status=pending" -H "authorization: Bearer <token>"

# aceptar / rechazar
curl -X POST "http://localhost:3000/api/v1/waitlist/offers/<id>/accept" -H "authorization: Bearer <token>"
curl -X POST "http://localhost:3000/api/v1/waitlist/offers/<id>/decline" -H "authorization: Bearer <token>"

# entrar / salir
curl "http://localhost:3000/api/v1/waitlist?status=waiting" -H "authorization: Bearer <token>"
curl -X DELETE "http://localhost:3000/api/v1/waitlist/<id>" -H "authorization: Bearer <token>"
```

- Al cancelar o reagendar una cita, el hueco liberado se ofrece **en la misma
  transaccion** al mejor candidato.
- Orden: `priority` descendente y luego FIFO (`createdAt`).
- Ventana de fechas y horario preferido se respetan; `practitionerId` nulo
  acepta cualquier especialista.
- Una sola oferta `pending` por entrada (indice parcial unico), TTL de 20 min.
- Rechazo, expiracion o baja de la entrada encadenan el hueco al siguiente.
- Solo se ofrecen huecos que el motor de disponibilidad considera libres.
- Aceptar crea la cita con `bookedVia = 'waitlist'` y reutiliza el nucleo
  transaccional de reserva (misma validacion de solape).
- Limitacion conocida: la oferta **no retiene** el hueco; si el portal publico
  lo reserva antes, aceptar devuelve `409`.

## Disponibilidad

```bash
# crear regla semanal (lunes 09:00-12:00, slots de 15 min)
curl -X POST http://localhost:3000/api/v1/availability/rules \
  -H "content-type: application/json" -H "authorization: Bearer <token>" -d '{
    "practitionerId": "<uuid>",
    "weekday": 1,
    "startTime": "09:00",
    "endTime": "12:00",
    "validFrom": "2027-01-01",
    "slotMinutes": 15
  }'

# bloqueo puntual (reunion 10:00-11:00)
curl -X POST http://localhost:3000/api/v1/availability/blocks \
  -H "content-type: application/json" -H "authorization: Bearer <token>" -d '{
    "practitionerId": "<uuid>",
    "startsAt": "2027-03-01T10:00:00-06:00",
    "endsAt": "2027-03-01T11:00:00-06:00",
    "type": "meeting",
    "reason": "Reunion clinica"
  }'

# slots libres (publico: tenant por header)
# Sin durationMinutes cada regla usa su slotMinutes como duracion.
curl "http://localhost:3000/api/v1/availability?practitionerId=<uuid>&from=2027-03-01&to=2027-03-08" \
  -H "x-clinic-id: <uuid>"

# gestion
curl "http://localhost:3000/api/v1/availability/rules?practitionerId=<uuid>" -H "authorization: Bearer <token>"
curl "http://localhost:3000/api/v1/availability/blocks?practitionerId=<uuid>&from=2027-03-01T00:00:00Z&to=2027-04-01T00:00:00Z" -H "authorization: Bearer <token>"
curl -X DELETE "http://localhost:3000/api/v1/availability/blocks/<id>" -H "authorization: Bearer <token>"
```

Reglas de calculo:

- `weekday` ISO: 1 = lunes ... 7 = domingo.
- Los slots se generan en la zona `clinics.timezone` y se devuelven en UTC.
- Si se envia `serviceId`, la duracion y buffers salen del servicio. Si no, se
  usa `durationMinutes`; al omitirlo, cada regla usa su `slotMinutes`.
- Se descartan slots pasados, los que solapan bloqueos y los que solapan citas
  activas. El sobrecupo **no** consume disponibilidad.
- Reglas solapadas se deduplican por instante de inicio.
- DST: se avanza con aritmetica zonal, no sumando minutos al reloj de pared.
  En primavera no aparecen horas inexistentes; en otono se conservan las dos
  ocurrencias de la hora repetida (ver `test/availability/slots.test.ts`).

La consulta de slots es publica; el resto de endpoints requieren JWT. En
produccion, el `x-clinic-id` del portal deberia salir de un slug de clinica o de
un token de reserva firmado.

## Pruebas

```bash
pnpm test
```

Levanta un Postgres efimero con Testcontainers (requiere Docker), aplica las
migraciones y verifica:

- reserva concurrente del mismo slot: exactamente una gana,
- la exclusion constraint bloquea inserts que evaden el servicio,
- idempotencia de la reserva,
- RLS: un tenant no ve pacientes de otro,
- mapeo HTTP 201 / 409,
- disponibilidad: regla semanal, bloqueos, citas existentes,
- DST: primavera y otono en `America/New_York`,
- validacion de rangos y reglas duplicadas,
- reserva publica dentro/fuera de la regla y staff forzando horario,
- cancelacion idempotente y cancelacion de recordatorios,
- reagendado con cadena `rescheduled_from_id` y rollback si el slot esta ocupado,
- recordatorios: materializacion 48/24/2h, horario de silencio y DST,
- worker: envio, idempotencia, reintentos con backoff, fallback de canal y opt-out,
- lista de espera: prioridad, oferta al cancelar, aceptar/rechazar, expiracion
  en cascada y ventana horaria,
- auth: login, token invalido, rutas protegidas y RBAC por rol,
- auditoria: cadena de hash verificable y evento de reserva publica,
- alcance del medico: solo sus citas y no puede tocar las de otro.

## Decisiones que ya estan en el codigo

- **Anti doble reserva**: `EXCLUDE USING gist` sobre `tstzrange` + advisory lock
  por medico/dia (migracion `0001`).
- **Aislamiento**: RLS con `app.clinic_id` por transaccion (`withTenant`).
- **Integridad de tenant**: FKs compuestas `(patient_id, clinic_id)` y
  `(practitioner_id, clinic_id)`.
- **Idempotencia**: `idempotency_keys` con PK `(clinic_id, key)`.
- **Estados**: `text` + `CHECK` para evolucionar sin `ALTER TYPE`.
- **Disponibilidad**: reglas semanales con vigencia, bloqueos que siempre ganan
  y generacion de slots en hora local del consultorio (Luxon), devueltos en UTC.
- **Reserva validada**: la reserva publica exige un slot del motor de
  disponibilidad; el staff puede forzar (sobrecupo, urgencias).
- **Cancelacion/reagendado**: transaccionales, cancelan `reminder_jobs` en la
  misma transaccion y dejan cadena `rescheduled_from_id`.
- **Recordatorios**: jobs materializados al reservar, worker con
  `FOR UPDATE SKIP LOCKED`, backoff y fallback de canal; idempotentes por
  estado (un job `sent` no se vuelve a enviar).
- **Lista de espera**: ofertas con TTL, prioridad + FIFO, cascada al expirar o
  rechazar, y aceptacion atomica sobre el nucleo de reserva.
- **Auth**: JWT HS256, contrasenas con scrypt, usuario releido por request.
- **RBAC**: permisos por rol (`admin`, `practitioner`, `receptionist`) y
  alcance por especialista en citas y agenda.
- **Auditoria**: eventos append-only encadenados por hash y aislados por RLS.
- **Auditoria de PHI**: logs con `redact`; prohibido loguear datos de paciente.

## Pendiente (siguiente slice)

- UI de pacientes, agenda v2, sala de espera y check-in.
- SSE para agenda/sala (`/realtime/stream`) y semáforo de retraso.
- Hold del hueco durante la oferta de lista de espera (hoy es solo TTL).
- Plantillas aprobadas de WhatsApp, opt-in por canal y webhooks de entrega.
- `NOT NULL` de `patients.household_id` y snapshots de citas cuando seed/tests
  creen households/servicios en todos los inserts.
- Refresh tokens, revocacion por sesion y rate limit de login.
- Trigger generico de `updated_at`.
- Marcar `no_show` automaticamente al cierre del dia.
- Portal publico con Next.js.

## Bandeja, cobro y portal publico

```bash
# recordatorios (staff)
curl "http://localhost:3000/api/v1/reminders?status=pending&limit=50" \
  -H "authorization: Bearer <token>"
curl -X POST http://localhost:3000/api/v1/reminders/<id>/retry \
  -H "authorization: Bearer <token>"

# lista de espera (staff)
curl http://localhost:3000/api/v1/waitlist -H "authorization: Bearer <token>"
curl http://localhost:3000/api/v1/waitlist/offers -H "authorization: Bearer <token>"
curl -X POST http://localhost:3000/api/v1/waitlist/offers/<id>/accept \
  -H "authorization: Bearer <token>"

# cobro + cierre de cita
curl -X POST http://localhost:3000/api/v1/appointments/<id>/checkout \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"amountCents":80000,"method":"card","notes":"Pagado en recepcion"}'

# portal publico (sin token)
curl http://localhost:3000/api/v1/public/clinics/<slug>
curl "http://localhost:3000/api/v1/public/clinics/<slug>/availability?serviceId=<id>&practitionerId=<id>&date=2026-11-02"
curl -X POST http://localhost:3000/api/v1/public/clinics/<slug>/appointments \
  -H "content-type: application/json" -d '{
    "serviceId":"<id>","practitionerId":"<id>",
    "startsAt":"2026-11-02T09:00:00-06:00",
    "endsAt":"2026-11-02T09:30:00-06:00",
    "patient":{"firstName":"Ana","lastName":"Lopez","phone":"+525512345678"}
  }'
```

El portal resuelve la clinica por `slug` y crea o reutiliza al paciente por
telefono/correo. La cita queda en estado `requested` para confirmacion de la
clinica. El checkout registra el pago y completa la cita en una sola
transaccion.

Los recordatorios nuevos priorizan WhatsApp cuando el paciente tiene telefono;
si no hay telefono usan correo. Ya no se generan SMS nuevos. Si falla WhatsApp,
el worker reintenta y puede caer a correo cuando existe.
