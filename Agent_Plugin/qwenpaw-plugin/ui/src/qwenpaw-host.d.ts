// Type declarations for the QwenPaw console host API.
// Mirrors `window.QwenPaw` as documented in the plugin development guide.

declare global {
  interface QwenPawHost {
    React: typeof import("react");
    ReactDOM: typeof import("react-dom");
    antd: any;
    antdIcons: any;
    apiBaseUrl: string;
    getApiUrl(path: string): string;
    getApiToken(): string | null;
    useTheme(): "light" | "dark";
    useLocale(): "zh" | "en";
    useSelectedAgent(): { id: string };
    useCurrentSession(): { id: string } | null;
    getSelectedAgentId(): string | null;
    getCurrentSessionId(): string | null;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  }

  interface QwenPawNamespace {
    host: QwenPawHost;
    registerRoutes?: (
      pluginId: string,
      routes: Array<{
        path: string;
        component: React.ComponentType;
        label: string;
        icon?: string;
        priority?: number;
      }>,
    ) => void;
  }

  interface Window {
    QwenPaw: QwenPawNamespace;
  }
}

export {};
