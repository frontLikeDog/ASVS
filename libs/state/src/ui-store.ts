import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { newId } from '@asvs/mock-services';

export type ThemeMode = 'dark' | 'light';
export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  actionLabel?: string;
  actionHref?: string;
}

export interface UiState {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  lastProjectId?: string;
  demoNoticeDismissed: boolean;
  commandOpen: boolean;
  shortcutsOpen: boolean;
  toasts: Toast[];
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLastProjectId: (projectId: string) => void;
  dismissDemoNotice: () => void;
  setCommandOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => string;
  dismissToast: (id: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',
      sidebarCollapsed: false,
      lastProjectId: undefined,
      demoNoticeDismissed: false,
      commandOpen: false,
      shortcutsOpen: false,
      toasts: [],
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setLastProjectId: (lastProjectId) => set({ lastProjectId }),
      dismissDemoNotice: () => set({ demoNoticeDismissed: true }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      pushToast: (toast) => {
        const id = newId('toast');
        set((state) => ({ toasts: [...state.toasts, { ...toast, id }].slice(-4) }));
        return id;
      },
      dismissToast: (id) =>
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
    }),
    {
      name: 'asvs.ui.v1',
      version: 1,
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        lastProjectId: state.lastProjectId,
        demoNoticeDismissed: state.demoNoticeDismissed,
      }),
    },
  ),
);
