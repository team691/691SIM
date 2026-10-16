declare module 'react' {
  export type ReactNode = any;
  export type ReactElement = any;

  export type ChangeEvent<T = HTMLInputElement> = {
    target: T & { value: string; files?: FileList | null };
  };

  export type PointerEvent<T = Element> = globalThis.PointerEvent & {
    currentTarget: T;
  };

  export type RefObject<T> = { current: T | null };

  export function useState<T>(
    initialState: T | (() => T),
  ): [T, (value: T | ((prev: T) => T)) => void];
  export function useRef<T>(
    initialValue: T | null,
  ): { current: T | null };
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: any[]) => any>(
    callback: T,
    deps: readonly unknown[],
  ): T;
  export function useEffect(
    effect: () => void | (() => void),
    deps?: readonly unknown[],
  ): void;

  export const StrictMode: (props: { children?: ReactNode }) => ReactElement | null;
}

declare module 'react-dom/client' {
  export function createRoot(container: Element | DocumentFragment): {
    render(children: any): void;
  };
}

declare module 'react/jsx-runtime' {
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
  export const Fragment: any;
}

declare module 'react/jsx-dev-runtime' {
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
  export const Fragment: any;
}

declare namespace JSX {
  interface Element {}
  interface ElementClass {
    render: any;
  }
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
