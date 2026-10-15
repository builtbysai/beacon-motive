export type ErrorCode =
  | "invalid_workflow"
  | "invalid_args"
  | "unknown_op"
  | "unresolved_reference"
  | "unsupported"
  | "permission_denied"
  | "scope_denied"
  | "not_found"
  | "ambiguous"
  | "not_actionable"
  | "timeout"
  | "cancelled"
  | "postcondition_failed"
  | "precondition_failed"
  | "adapter_failed"
  | "internal";

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class MotiveError extends Error {
  code: ErrorCode;
  retryable: boolean;
  details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "MotiveError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    if (opts.details) this.details = opts.details;
  }
  toJSON(): ErrorInfo {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) };
  }
}

export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof MotiveError) return e.toJSON();
  const message = e instanceof Error ? e.message : String(e);
  return { code: "internal", message, retryable: false };
}
