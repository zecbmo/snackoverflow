/** Getting photos ready to send: big photos are slow to send and no easier to read. */

/** Shrink a photo to a 1600px JPEG, as base64. */
export async function shrinkImage(file: File): Promise<{ data: string; type: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.75);
  return { data: url.slice(url.indexOf(',') + 1), type: 'image/jpeg' };
}

/** A file as it is, as base64. */
export async function readRaw(file: File): Promise<{ data: string; type: string }> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsDataURL(file);
  });
  return { data: url.slice(url.indexOf(',') + 1), type: file.type };
}

/** A photo ready to send: shrunk when the browser can, as it is otherwise. */
export const photoBody = (file: File) => shrinkImage(file).catch(() => readRaw(file));
