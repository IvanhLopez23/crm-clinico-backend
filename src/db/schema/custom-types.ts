import { customType } from "drizzle-orm/pg-core";

/**
 * Drizzle 0.45 no trae `bytea` como columna de primera clase. Se usa para
 * ciphertext de PHI (documento, telefono, email). El cifrado/descifrado vive
 * en la capa de aplicacion; la DB solo almacena bytes.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
