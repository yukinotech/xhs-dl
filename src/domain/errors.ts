export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
    public readonly details: Record<string, unknown> = {},
    public readonly retryable = false,
    public readonly actionRequired: string | null = null,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export function protocolError(
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError("PROTOCOL_INCOMPATIBLE", message, 10, details);
}
export function requireValue<T>(
  value: T | null | undefined,
  message: string,
): T {
  if (value === undefined || value === null || value === "")
    throw protocolError(message);
  return value;
}

export const exitCodes = {
  success: 0,
  internal_error: 1,
  invalid_input: 2,
  auth_required: 3,
  verification_required: 4,
  rate_limited: 5,
  network_or_busy: 6,
  content_unavailable: 7,
  filesystem: 8,
  partial_failure: 9,
  protocol_incompatible: 10,
  permission_denied: 11,
  interrupted: 130,
} as const;
