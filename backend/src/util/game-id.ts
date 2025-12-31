import { randomBytes } from "node:crypto";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const ID_LENGTH = 8;

export function generateGameId(): string {
  const bytes = randomBytes(ID_LENGTH);
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    // bytes[i] is 0-255. Map it to the alphabet.
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}
