import { OJ_MAX_RETRY_AFTER_MS, type OjErrorCode } from "@kaiserunix/oj-mcp-contracts";
import { OjAdapterError } from "@kaiserunix/oj-mcp-server-common";

export const MAX_RETRY_AFTER_MS = OJ_MAX_RETRY_AFTER_MS;

export interface NowCoderErrorMetadata {
  httpStatus?: number;
  retryAfterMs?: number;
}

export class NowCoderAdapterError extends OjAdapterError {
  readonly options: NowCoderErrorMetadata;

  constructor(
    code: OjErrorCode,
    message: string,
    options: NowCoderErrorMetadata = {}
  ) {
    super(code, message, options);
    this.name = "NowCoderAdapterError";
    this.options = Object.freeze({
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {})
    });
  }
}
