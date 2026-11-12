/** React Query hooks for each resource. Keys line up with the server's live-update topics. */
import { useQuery } from '@tanstack/react-query';
import type {
  CalorieStatsDto,
  CookPlanDto,
  SpendingDto,
  StatsPeriod,
  WasteReportDto,
  DeviceDto,
  EarmarkDto,
  IngredientDto,
  LocationDto,
  NotificationListDto,
  NotificationSettingsDto,
  PlanDto,
  ProductDto,
  ReceiptDto,
  ReceiptSummaryDto,
  RecipeDto,
  RecipeScore,
  RecipeSummaryDto,
  RunningLowDto,
  SessionDto,
  ShelfLifeCategoryDto,
  ShoppingItemDto,
  StockEventDto,
  StockItemDto,
  UserDto,
} from '@snackoverflow/shared';
import { api } from './api';

export const keys = {
  session: ['session'] as const,
  stock: ['stock'] as const,
  stockItem: (id: string) => ['stock', id] as const,
  locations: ['locations'] as const,
  products: (q = '', unnamed = false) => ['products', q, unnamed] as const,
  product: (id: string) => ['products', 'one', id] as const,
  productStock: (id: string) => ['stock', 'product', id] as const,
  ingredients: ['ingredients'] as const,
  shelfLife: ['ingredients', 'shelf-life'] as const,
  users: ['users'] as const,
  notifications: ['users', 'notifications'] as const,
  inbox: ['notifications'] as const,
  devices: ['users', 'devices'] as const,
  recipes: ['recipes'] as const,
  recipe: (id: string) => ['recipes', id] as const,
  cookPlan: (id: string, servings: number) => ['stock', 'cook-plan', id, servings] as const,
  cooks: ['stock', 'cooks'] as const,
  plan: (from: string, to: string, person: string) => ['plan', from, to, person] as const,
  earmarks: ['plan', 'earmarks'] as const,
  shopping: ['shopping'] as const,
  runningLow: ['shopping', 'running-low'] as const,
  receipts: ['receipts'] as const,
  recipeScores: ['stock', 'recipe-scores'] as const,
  surplus: ['stock', 'surplus'] as const,
  receipt: (id: string) => ['receipts', id] as const,
};

export const useSession = () => useQuery({ queryKey: keys.session, queryFn: () => api.get<SessionDto>('/api/session'), retry: false });
export const useStock = () => useQuery({ queryKey: keys.stock, queryFn: () => api.get<StockItemDto[]>('/api/stock') });
export const useStockItem = (id: string) =>
  useQuery({ queryKey: keys.stockItem(id), queryFn: () => api.get<{ item: StockItemDto; events: StockEventDto[] }>(`/api/stock/${id}`) });
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
export const useInbox = () => useQuery({ queryKey: keys.inbox, queryFn: () => api.get<NotificationListDto>('/api/notifications') });
export const useDevices = () => useQuery({ queryKey: keys.devices, queryFn: () => api.get<DeviceDto[]>('/api/devices') });
export const useRecipes = () => useQuery({ queryKey: keys.recipes, queryFn: () => api.get<RecipeSummaryDto[]>('/api/recipes') });
export const useRecipe = (id: string) => useQuery({ queryKey: keys.recipe(id), queryFn: () => api.get<RecipeDto>(`/api/recipes/${id}`) });
export const useCookPlan = (id: string, servings: number) =>
  useQuery({ queryKey: keys.cookPlan(id, servings), queryFn: () => api.get<CookPlanDto>(`/api/recipes/${id}/cook-plan?servings=${servings}`) });
export interface CookRow {
  id: string;
  recipeId: string | null;
  title: string | null;
  servings: number;
  createdAt: string;
  undoneAt: string | null;
}
export const useCooks = () => useQuery({ queryKey: keys.cooks, queryFn: () => api.get<CookRow[]>('/api/cooks') });
export const usePlan = (from: string, to: string, person = 'me') =>
  useQuery({ queryKey: keys.plan(from, to, person), queryFn: () => api.get<PlanDto>(`/api/plan?from=${from}&to=${to}&person=${encodeURIComponent(person)}`) });
export const useEarmarks = () => useQuery({ queryKey: keys.earmarks, queryFn: () => api.get<EarmarkDto[]>('/api/plan/earmarks') });
export const useShopping = () => useQuery({ queryKey: keys.shopping, queryFn: () => api.get<ShoppingItemDto[]>('/api/shopping') });
export const useRunningLow = () => useQuery({ queryKey: keys.runningLow, queryFn: () => api.get<RunningLowDto[]>('/api/running-low') });
export const useReceipts = () => useQuery({ queryKey: keys.receipts, queryFn: () => api.get<ReceiptSummaryDto[]>('/api/receipts') });
export const useReceipt = (id: string) =>
  useQuery({
    queryKey: keys.receipt(id),
    queryFn: () => api.get<ReceiptDto>(`/api/receipts/${id}`),
    // While AI is reading it, check every couple of seconds.
    refetchInterval: (q) => (q.state.data?.status === 'reading' ? 2000 : false),
  });
export const useRecipeScores = () =>
  useQuery({ queryKey: keys.recipeScores, queryFn: () => api.get<{ on: string; scores: RecipeScore[] }>('/api/optimiser/recipes') });
export interface SurplusHint {
  ingredientId: string;
  name: string;
  grams: number;
  goesOffBy: string | null;
  ideas: number;
  topIdea: { recipeId: string; title: string; missing: string[] } | null;
}
export const useSurplus = () => useQuery({ queryKey: keys.surplus, queryFn: () => api.get<SurplusHint[]>('/api/optimiser/surplus') });

export const useCalories = (person: string) =>
  useQuery({ queryKey: ['plan', 'calories', person], queryFn: () => api.get<CalorieStatsDto>(`/api/stats/calories?person=${encodeURIComponent(person)}`) });
export const useWasteReport = (period: StatsPeriod) =>
  useQuery({ queryKey: ['stock', 'waste-report', period], queryFn: () => api.get<WasteReportDto>(`/api/stats/waste-report?period=${period}`) });
/** null while pricing is off. Receipts change it, and confirming one refreshes 'stock'. */
export const useSpending = (period: StatsPeriod) =>
  useQuery({ queryKey: ['stock', 'spending', period], queryFn: () => api.get<SpendingDto | null>(`/api/stats/spending?period=${period}`) });
