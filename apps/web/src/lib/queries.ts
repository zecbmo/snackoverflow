/** React Query hooks for each resource. Keys line up with the server's live-update topics. */
import { useQuery } from '@tanstack/react-query';
import type {
  IngredientDto,
  LocationDto,
  NotificationSettingsDto,
  ProductDto,
  SessionDto,
  ShelfLifeCategoryDto,
  StockEventDto,
  StockItemDto,
  UserDto,
  WasteSummaryDto,
} from '@snackoverflow/shared';
import { api } from './api';

export const keys = {
  session: ['session'] as const,
  stock: ['stock'] as const,
  stockItem: (id: string) => ['stock', id] as const,
  waste: ['stock', 'waste'] as const,
  locations: ['locations'] as const,
  products: (q = '', unnamed = false) => ['products', q, unnamed] as const,
  product: (id: string) => ['products', 'one', id] as const,
  productStock: (id: string) => ['stock', 'product', id] as const,
  ingredients: ['ingredients'] as const,
  shelfLife: ['ingredients', 'shelf-life'] as const,
  users: ['users'] as const,
  notifications: ['users', 'notifications'] as const,
};

export const useSession = () => useQuery({ queryKey: keys.session, queryFn: () => api.get<SessionDto>('/api/session'), retry: false });
export const useStock = () => useQuery({ queryKey: keys.stock, queryFn: () => api.get<StockItemDto[]>('/api/stock') });
export const useStockItem = (id: string) =>
  useQuery({ queryKey: keys.stockItem(id), queryFn: () => api.get<{ item: StockItemDto; events: StockEventDto[] }>(`/api/stock/${id}`) });
export const useWaste = () => useQuery({ queryKey: keys.waste, queryFn: () => api.get<WasteSummaryDto>('/api/stats/waste') });
export const useLocations = () => useQuery({ queryKey: keys.locations, queryFn: () => api.get<LocationDto[]>('/api/locations') });
export const useProducts = (q = '', unnamed = false) =>
  useQuery({
    queryKey: keys.products(q, unnamed),
    queryFn: () => api.get<ProductDto[]>(`/api/products?q=${encodeURIComponent(q)}${unnamed ? '&unnamed=1' : ''}`),
  });
export const useProduct = (id: string) => useQuery({ queryKey: keys.product(id), queryFn: () => api.get<ProductDto>(`/api/products/${id}`) });
export const useProductStock = (id: string) =>
  useQuery({ queryKey: keys.productStock(id), queryFn: () => api.get<StockItemDto[]>(`/api/products/${id}/stock`) });
export const useIngredients = () => useQuery({ queryKey: keys.ingredients, queryFn: () => api.get<IngredientDto[]>('/api/ingredients') });
export const useShelfLife = () => useQuery({ queryKey: keys.shelfLife, queryFn: () => api.get<ShelfLifeCategoryDto[]>('/api/shelf-life') });
export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: () => api.get<UserDto[]>('/api/users') });
export const useNotificationSettings = () =>
  useQuery({ queryKey: keys.notifications, queryFn: () => api.get<NotificationSettingsDto>('/api/me/notifications') });
