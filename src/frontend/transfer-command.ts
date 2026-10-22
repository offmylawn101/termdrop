import { shellDoubleQuote } from "../shared/filename";
import type { CreateSessionResponse } from "../shared/protocol";
import type { TransferSelection } from "./transfer-selection";

export function curlCommand(session: CreateSessionResponse, selection: TransferSelection): string {
  if (selection.kind !== "file") {
    return `curl -fL ${shellDoubleQuote(session.downloadUrl)} | tar -xk`;
  }
  return `curl -fL ${shellDoubleQuote(session.downloadUrl)} -o ${shellDoubleQuote(session.outputFilename)}`;
}
