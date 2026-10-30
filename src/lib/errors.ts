export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class SlotTakenError extends AppError {
  constructor() {
    super(409, "SLOT_TAKEN", "El horario ya no esta disponible");
  }
}
