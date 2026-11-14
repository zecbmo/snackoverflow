/** Adding products this household named to Open Food Facts. */
import { type FeaturesDto, isShareableBarcode, type OffShareResultDto, type ProductDto } from '@snackoverflow/shared';
import { api } from './api';

/** Whether this product could go on Open Food Facts once it has a name. */
export function canShareWithOff(p: ProductDto, features: FeaturesDto): boolean {
  return features.offContribute && !p.isMeal && p.source !== 'off' && !p.offSharedAt && p.barcodes.some(isShareableBarcode);
}

/** Adds it and says how it went, in a line for a toast. */
export async function shareWithOff(productId: string): Promise<{ product: ProductDto; message: string }> {
  const r = await api.post<OffShareResultDto>(`/api/products/${productId}/off`);
  const message = r.added.length > 0 ? 'Added to Open Food Facts. Thanks for helping!' : 'Open Food Facts already has it, so nothing was changed.';
  return { product: r.product, message };
}

const KEY = 'so.off.share';

/** The "add it to Open Food Facts too" tick, remembered on this device. */
export function rememberedShare(): boolean {
  try {
    return localStorage.getItem(KEY) === 'yes';
  } catch {
    return false;
  }
}

export function rememberShare(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'yes' : 'no');
  } catch {
    // Private window or blocked storage: the tick just isn't remembered.
  }
}
