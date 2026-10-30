import { describe, expect, it } from "vitest";
import {
  blindIndex,
  decryptPhi,
  documentBlindIndex,
  emailBlindIndex,
  encryptPhi,
  maskDocument,
  maskEmail,
  maskPhone,
  normalizeDocument,
  normalizeEmail,
  normalizePhone,
  phoneBlindIndex,
} from "../../src/lib/phi-crypto.js";

describe("phi-crypto", () => {
  it("cifra y descifra sin exponer el plaintext", () => {
    const plaintext = "+5215512345678";
    const ciphertext = encryptPhi(plaintext);

    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(ciphertext.toString("utf8")).not.toContain(plaintext);
    expect(decryptPhi(ciphertext)).toBe(plaintext);
  });

  it("usa IV aleatorio: el mismo valor produce ciphertext distinto", () => {
    const a = encryptPhi("mismo-valor");
    const b = encryptPhi("mismo-valor");

    expect(a.equals(b)).toBe(false);
    expect(decryptPhi(a)).toBe("mismo-valor");
    expect(decryptPhi(b)).toBe("mismo-valor");
  });

  it("falla si el ciphertext fue alterado", () => {
    const ciphertext = encryptPhi("dato-sensible");
    const last = ciphertext.length - 1;
    ciphertext[last] = (ciphertext[last] ?? 0) ^ 0xff;

    expect(() => decryptPhi(ciphertext)).toThrow();
  });

  it("normaliza y produce blind index determinista", () => {
    expect(normalizePhone(" +52 (155) 1234-5678 ")).toBe("+5215512345678");
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(normalizeDocument(" ab-123 ")).toBe("AB-123");

    expect(phoneBlindIndex("+52 155 1234 5678")).toBe(
      phoneBlindIndex("+5215512345678"),
    );
    expect(emailBlindIndex("ANA@example.com")).toBe(
      emailBlindIndex("ana@example.com"),
    );
    expect(documentBlindIndex("ab-123")).toBe(documentBlindIndex("AB-123"));
    expect(phoneBlindIndex("+5215512345678")).not.toBe(
      emailBlindIndex("+5215512345678"),
    );
    expect(blindIndex("x")).toHaveLength(64);
  });

  it("enmascara para UI sin revelar el valor completo", () => {
    expect(maskPhone("+5215512345678")).toBe("+52******5678");
    expect(maskEmail("ana@example.com")).toBe("a***@example.com");
    expect(maskDocument("AB-123456")).toBe("****3456");
    expect(maskPhone("123")).toBe("****");
  });
});
