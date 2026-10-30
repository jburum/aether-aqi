/** Rule the week-1 store refused. `code` is the stable API token. */
export class V1RuleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "V1RuleError";
    this.code = code;
    this.status = status;
  }
}
