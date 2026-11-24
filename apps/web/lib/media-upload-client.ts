export interface AdminMediaUploadSuccess {
  readonly ok: true;
  readonly mediaId: string;
  readonly mediaType?: string;
  readonly reused: boolean;
  readonly requestId: string;
}

export class AdminMediaUploadError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "AdminMediaUploadError";
  }
}

function responseRecord(xhr: XMLHttpRequest): Record<string, unknown> | null {
  const candidate =
    typeof xhr.response === "object" && xhr.response !== null
      ? (xhr.response as Record<string, unknown>)
      : null;
  if (candidate) return candidate;
  try {
    const parsed = JSON.parse(xhr.responseText) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function uploadAdminMedia(options: {
  readonly url: string;
  readonly formData: FormData;
  readonly onProgress: (percent: number | null) => void;
}): Promise<AdminMediaUploadSuccess> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", options.url, true);
    xhr.responseType = "json";
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.addEventListener("progress", (event) => {
      options.onProgress(
        event.lengthComputable && event.total > 0
          ? Math.min(100, Math.round((event.loaded / event.total) * 100))
          : null,
      );
    });
    xhr.addEventListener("error", () => reject(new AdminMediaUploadError("network", 0)));
    xhr.addEventListener("abort", () => reject(new AdminMediaUploadError("aborted", 0)));
    xhr.addEventListener("load", () => {
      const payload = responseRecord(xhr);
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        payload?.ok === true &&
        typeof payload.mediaId === "string" &&
        typeof payload.reused === "boolean" &&
        typeof payload.requestId === "string"
      ) {
        resolve({
          ok: true,
          mediaId: payload.mediaId,
          ...(typeof payload.mediaType === "string" ? { mediaType: payload.mediaType } : {}),
          reused: payload.reused,
          requestId: payload.requestId,
        });
        return;
      }
      reject(
        new AdminMediaUploadError(
          typeof payload?.error === "string" ? payload.error : "upload_failed",
          xhr.status,
        ),
      );
    });
    options.onProgress(0);
    xhr.send(options.formData);
  });
}

export function adminMediaUploadMessage(code: string): string {
  switch (code) {
    case "mfa_stale":
      return "Confirma tu autenticador antes de volver a subir el archivo.";
    case "unauthorized":
      return "Tu sesión administrativa expiró. Vuelve a ingresar antes de reintentar.";
    case "forbidden":
    case "invalid_origin":
      return "Tu sesión no está autorizada para esta carga.";
    case "payload_too_large":
      return "Los archivos superan el límite permitido. Revisa sus tamaños y vuelve a seleccionarlos.";
    case "unsupported_media_type":
    case "invalid_upload":
      return "Revisa los campos y vuelve a seleccionar archivos válidos.";
    case "upload_conflict":
      return "El contenido cambió o ya está asociado a otro medio. Recarga antes de reintentar.";
    case "network":
      return "Se interrumpió la conexión. No se reintentó automáticamente; verifica el estado y vuelve a intentarlo.";
    default:
      return "No pudimos procesar o almacenar el medio. Vuelve a seleccionar el archivo antes de reintentar.";
  }
}
