export const BANNER_WIDTH = 1_200;
export const BANNER_HEIGHT = 160;
export const BANNER_ASPECT_RATIO = BANNER_WIDTH / BANNER_HEIGHT;

interface BannerPlacement {
  destinationX: number;
  destinationY: number;
  destinationWidth: number;
  destinationHeight: number;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}

export function bannerPlacement(width: number, height: number): BannerPlacement {
  if (!(width > 0) || !(height > 0)) throw new Error("The image has invalid dimensions.");
  const sourceRatio = width / height;
  if (sourceRatio > BANNER_ASPECT_RATIO) {
    const destinationHeight = BANNER_WIDTH / sourceRatio;
    return {
      destinationX: 0,
      destinationY: (BANNER_HEIGHT - destinationHeight) / 2,
      destinationWidth: BANNER_WIDTH,
      destinationHeight,
    };
  }
  const destinationWidth = BANNER_HEIGHT * sourceRatio;
  return {
    destinationX: (BANNER_WIDTH - destinationWidth) / 2,
    destinationY: 0,
    destinationWidth,
    destinationHeight: BANNER_HEIGHT,
  };
}

export async function prepareBannerImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  const decoded = await decodeImage(file);
  try {
    const placement = bannerPlacement(decoded.width, decoded.height);
    const canvas = document.createElement("canvas");
    canvas.width = BANNER_WIDTH;
    canvas.height = BANNER_HEIGHT;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("This browser could not prepare the banner.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      decoded.source,
      placement.destinationX,
      placement.destinationY,
      placement.destinationWidth,
      placement.destinationHeight,
    );

    const output = await canvasBlob(canvas, "image/webp", 0.88)
      ?? await canvasBlob(canvas, "image/png");
    if (!output) throw new Error("This browser could not export the banner.");
    return new File([output], `${filenameStem(file.name)}-banner.${output.type === "image/webp" ? "webp" : "png"}`, {
      type: output.type,
      lastModified: Date.now(),
    });
  } finally {
    decoded.dispose();
  }
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // Fall through to an HTMLImageElement for formats the bitmap decoder rejects.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = objectUrl;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new Error("The selected image could not be read.");
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dispose: () => URL.revokeObjectURL(objectUrl),
  };
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function filenameStem(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return stem.slice(0, 80) || "sponsor";
}
