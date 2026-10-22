import { useEffect, useRef } from "react";

export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let disposed = false;

    const acquire = async () => {
      if (
        disposed ||
        !active ||
        document.visibilityState !== "visible" ||
        !("wakeLock" in navigator) ||
        (sentinelRef.current && !sentinelRef.current.released)
      ) {
        return;
      }
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (disposed || !active) {
          await sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
      } catch {
        // Low-power modes, older webviews, and user settings may deny wake locks.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
    };
  }, [active]);
}
