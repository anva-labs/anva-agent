export class AnvaError extends Error {
  readonly code: string;
  readonly next: string;
  readonly status: number;

  constructor(code: string, next: string, status = 400) {
    super(`${code}: ${next}`);
    this.name = "AnvaError";
    this.code = code;
    this.next = next;
    this.status = status;
  }
}
