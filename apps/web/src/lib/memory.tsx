import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type SetStateAction,
} from "react";
type Store = { values: Map<string, unknown>; listeners: Set<() => void> };
const Context = createContext<Store | null>(null);
/** Lives exactly as long as the authenticated session subtree. Never uses device storage. */
export function MemoryProvider({ children }: { children: ReactNode }) {
  const store = useRef<Store>({ values: new Map(), listeners: new Set() });
  return <Context value={store.current}>{children}</Context>;
}
export function useMemorySlot<T>(key: string, initial: T) {
  const store = useContext(Context);
  if (!store) throw new Error("Session memory unavailable.");
  if (!store.values.has(key)) store.values.set(key, initial);
  const value = useSyncExternalStore(
    (callback) => {
      store.listeners.add(callback);
      return () => {
        store.listeners.delete(callback);
      };
    },
    () => store.values.get(key) as T,
  );
  const set = (next: SetStateAction<T>) => {
    store.values.set(
      key,
      typeof next === "function"
        ? (next as (previous: T) => T)(store.values.get(key) as T)
        : next,
    );
    store.listeners.forEach((callback) => callback());
  };
  return [value, set] as const;
}
