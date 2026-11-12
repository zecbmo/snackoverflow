import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque';
import './index.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/Layout';
import { StockActionsProvider } from './components/StockActions';
import { TOAST_EVENT, ToastProvider } from './components/Toast';
import { initNative } from './lib/native';
import { ApiError } from './lib/api';
import { InvitePage, LoginPage, SetupPage } from './pages/Auth';
import { ConnectPage } from './pages/Connect';
import { CookPage } from './pages/Cook';
import { MealsPage } from './pages/Meals';
import { RecipeDetailPage } from './pages/RecipeDetail';
import { RecipeEditPage, RecipeNewPage } from './pages/RecipeEditor';
import { RecipeImportPage } from './pages/RecipeImport';
import { RecipesPage } from './pages/Recipes';
import { PlannerPage } from './pages/Planner';
import { ShoppingPage } from './pages/Shopping';
import { InboxPage } from './pages/Inbox';
import { isNative } from './lib/platform';
import { ComingSoonPage } from './pages/ComingSoon';
import { IngredientsPage } from './pages/Ingredients';
import { ItemDetailPage } from './pages/ItemDetail';
import { LocationsPage } from './pages/Locations';
import { NotificationsPage } from './pages/Notifications';
import { PeoplePage } from './pages/People';
import { ProductDetailPage } from './pages/ProductDetail';
import { ProductsPage } from './pages/Products';
import { ProfilePage } from './pages/Profile';
import { ScanPage } from './pages/Scan';
import { SettingsPage } from './pages/Settings';
import { StockPage } from './pages/Stock';
import { TodayPage } from './pages/Today';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

const router = createBrowserRouter([
  { path: '/connect', element: <ConnectPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/setup', element: <SetupPage /> },
  { path: '/invite/:token', element: <InvitePage /> },
  {
    element: <AppShell bare />,
    children: [{ path: '/scan', element: <ScanPage /> }],
  },
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <TodayPage /> },
      { path: '/stock', element: <StockPage /> },
      { path: '/stock/:id', element: <ItemDetailPage /> },
      { path: '/inbox', element: <InboxPage /> },
      { path: '/recipes', element: <RecipesPage /> },
      { path: '/recipes/new', element: <RecipeNewPage /> },
      { path: '/recipes/import', element: <RecipeImportPage /> },
      { path: '/recipes/:id', element: <RecipeDetailPage /> },
      { path: '/recipes/:id/edit', element: <RecipeEditPage /> },
      { path: '/recipes/:id/cook', element: <CookPage /> },
      { path: '/meals', element: <MealsPage /> },
      { path: '/plan', element: <PlannerPage /> },
      { path: '/shop', element: <ShoppingPage /> },
      { path: '/products', element: <ProductsPage /> },
      { path: '/products/:id', element: <ProductDetailPage /> },
      { path: '/ingredients', element: <IngredientsPage /> },
      { path: '/locations', element: <LocationsPage /> },
      { path: '/people', element: <PeoplePage /> },
      { path: '/notifications', element: <NotificationsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/profile', element: <ProfilePage /> },
      { path: '*', element: <ComingSoonPage title="Not found" phase="There's nothing here." /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <StockActionsProvider>
          <RouterProvider router={router} />
        </StockActionsProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Android app: sign-in links and notification taps/buttons (no-op in the browser).
void initNative(
  queryClient,
  (to) => void router.navigate(to),
  (msg) => window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: msg })),
);

// The Android app bundles its files, so it doesn't need the service worker.
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNative()) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
