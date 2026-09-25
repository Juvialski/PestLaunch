const AUDIO_TYPES: Record<string, { mimeType: string; acceptedMimeTypes: string[] }> = {
  mp3: { mimeType: "audio/mpeg", acceptedMimeTypes: ["audio/mpeg", "audio/mp3"] },
  wav: {
    mimeType: "audio/wav",
    acceptedMimeTypes: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  },
  m4a: { mimeType: "audio/mp4", acceptedMimeTypes: ["audio/mp4", "audio/m4a", "audio/x-m4a"] },
  webm: { mimeType: "audio/webm", acceptedMimeTypes: ["audio/webm"] },
};

const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream"]);
const MAX_FILENAME_LENGTH = 255;
const BYTES_PER_MEBIBYTE = 1024 * 1024;

export type AudioUploadInput = {
  originalName: string;
  mimeType: string;
  size: number;
};

export type AudioUploadValidation =
  | {
      ok: true;
      originalFilename: string;
      extension: string;
      mimeType: string;
    }
  | {
      ok: false;
      statusCode: 400 | 413 | 415;
      code: "EMPTY_AUDIO_FILE" | "UPLOAD_TOO_LARGE" | "UNSUPPORTED_AUDIO_TYPE";
      message: string;
    };

export function validateAudioUpload(
  input: AudioUploadInput,
  maxUploadBytes: number,
): AudioUploadValidation {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    return {
      ok: false,
      statusCode: 400,
      code: "EMPTY_AUDIO_FILE",
      message: "Choose a non-empty audio file.",
    };
  }

  if (input.size > maxUploadBytes) {
    return {
      ok: false,
      statusCode: 413,
      code: "UPLOAD_TOO_LARGE",
      message: `Audio must be ${formatMaxUploadSize(maxUploadBytes)} or smaller.`,
    };
  }

  const basename = input.originalName.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const cleanedFilename = Array.from(basename)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join("")
    .trim();

  if (!cleanedFilename) {
    return unsupportedAudioType();
  }

  const dotIndex = cleanedFilename.lastIndexOf(".");
  const extension = dotIndex >= 0 ? cleanedFilename.slice(dotIndex + 1).toLowerCase() : "";
  const audioType = AUDIO_TYPES[extension];
  const suppliedMimeType = input.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";

  if (
    !audioType ||
    (!GENERIC_MIME_TYPES.has(suppliedMimeType) &&
      !audioType.acceptedMimeTypes.includes(suppliedMimeType))
  ) {
    return unsupportedAudioType();
  }

  const filenameStem = cleanedFilename.slice(0, dotIndex).trim();
  const maxStemLength = MAX_FILENAME_LENGTH - extension.length - 1;
  const originalFilename = `${filenameStem.slice(0, maxStemLength)}.${extension}`;

  return {
    ok: true,
    originalFilename,
    extension,
    mimeType: audioType.mimeType,
  };
}

export function formatMaxUploadSize(bytes: number): string {
  if (bytes < BYTES_PER_MEBIBYTE) {
    return `${bytes} bytes`;
  }

  const megabytes = bytes / BYTES_PER_MEBIBYTE;
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

function unsupportedAudioType(): AudioUploadValidation {
  return {
    ok: false,
    statusCode: 415,
    code: "UNSUPPORTED_AUDIO_TYPE",
    message: "Choose an MP3, WAV, M4A, or WebM audio file.",
  };
}
