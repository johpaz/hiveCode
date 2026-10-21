/**
 * Error de uso: el mensaje va a stderr tal cual y el proceso termina con
 * código 1. Todo lo que no sea un `ErrorInventario` se trata como un fallo
 * inesperado (se avisa igualmente, pero con un mensaje genérico).
 */
export class ErrorInventario extends Error {
  constructor(mensaje: string) {
    super(mensaje)
    this.name = "ErrorInventario"
  }
}

/** Mensaje legible de cualquier error, sin(stack) para el usuario. */
export function mensajeDe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
